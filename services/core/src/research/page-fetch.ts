import { createHash } from "node:crypto";
import {
  brotliDecompressSync,
  gunzipSync,
  inflateRawSync,
  inflateSync
} from "node:zlib";
import {
  parseTargetUrl,
  canonicalizeUrl,
  resolveValidatedTarget,
  TargetRefusedError,
  type AddressResolver
} from "./ssrf-guard";
import { extractPage, normalizeText } from "./html-extract";

/**
 * Retrieves a page on behalf of a researcher, under fixed limits.
 *
 * Every hop is re-validated: a redirect is a fresh target that a hostile server
 * can point anywhere, so it goes through exactly the same protocol and address
 * checks as the url the user typed. The connection is pinned to the address
 * that was validated (`AddressResolver` -> `PageRequest.address`), which closes
 * the DNS-rebinding window between "we checked" and "we connected".
 *
 * Credentials are never forwarded: the header set is constructed from scratch
 * for each request, so nothing the browser sent can be replayed and the server
 * cannot be turned into an authenticated proxy.
 *
 * All I/O goes through injected dependencies, so the whole policy — redirects,
 * caps, timeouts, content types — is testable without touching the network.
 */

export type FetchLimits = {
  /** Redirect hops followed before the retrieval is refused. */
  maxRedirects: number;
  /** Per-attempt socket timeout. */
  connectTimeoutMs: number;
  /** Wall-clock budget for the whole retrieval, redirects included. */
  totalTimeoutMs: number;
  /** Cap on bytes read off the socket, before decompression. */
  maxResponseBytes: number;
  /** Cap on bytes after decompression, so a compression bomb is bounded. */
  maxDecompressedBytes: number;
  /** Cap on extracted characters actually stored. */
  maxContentChars: number;
  /** Media types the importer will read. Everything else is refused. */
  allowedContentTypes: readonly string[];
  /** Retrievals allowed to run at once, so one session cannot flood a host. */
  maxConcurrentFetches: number;
};

export const DEFAULT_FETCH_LIMITS: FetchLimits = {
  maxRedirects: 5,
  connectTimeoutMs: 5_000,
  totalTimeoutMs: 15_000,
  maxResponseBytes: 2 * 1024 * 1024,
  maxDecompressedBytes: 6 * 1024 * 1024,
  maxContentChars: 200_000,
  allowedContentTypes: ["text/html", "application/xhtml+xml", "text/plain"],
  maxConcurrentFetches: 4
};

export class PageFetchError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message);
    this.name = "PageFetchError";
  }
}

export type PageRequest = {
  url: URL;
  /** The validated address. The transport must connect to exactly this one. */
  address: string;
  family: number;
  headers: Readonly<Record<string, string>>;
  /** Socket-level timeout for this attempt. */
  timeoutMs: number;
  signal: AbortSignal;
};

export type PageResponse = {
  status: number;
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  body: AsyncIterable<Uint8Array>;
  /** Releases the socket whether or not the body was consumed. */
  close(): void;
};

export type PageTransport = (request: PageRequest) => Promise<PageResponse>;

export type FetchedPage = {
  /** Url as requested, after normalization. */
  requestedUrl: string;
  /** Url the retrieval actually ended on. */
  finalUrl: string;
  /** Normalized form used to recognize a re-import of the same page. */
  canonicalUrl: string;
  status: number;
  contentType: string;
  contentEncoding: string | null;
  /** Extracted plain text. Untrusted data; stored and rendered as text only. */
  content: string;
  /** SHA-256 of the normalized text, so page drift is detectable. */
  contentHash: string;
  /** Bytes read off the socket, before decompression. */
  wireBytes: number;
  /** Bytes of the decoded body that the text was extracted from. */
  contentBytes: number;
  charCount: number;
  title: string | null;
  author: string | null;
  publisher: string | null;
  publishedAt: string | null;
  retrievedAt: string;
  redirects: string[];
  truncated: boolean;
};

export type PageFetchDependencies = {
  resolve: AddressResolver;
  transport: PageTransport;
  now?: () => Date;
  limits?: Partial<FetchLimits>;
};

function semaphore(limit: number) {
  let active = 0;
  const waiters: Array<() => void> = [];
  return {
    async acquire(): Promise<void> {
      if (active < limit) {
        active += 1;
        return;
      }
      await new Promise<void>((resolveWaiter) => waiters.push(resolveWaiter));
      active += 1;
    },
    release(): void {
      active -= 1;
      waiters.shift()?.();
    }
  };
}

function headerValue(
  headers: PageResponse["headers"],
  name: string
): string | null {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (raw === undefined) return null;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" ? value : null;
}

function mediaType(contentType: string): string {
  return (contentType.split(";")[0] ?? "").trim().toLowerCase();
}

/**
 * Reads a response body, refusing anything past the wire-size cap.
 *
 * The read is raced against the retrieval's abort signal: a server that accepts
 * the connection and then dribbles bytes forever must not be able to hold a
 * request open past the total budget.
 */
