import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  createPageFetcher,
  decodeBounded,
  PageFetchError,
  SAFE_HEADERS,
  type PageFetchDependencies,
  type PageRequest,
  type PageResponse,
  type PageTransport
} from "./page-fetch";
import type { AddressResolver } from "./ssrf-guard";

/**
 * Retrieval orchestration: redirects, caps, timeouts and content types.
 *
 * The transport is a double here on purpose. The address policy — the part that
 * decides whether a socket may be opened at all — is proved exhaustively in
 * `ssrf-guard.test.ts`, and the byte/decompression logic runs against the real
 * zlib through `decodeBounded`. What is left to prove is the loop around them:
 * that a redirect is re-validated rather than trusted, that every cap holds,
 * and that no caller-supplied header is ever forwarded.
 *
 * No test here opens a network socket, and none asserts anything about a real
 * remote host.
 */

const encoder = new TextEncoder();

/** Public, routable-looking test addresses (never the documentation blocks). */
const PUBLIC_PRIMARY = "93.184.216.34";
const PUBLIC_SECONDARY = "8.8.8.8";

const pageHtml = `<!doctype html>
<html><head>
  <title>Population report 2025</title>
  <meta name="author" content="Statistics Office">
  <meta property="og:site_name" content="National Bureau of Statistics">
  <meta property="article:published_time" content="2025-03-04T08:00:00Z">
  <script>window.tracker = "must not appear";</script>
  <style>.hidden { display: none }</style>
</head><body>
  <h1>Population report 2025</h1>
  <p>First paragraph with &amp; an entity and &nbsp; spaces.</p>
  <p>Second paragraph continues the report.</p>
  <noscript>enable javascript</noscript>
</body></html>`;

const html = (body: string): Uint8Array => encoder.encode(body);

type FakeReply = {
  status?: number;
  headers?: Record<string, string>;
  chunks?: Uint8Array[];
  /** Body never completes until the request is aborted. */
  hang?: boolean;
};

function fakeTransport(handler: (request: PageRequest) => FakeReply): {
  transport: PageTransport;
  requests: PageRequest[];
  peakConcurrency: () => number;
} {
  const requests: PageRequest[] = [];
  let active = 0;
  let peak = 0;

  const transport: PageTransport = async (request) => {
    requests.push(request);
    const reply = handler(request);
    const chunks = reply.chunks ?? [];
    let closed = false;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      active -= 1;
    };
    active += 1;
    peak = Math.max(peak, active);

    const body: AsyncIterable<Uint8Array> = {
      async *[Symbol.asyncIterator]() {
        try {
          for (const chunk of chunks) {
            if (closed) return;
            yield chunk;
          }
          if (reply.hang === true) {
            await new Promise<void>((resolveHang) => {
              if (request.signal.aborted) {
                resolveHang();
                return;
              }
              request.signal.addEventListener("abort", () => resolveHang(), {
                once: true
              });
            });
          }
        } finally {
          release();
        }
      }
    };

    return {
      status: reply.status ?? 200,
      headers: reply.headers ?? { "content-type": "text/html; charset=utf-8" },
      body,
      close: () => {
        closed = true;
        release();
      }
    } satisfies PageResponse;
  };

  return { transport, requests, peakConcurrency: () => peak };
}

/** Resolves a hostname to a fixed address, and refuses unknown names. */
const resolverFor = (map: Record<string, string>): AddressResolver => {
  return async (hostname) => {
    const address = map[hostname];
    if (address === undefined) throw new Error(`no fake address for ${hostname}`);
    return [{ address, family: address.includes(":") ? 6 : 4 }];
  };
};

/** Every hostname resolves to one public address. */
const publicResolver: AddressResolver = async (hostname) => [
  { address: PUBLIC_PRIMARY, family: hostname === "v6.test" ? 6 : 4 }
];

/**
 * One retrieval with a throwaway fetcher.
 *
 * The concurrency gate belongs to the fetcher instance, so a fresh one per call
 * is the right default for behavioural tests and the wrong one for the
 * concurrency test, which builds its own shared fetcher.
 */
function fetchOne(
  input: string,
  dependencies: PageFetchDependencies
): Promise<Awaited<ReturnType<ReturnType<typeof createPageFetcher>["fetch"]>>> {
  return createPageFetcher(dependencies).fetch(input);
}

