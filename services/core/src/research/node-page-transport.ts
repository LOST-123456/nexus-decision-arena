import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import type { AddressResolver, ResolvedAddress } from "./ssrf-guard";
import type { PageRequest, PageResponse, PageTransport } from "./page-fetch";

/**
 * The real network transport for page retrieval.
 *
 * Two things matter here and nowhere else:
 *
 *  1. The socket is pinned to the address that was already validated. Node is
 *     given a `lookup` that ignores DNS and answers with the validated address,
 *     so the name cannot be re-resolved between the check and the connect. That
 *     is the whole DNS-rebinding defence: without it, a resolver answering
 *     `public` once and `127.0.0.1` a millisecond later would slip through.
 *  2. Nothing about the caller is forwarded. Connection reuse is off, TLS
 *     verification stays on, and the header set comes from `SAFE_HEADERS`.
 */

export const dnsAddressResolver: AddressResolver = async (
  hostname
): Promise<readonly ResolvedAddress[]> => {
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  return addresses.map((entry) => ({
    address: entry.address,
    family: entry.family
  }));
};

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | Array<{ address: string; family: number }>,
  family?: number
) => void;

function pinnedLookup(
  address: string,
  family: number
): NonNullable<http.RequestOptions["lookup"]> {
  const implementation = (
    _hostname: string,
    options: { all?: boolean },
    callback: LookupCallback
  ): void => {
    if (options?.all === true) {
      callback(null, [{ address, family }]);
      return;
    }
    callback(null, address, family);
  };
  // @types/node models the overloads of `lookup` more narrowly than the runtime
  // contract; the call above is the documented one.
  return implementation as unknown as NonNullable<http.RequestOptions["lookup"]>;
}

export function createNodePageTransport(): PageTransport {
  return async (request: PageRequest): Promise<PageResponse> => {
    const isHttps = request.url.protocol === "https:";
    const requestFn = isHttps ? https.request : http.request;

    return await new Promise<PageResponse>((resolveResponse, rejectResponse) => {
      const clientRequest = requestFn(
        {
          protocol: request.url.protocol,
          // The name is kept for the Host header and for TLS SNI; the address
          // actually dialled comes from `lookup` below.
          hostname: request.url.hostname,
          port:
            request.url.port !== ""
              ? Number(request.url.port)
              : isHttps
                ? 443
                : 80,
          path: `${request.url.pathname}${request.url.search}`,
          method: "GET",
          headers: request.headers,
          // One connection per request: a pooled socket could otherwise be
          // reused for a different host than the one that was validated.
          agent: false,
          // TLS verification is never relaxed.
          rejectUnauthorized: true,
          ...(isHttps ? { servername: request.url.hostname } : {}),
          lookup: pinnedLookup(request.address, request.family),
          signal: request.signal
        },
        (response) => {
          let closed = false;
          const close = (): void => {
            if (closed) return;
            closed = true;
            response.destroy();
            clientRequest.destroy();
          };
          resolveResponse({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: response,
            close
          });
        }
      );

      clientRequest.setTimeout(request.timeoutMs, () => {
        clientRequest.destroy(new Error("request timed out"));
      });
      clientRequest.on("error", (error) => {
        rejectResponse(
          request.signal.aborted ? new Error("retrieval aborted") : error
        );
      });
      clientRequest.end();
    });
  };
}