async function readBounded(
  response: PageResponse,
  maxBytes: number,
  signal?: AbortSignal
): Promise<{ body: Buffer; bytes: number }> {
  const chunks: Buffer[] = [];
  let total = 0;
  const timedOut = new PageFetchError("Retrieval timed out", "timeout");
  const abortRace: Promise<never> | null = signal
    ? new Promise<never>((_resolve, reject) => {
        if (signal.aborted) {
          reject(timedOut);
          return;
        }
        signal.addEventListener("abort", () => reject(timedOut), { once: true });
      })
    : null;
  // A rejection that lands after the read finished must not become unhandled.
  abortRace?.catch(() => undefined);

  const iterator = response.body[Symbol.asyncIterator]();
  try {
    for (;;) {
      const step = abortRace
        ? await Promise.race([iterator.next(), abortRace])
        : await iterator.next();
      if (step.done === true) break;
      const buffer = Buffer.from(step.value);
      total += buffer.byteLength;
      if (total > maxBytes) {
        throw new PageFetchError(
          `Response exceeded the ${maxBytes} byte limit`,
          "response-too-large"
        );
      }
      chunks.push(buffer);
    }
  } finally {
    response.close();
  }
  return { body: Buffer.concat(chunks), bytes: total };
}

function charsetOf(contentType: string): "utf8" | "latin1" {
  const match = /charset\s*=\s*"?([a-zA-Z0-9_-]+)"?/i.exec(contentType);
  const charset = match?.[1]?.toLowerCase() ?? "utf8";
  if (
    charset === "iso-8859-1" ||
    charset === "latin1" ||
    charset === "windows-1252" ||
    charset === "us-ascii"
  ) {
    return "latin1";
  }
  return "utf8";
}

export function contentHashOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Creates a page fetcher.
 *
 * The concurrency gate belongs to the instance, not to each call: a per-call
 * gate would enforce nothing at all, since every call would get its own empty
 * allowance. One fetcher means at most `maxConcurrentFetches` retrievals in
 * flight no matter how many sessions ask at once.
 */
export function createPageFetcher(dependencies: PageFetchDependencies): {
  fetch: (input: string) => Promise<FetchedPage>;
} {
  const limits: FetchLimits = {
    ...DEFAULT_FETCH_LIMITS,
    ...dependencies.limits
  };
  const now = dependencies.now ?? ((): Date => new Date());
  const gate = semaphore(limits.maxConcurrentFetches);
  const transportOf = {
    resolve: dependencies.resolve,
    transport: dependencies.transport
  };

  return {
    fetch: (input: string) => runFetch(input, transportOf, limits, now, gate)
  };
}

/**
 * Retrieves and normalizes one page under the supplied limits.
 *
 * The returned `content` is plain text, and `contentHash` is taken over the
 * normalized text rather than the raw markup: a whitespace-only change to the
 * page template is not a new version of the page, but a changed sentence is.
 */