describe("successful retrieval", () => {
  it("extracts text and citation metadata, and hashes the text", async () => {
    const { transport } = fakeTransport(() => ({ chunks: [html(pageHtml)] }));
    const page = await fetchOne("https://example.test/report", {
      resolve: publicResolver,
      transport,
      now: () => new Date("2026-10-10T00:00:00Z")
    });

    expect(page.title).toBe("Population report 2025");
    expect(page.author).toBe("Statistics Office");
    expect(page.publisher).toBe("National Bureau of Statistics");
    expect(page.publishedAt).toBe("2025-03-04T08:00:00.000Z");
    expect(page.contentType).toBe("text/html");
    expect(page.retrievedAt).toBe("2026-10-10T00:00:00.000Z");
    expect(page.redirects).toEqual([]);
    expect(page.truncated).toBe(false);
    expect(page.canonicalUrl).toBe("https://example.test/report");

    // Script and style bodies are never part of the text.
    expect(page.content).not.toContain("must not appear");
    expect(page.content).not.toContain("display: none");
    expect(page.content).not.toContain("enable javascript");
    // Entities are decoded and paragraph structure survives.
    expect(page.content).toContain("First paragraph with & an entity and spaces.");
    expect(page.content).toContain("Second paragraph continues the report.");
    expect(page.content).toContain("\n\n");

    expect(page.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(page.charCount).toBe(page.content.length);
  });

  it("connects to the address that was validated, not to the name", async () => {
    const { transport, requests } = fakeTransport(() => ({
      chunks: [html(pageHtml)]
    }));
    await fetchOne("https://example.test/report", {
      resolve: resolverFor({ "example.test": PUBLIC_PRIMARY }),
      transport
    });
    expect(requests[0]?.address).toBe(PUBLIC_PRIMARY);
    expect(requests[0]?.family).toBe(4);

    // A resolver answering inside a reserved block is refused outright: the
    // answer is what is judged, not the hostname that produced it.
    const refused = fakeTransport(() => ({ chunks: [html(pageHtml)] }));
    await expect(
      fetchOne("https://looks-public.test/report", {
        resolve: resolverFor({ "looks-public.test": "203.0.113.9" }),
        transport: refused.transport
      })
    ).rejects.toThrow(/documentation address/);
    expect(refused.requests).toHaveLength(0);
  });

  it("normalizes the url so the same page is recognized on re-import", async () => {
    const first = fakeTransport(() => ({ chunks: [html(pageHtml)] }));
    const a = await fetchOne("https://Example.test:443/report#section-2", {
      resolve: publicResolver,
      transport: first.transport
    });
    const second = fakeTransport(() => ({ chunks: [html(pageHtml)] }));
    const b = await fetchOne("https://example.test/report", {
      resolve: publicResolver,
      transport: second.transport
    });

    expect(a.canonicalUrl).toBe("https://example.test/report");
    expect(b.canonicalUrl).toBe(a.canonicalUrl);
    // Identical text means an identical hash, which is what makes a repeated
    // import a no-op instead of a second snapshot.
    expect(b.contentHash).toBe(a.contentHash);
  });

  it("changes the hash when the readable text changes", async () => {
    const before = fakeTransport(() => ({ chunks: [html(pageHtml)] }));
    const a = await fetchOne("https://example.test/report", {
      resolve: publicResolver,
      transport: before.transport
    });
    const changed = pageHtml.replace("Second paragraph", "Revised paragraph");
    const after = fakeTransport(() => ({ chunks: [html(changed)] }));
    const b = await fetchOne("https://example.test/report", {
      resolve: publicResolver,
      transport: after.transport
    });
    expect(b.contentHash).not.toBe(a.contentHash);
  });

  it("imports text/plain verbatim and honours a declared charset", async () => {
    const plain = fakeTransport(() => ({
      headers: { "content-type": "text/plain; charset=utf-8" },
      chunks: [encoder.encode("line one\n\nline two")]
    }));
    const page = await fetchOne("https://example.test/notes.txt", {
      resolve: publicResolver,
      transport: plain.transport
    });
    expect(page.content).toBe("line one\n\nline two");

    const latin = fakeTransport(() => ({
      headers: { "content-type": "text/plain; charset=iso-8859-1" },
      chunks: [Buffer.from([0x63, 0x61, 0x66, 0xe9])]
    }));
    const latinPage = await fetchOne("https://example.test/latin.txt", {
      resolve: publicResolver,
      transport: latin.transport
    });
    expect(latinPage.content).toBe("café");
  });

  it("records truncation instead of silently dropping text", async () => {
    const long = `<html><body><p>${"字".repeat(500)}</p></body></html>`;
    const { transport } = fakeTransport(() => ({ chunks: [html(long)] }));
    const page = await fetchOne("https://example.test/long", {
      resolve: publicResolver,
      transport,
      limits: { maxContentChars: 100 }
    });
    expect(page.truncated).toBe(true);
    expect(page.charCount).toBe(100);
  });
});

describe("redirect handling", () => {
  it("follows a redirect to another public host and reports the final url", async () => {
    const { transport, requests } = fakeTransport((request) =>
      request.url.hostname === "start.test"
        ? {
            status: 302,
            headers: { location: "https://final.test/article" },
            chunks: []
          }
        : { chunks: [html(pageHtml)] }
    );
    const page = await fetchOne("https://start.test/a", {
      resolve: resolverFor({
        "start.test": PUBLIC_PRIMARY,
        "final.test": PUBLIC_SECONDARY
      }),
      transport
    });

    expect(page.redirects).toEqual(["https://final.test/article"]);
    expect(page.finalUrl).toBe("https://final.test/article");
    expect(page.canonicalUrl).toBe("https://final.test/article");
    expect(requests).toHaveLength(2);
    expect(requests[1]?.address).toBe(PUBLIC_SECONDARY);
  });

  it("refuses a redirect whose new host resolves into a reserved block", async () => {
    const { transport, requests } = fakeTransport(() => ({
      status: 302,
      headers: { location: "https://internal.test/secret" },
      chunks: []
    }));
    await expect(
      fetchOne("https://start.test/a", {
        resolve: resolverFor({
          "start.test": PUBLIC_PRIMARY,
          "internal.test": "10.1.2.3"
        }),
        transport
      })
    ).rejects.toThrow(/private address/);
    // Refused before a second connection is opened.
    expect(requests).toHaveLength(1);
  });

  it("refuses a redirect that points at a metadata address", async () => {
    const { transport, requests } = fakeTransport(() => ({
      status: 302,
      headers: { location: "http://169.254.169.254/latest/meta-data/" },
      chunks: []
    }));
    await expect(
      fetchOne("https://start.test/a", {
        resolve: publicResolver,
        transport
      })
    ).rejects.toThrow(/link-local address/);
    expect(requests).toHaveLength(1);
  });

  it("refuses a redirect that downgrades to a non-http protocol", async () => {
    const { transport } = fakeTransport(() => ({
      status: 302,
      headers: { location: "file:///etc/passwd" },
      chunks: []
    }));
    await expect(
      fetchOne("https://start.test/a", {
        resolve: publicResolver,
        transport
      })
    ).rejects.toThrow(/Only http and https/);
  });

  it("refuses a redirect loop", async () => {
    const { transport } = fakeTransport((request) => ({
      status: 302,
      headers: { location: request.url.toString() },
      chunks: []
    }));
    await expect(
      fetchOne("https://start.test/a", {
        resolve: publicResolver,
        transport
      })
    ).rejects.toThrow(/Redirect loop detected/);
  });

  it("refuses a chain longer than the hop budget", async () => {
    let hop = 0;
    const { transport, requests } = fakeTransport(() => {
      hop += 1;
      return {
        status: 302,
        headers: { location: `https://start.test/hop-${hop}` },
        chunks: []
      };
    });
    await expect(
      fetchOne("https://start.test/a", {
        resolve: publicResolver,
        transport,
        limits: { maxRedirects: 3 }
      })
    ).rejects.toThrow(/Refused after 3 redirects/);
    expect(requests).toHaveLength(4);
  });
});

describe("retrieval limits", () => {
  it("refuses a body past the wire-size cap", async () => {
    const big = new Uint8Array(4096).fill(65);
    const { transport } = fakeTransport(() => ({ chunks: [big, big, big] }));
    await expect(
      fetchOne("https://example.test/big", {
        resolve: publicResolver,
        transport,
        limits: { maxResponseBytes: 8192 }
      })
    ).rejects.toThrow(/exceeded the 8192 byte limit/);
  });

  it("bounds a compression bomb by the decompressed-size cap", async () => {
    const bomb = gzipSync(
      Buffer.from(`<html><body><p>${"a".repeat(8_000_000)}</p></body></html>`)
    );
    // A few kilobytes on the wire, tens of megabytes once expanded.
    expect(bomb.byteLength).toBeLessThan(64 * 1024);
    const { transport } = fakeTransport(() => ({
      headers: { "content-type": "text/html", "content-encoding": "gzip" },
      chunks: [bomb]
    }));
    await expect(
      fetchOne("https://example.test/bomb", {
        resolve: publicResolver,
        transport,
        limits: { maxDecompressedBytes: 100_000 }
      })
    ).rejects.toThrow(/Decompressed body exceeded/);
  });

  it("decompresses a normal gzip response", async () => {
    const wrapped = gzipSync(Buffer.from(pageHtml));
    const { transport } = fakeTransport(() => ({
      headers: { "content-type": "text/html", "content-encoding": "gzip" },
      chunks: [wrapped]
    }));
    const page = await fetchOne("https://example.test/gz", {
      resolve: publicResolver,
      transport
    });
    expect(page.content).toContain("Population report 2025");
    expect(page.contentEncoding).toBe("gzip");
  });

  it("times out a body that never completes", async () => {
    const { transport } = fakeTransport(() => ({
      headers: { "content-type": "text/html" },
      hang: true
    }));
    await expect(
      fetchOne("https://example.test/slow", {
        resolve: publicResolver,
        transport,
        limits: { totalTimeoutMs: 40, connectTimeoutMs: 40 }
      })
    ).rejects.toThrow(/timed out/);
  });

  it("refuses an unsupported content type", async () => {
    const pdf = fakeTransport(() => ({
      headers: { "content-type": "application/pdf" },
      chunks: [encoder.encode("%PDF-1.7")]
    }));
    await expect(
      fetchOne("https://example.test/paper.pdf", {
        resolve: publicResolver,
        transport: pdf.transport
      })
    ).rejects.toThrow(/Only text pages can be imported/);
  });

  it("refuses a response that declares no content type", async () => {
    const none = fakeTransport(() => ({ headers: {}, chunks: [html(pageHtml)] }));
    await expect(
      fetchOne("https://example.test/unknown", {
        resolve: publicResolver,
        transport: none.transport
      })
    ).rejects.toThrow(/did not declare a content type/);
  });

  it("refuses a page with no readable text", async () => {
    const empty = fakeTransport(() => ({
      chunks: [
        html(
          "<html><head><style>a{}</style></head><body><script>x()</script></body></html>"
        )
      ]
    }));
    await expect(
      fetchOne("https://example.test/empty", {
        resolve: publicResolver,
        transport: empty.transport
      })
    ).rejects.toThrow(/no readable text/);
  });

  it("refuses a non-2xx answer", async () => {
    const missing = fakeTransport(() => ({ status: 404, chunks: [] }));
    await expect(
      fetchOne("https://example.test/missing", {
        resolve: publicResolver,
        transport: missing.transport
      })
    ).rejects.toThrow(/status 404/);
  });

  it("caps how many retrievals run at once", async () => {
    const { transport, peakConcurrency } = fakeTransport(() => ({
      chunks: [html(pageHtml)]
    }));
    const fetcher = createPageFetcher({
      resolve: publicResolver,
      transport,
      limits: { maxConcurrentFetches: 2 }
    });
    await Promise.all(
      Array.from({ length: 6 }, (_unused, index) =>
        fetcher.fetch(`https://example.test/page-${index}`)
      )
    );
    expect(peakConcurrency()).toBeLessThanOrEqual(2);
  });
});

describe("caller data is never forwarded", () => {
  it("sends only the fixed safe header set, unchanged across hops", async () => {
    const { transport, requests } = fakeTransport((request) =>
      request.url.hostname === "start.test"
        ? {
            status: 302,
            headers: { location: "https://final.test/a" },
            chunks: []
          }
        : { chunks: [html(pageHtml)] }
    );
    await fetchOne("https://start.test/a", {
      resolve: resolverFor({
        "start.test": PUBLIC_PRIMARY,
        "final.test": PUBLIC_SECONDARY
      }),
      transport
    });

    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.headers).toEqual(SAFE_HEADERS);
      const names = Object.keys(request.headers).map((name) =>
        name.toLowerCase()
      );
      for (const forbidden of [
        "cookie",
        "authorization",
        "proxy-authorization",
        "referer",
        "origin",
        "x-forwarded-for"
      ]) {
        expect(names, forbidden).not.toContain(forbidden);
      }
    }
    // A redirect must not inherit anything extra from the previous hop.
    expect(requests[0]?.headers).toEqual(requests[1]?.headers);
  });
});

describe("decodeBounded", () => {
  it("passes through identity and refuses unknown encodings", () => {
    const body = Buffer.from("plain");
    expect(decodeBounded(body, null, 1000)).toBe(body);
    expect(decodeBounded(body, "identity", 1000)).toBe(body);
    expect(() => decodeBounded(body, "snappy", 1000)).toThrow(PageFetchError);
  });

  it("enforces the cap on real compressed input", () => {
    const bomb = gzipSync(Buffer.alloc(1_000_000, 65));
    expect(() => decodeBounded(bomb, "gzip", 10_000)).toThrow(
      /Decompressed body exceeded/
    );
    expect(decodeBounded(bomb, "gzip", 2_000_000).byteLength).toBe(1_000_000);
  });
});