async function runFetch(
  input: string,
  transportOf: Pick<PageFetchDependencies, "resolve" | "transport">,
  limits: FetchLimits,
  now: () => Date,
  gate: { acquire: () => Promise<void>; release: () => void }
): Promise<FetchedPage> {
  const requested = parseTargetUrl(input);
  const requestedUrl = canonicalizeUrl(requested);
  const deadline = Date.now() + limits.totalTimeoutMs;
  const redirects: string[] = [];
  const visited = new Set<string>([requestedUrl]);

  await gate.acquire();
  try {
    let current = requested;

    for (let hop = 0; hop <= limits.maxRedirects; hop += 1) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new PageFetchError(
          "Retrieval exceeded its total time budget",
          "timeout"
        );
      }

      // Re-resolved on every hop: a redirect target is a brand new address and
      // must clear exactly the same checks as the url the user typed.
      const target = await resolveValidatedTarget(current, transportOf.resolve);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), remaining);
      let response: PageResponse;
      let collected: { body: Buffer; bytes: number };
      let status: number;
      try {
        response = await transportOf.transport({
          url: current,
          address: target.address,
          family: target.family,
          headers: SAFE_HEADERS,
          timeoutMs: Math.min(limits.connectTimeoutMs, Math.max(remaining, 1)),
          signal: controller.signal
        });
        status = response.status;
        const location = headerValue(response.headers, "location");
        const isRedirect = status >= 300 && status < 400 && status !== 304;

        if (isRedirect && location) {
          // Drain and release before following, so the socket is not leaked.
          await readBounded(
            response,
            limits.maxResponseBytes,
            controller.signal
          ).catch(() => undefined);
          if (hop === limits.maxRedirects) {
            throw new PageFetchError(
              `Refused after ${limits.maxRedirects} redirects`,
              "too-many-redirects"
            );
          }
          let next: URL;
          try {
            next = new URL(location, current);
          } catch {
            throw new PageFetchError(
              `Redirect pointed at an unparseable location`,
              "invalid-redirect"
            );
          }
          const nextCanonical = canonicalizeUrl(next);
          if (visited.has(nextCanonical)) {
            throw new PageFetchError(
              "Redirect loop detected",
              "too-many-redirects"
            );
          }
          visited.add(nextCanonical);
          redirects.push(nextCanonical);
          // Protocol is re-checked here; the address check happens at the top
          // of the next iteration.
          current = parseTargetUrl(next.toString());
          continue;
        }

        collected = await readBounded(
          response,
          limits.maxResponseBytes,
          controller.signal
        );
      } catch (cause) {
        if (cause instanceof PageFetchError) throw cause;
        if (cause instanceof TargetRefusedError) throw cause;
        if (controller.signal.aborted) {
          throw new PageFetchError(
            "Retrieval timed out",
            "timeout"
          );
        }
        throw new PageFetchError(
          `Could not read the page: ${
            cause instanceof Error ? cause.message : "unknown transport error"
          }`,
          "transport"
        );
      } finally {
        clearTimeout(timer);
      }

      if (status < 200 || status >= 300) {
        throw new PageFetchError(
          `The page answered with status ${status}`,
          "bad-status"
        );
      }

      const contentType = headerValue(response.headers, "content-type") ?? "";
      const type = mediaType(contentType);
      if (type.length === 0) {
        throw new PageFetchError(
          "The page did not declare a content type",
          "unsupported-content-type"
        );
      }
      if (!limits.allowedContentTypes.includes(type)) {
        throw new PageFetchError(
          `Only text pages can be imported (got ${type})`,
          "unsupported-content-type"
        );
      }

      const decoded = decodeBounded(
        collected.body,
        headerValue(response.headers, "content-encoding"),
        limits.maxDecompressedBytes
      );

      const text = decoded.toString(charsetOf(contentType)).replace(/^\uFEFF/, "");
      const extracted = extractPage({
        body: text,
        contentType: type,
        maxChars: limits.maxContentChars
      });

      if (normalizeText(extracted.text).length === 0) {
        throw new PageFetchError(
          "The page contained no readable text",
          "no-content"
        );
      }

      const normalized = normalizeText(extracted.text);
      const finalUrl = canonicalizeUrl(current);
      return {
        requestedUrl,
        finalUrl,
        canonicalUrl: finalUrl,
        status,
        contentType: type,
        contentEncoding: headerValue(response.headers, "content-encoding"),
        content: normalized,
        contentHash: contentHashOf(normalized),
        wireBytes: collected.bytes,
        contentBytes: decoded.byteLength,
        charCount: normalized.length,
        title: extracted.title,
        author: extracted.author,
        publisher: extracted.publisher,
        publishedAt: extracted.publishedAt,
        retrievedAt: now().toISOString(),
        redirects,
        truncated: extracted.truncated
      };
    }

    throw new PageFetchError(
      `Refused after ${limits.maxRedirects} redirects`,
      "too-many-redirects"
    );
  } finally {
    gate.release();
  }
}

/**
 * Headers sent on every request.
 *
 * Built from scratch, never copied from the caller: no cookie, no authorization,
 * no referer. That is what stops the importer from being usable as an
 * authenticated proxy against something the researcher happens to be signed in
 * to. `identity` is *not* requested, so a server that compresses is handled by
 * the bounded decompressor instead of being refused outright.
 */
export const SAFE_HEADERS: Readonly<Record<string, string>> = {
  accept: "text/html,application/xhtml+xml,text/plain;q=0.9",
  "accept-encoding": "gzip, deflate, br",
  "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
  "user-agent": "NexusResearchBot/1.0 (evidence intake; text only)"
};

/**
 * Decompresses a body under a hard output cap.
 *
 * A small compressed payload can expand to gigabytes, so the cap is enforced by
 * zlib itself rather than by measuring the result afterwards.
 */
export function decodeBounded(
  body: Buffer,
  contentEncoding: string | null,
  maxBytes: number
): Buffer {
  const encoding = (contentEncoding ?? "identity").trim().toLowerCase();
  if (encoding === "" || encoding === "identity") return body;

  const options = { maxOutputLength: maxBytes };
  const fail = (cause: unknown): never => {
    const code =
      typeof cause === "object" && cause !== null
        ? (cause as { code?: unknown }).code
        : undefined;
    const message = cause instanceof Error ? cause.message : "";
    // zlib reports the cap as ERR_BUFFER_TOO_LARGE ("Cannot create a Buffer
    // larger than N bytes"); matching on the code keeps the cap detection
    // independent of the exact wording.
    if (code === "ERR_BUFFER_TOO_LARGE" || /larger than|maxOutputLength/i.test(message)) {
      throw new PageFetchError(
        `Decompressed body exceeded the ${maxBytes} byte limit`,
        "response-too-large"
      );
    }
    throw new PageFetchError(
      "The page used an unsupported content encoding",
      "unsupported-encoding"
    );
  };

  try {
    if (encoding === "gzip" || encoding === "x-gzip") {
      return gunzipSync(body, options);
    }
    if (encoding === "deflate") {
      try {
        return inflateSync(body, options);
      } catch {
        return inflateRawSync(body, options);
      }
    }
    if (encoding === "br") {
      return brotliDecompressSync(body, options);
    }
  } catch (cause) {
    return fail(cause);
  }
  return fail(new Error(`unsupported encoding ${encoding}`));
}
