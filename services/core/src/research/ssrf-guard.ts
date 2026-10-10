/**
 * Address-level guard for server-side page retrieval.
 *
 * The workspace lets a researcher hand the server a URL and have it read the
 * page. That turns the server into a proxy that an attacker can aim at anything
 * it can reach — localhost, private ranges, link-local metadata endpoints — so
 * every hop is validated before a socket is opened, and the connection is then
 * pinned to the exact address that was validated.
 *
 * Design rules, all fail-closed:
 *  - Only `http:`/`https:`. Anything else is refused before DNS runs.
 *  - A target is refused if *any* address it resolves to is unusable, not just
 *    the first one, so a host cannot smuggle a private answer in second.
 *  - IP literals are checked directly and never resolved.
 *  - IPv4-mapped, IPv4-translated and 6to4 forms are unwrapped and re-checked,
 *    otherwise `::ffff:127.0.0.1` would walk straight through.
 *  - An address that cannot be parsed is treated as blocked, never as public.
 *  - The validated address is returned to the caller, which must connect to
 *    *that* address; re-resolving would reopen the DNS-rebinding window.
 *
 * Nothing here performs I/O except the injected resolver, which is why the
 * whole policy can be tested without a network.
 */

/** Ranges that must never be reachable from a user-supplied URL. */
const BLOCKED_IPV4_RANGES: ReadonlyArray<readonly [string, number, string]> = [
  ["0.0.0.0", 8, "this-network address"],
  ["10.0.0.0", 8, "private address"],
  ["100.64.0.0", 10, "carrier-grade NAT address"],
  ["127.0.0.0", 8, "loopback address"],
  // Also covers the cloud instance-metadata endpoint 169.254.169.254.
  ["169.254.0.0", 16, "link-local address"],
  ["172.16.0.0", 12, "private address"],
  ["192.0.0.0", 24, "IETF protocol-assignment address"],
  ["192.0.2.0", 24, "documentation address"],
  ["192.88.99.0", 24, "6to4 relay anycast address"],
  ["192.168.0.0", 16, "private address"],
  ["198.18.0.0", 15, "benchmark address"],
  ["198.51.100.0", 24, "documentation address"],
  ["203.0.113.0", 24, "documentation address"],
  ["224.0.0.0", 4, "multicast address"],
  ["240.0.0.0", 4, "reserved address"]
];

/** Host names that must never be resolved, independent of what they answer. */
const BLOCKED_HOSTNAMES: ReadonlySet<string> = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "instance-data"
]);

/** Suffixes that only ever point at the machine or its immediate network. */
const BLOCKED_HOST_SUFFIXES: readonly string[] = [
  ".localhost",
  ".local",
  ".internal",
  ".home.arpa",
  ".in-addr.arpa",
  ".ip6.arpa"
];

export class TargetRefusedError extends Error {
  constructor(
    message: string,
    readonly reason: string
  ) {
    super(message);
    this.name = "TargetRefusedError";
  }
}

export function parseIPv4(input: string): number[] | null {
  const pieces = input.split(".");
  if (pieces.length !== 4) return null;
  const octets: number[] = [];
  for (const piece of pieces) {
    // Reject leading zeros and signs: `01.2.3.4` is not the same host to every
    // resolver, and agreeing on one reading is safer than guessing.
    if (!/^(0|[1-9][0-9]{0,2})$/.test(piece)) return null;
    const value = Number(piece);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

/** Returns the eight 16-bit groups of an IPv6 address, or null. */
export function parseIPv6(raw: string): number[] | null {
  let address = raw;
  const zone = address.indexOf("%");
  if (zone !== -1) address = address.slice(0, zone);
  if (address.startsWith("[") && address.endsWith("]")) {
    address = address.slice(1, -1);
  }
  if (address.length === 0 || !address.includes(":")) return null;

  // Fold a trailing dotted quad into two hex groups so the rest of the parser
  // only ever sees hex groups.
  const lastColon = address.lastIndexOf(":");
  const tail = address.slice(lastColon + 1);
  if (tail.includes(".")) {
    const embedded = parseIPv4(tail);
    if (!embedded) return null;
    const high = ((embedded[0]! << 8) | embedded[1]!).toString(16);
    const low = ((embedded[2]! << 8) | embedded[3]!).toString(16);
    address = `${address.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const halves = address.split("::");
  if (halves.length > 2) return null;

  const parseGroups = (segment: string): number[] | null => {
    if (segment === "") return [];
    const groups: number[] = [];
    for (const piece of segment.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null;
      groups.push(Number.parseInt(piece, 16));
    }
    return groups;
  };

  const head = parseGroups(halves[0] ?? "");
  if (!head) return null;

  if (halves.length === 1) {
    return head.length === 8 ? head : null;
  }

  const tailGroups = parseGroups(halves[1] ?? "");
  if (!tailGroups) return null;
  const explicit = head.length + tailGroups.length;
  // `::` must stand for at least one group.
  if (explicit > 7) return null;
  return [...head, ...new Array<number>(8 - explicit).fill(0), ...tailGroups];
}

function inIpv4Range(octets: readonly number[], base: string, prefix: number): boolean {
  const baseOctets = parseIPv4(base);
  if (!baseOctets) return false;
  const mask =
    prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const value =
    (((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>>
      0);
  const baseValue =
    (((baseOctets[0]! << 24) |
      (baseOctets[1]! << 16) |
      (baseOctets[2]! << 8) |
      baseOctets[3]!) >>>
      0);
  return ((value & mask) >>> 0) === ((baseValue & mask) >>> 0);
}

/** Reason the address is unusable, or null when it is a public address. */
export function classifyIPv4(octets: readonly number[]): string | null {
  for (const [base, prefix, reason] of BLOCKED_IPV4_RANGES) {
    if (inIpv4Range(octets, base, prefix)) return reason;
  }
  return null;
}

export function classifyIPv6(groups: readonly number[]): string | null {
  const g = groups;
  if (g.length !== 8) return "malformed address";
  if (g.every((group) => group === 0)) return "unspecified address";
  if (g.slice(0, 7).every((group) => group === 0) && g[7] === 1) {
    return "loopback address";
  }

  // ::ffff:a.b.c.d — must be judged on the IPv4 address it really is.
  if (g.slice(0, 5).every((group) => group === 0) && g[5] === 0xffff) {
    const v4 = [(g[6]! >> 8) & 0xff, g[6]! & 0xff, (g[7]! >> 8) & 0xff, g[7]! & 0xff];
    return classifyIPv4(v4) ?? null;
  }
  // ::ffff:0:a.b.c.d — IPv4-translated.
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0xffff) {
    const v4 = [(g[6]! >> 8) & 0xff, g[6]! & 0xff, (g[7]! >> 8) & 0xff, g[7]! & 0xff];
    return classifyIPv4(v4) ?? null;
  }
  // 64:ff9b::/96 — NAT64, carries an IPv4 address in its low 32 bits.
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    const v4 = [(g[6]! >> 8) & 0xff, g[6]! & 0xff, (g[7]! >> 8) & 0xff, g[7]! & 0xff];
    return classifyIPv4(v4) ?? null;
  }
  // 100::/64 — discard-only.
  if (g[0] === 0x100 && g.slice(1, 4).every((x) => x === 0)) {
    return "discard-only address";
  }
  // 2001:db8::/32 — documentation.
  if (g[0] === 0x2001 && g[1] === 0x0db8) return "documentation address";
  // 2002::/16 — 6to4, tunnels an arbitrary IPv4 address.
  if (g[0] === 0x2002) return "6to4 address";
  // fc00::/7 — unique local.
  if ((g[0]! & 0xfe00) === 0xfc00) return "unique local address";
  // fe80::/10 — link-local, and fec0::/10 — deprecated site-local.
  if ((g[0]! & 0xffc0) === 0xfe80) return "link-local address";
  if ((g[0]! & 0xffc0) === 0xfec0) return "site-local address";
  // ff00::/8 — multicast.
  if ((g[0]! & 0xff00) === 0xff00) return "multicast address";
  return null;
}

export function isIpLiteral(host: string): boolean {
  return parseIPv4(host) !== null || parseIPv6(host) !== null;
}

/** Reason the address must not be contacted, or null when it is acceptable. */
export function isBlockedAddress(address: string): string | null {
  const v4 = parseIPv4(address);
  if (v4) return classifyIPv4(v4);
  const v6 = parseIPv6(address);
  if (v6) return classifyIPv6(v6);
  // Unparseable input is blocked, not trusted.
  return "unrecognized address";
}

export function isBlockedHostname(hostname: string): string | null {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host.length === 0) return "empty hostname";
  if (BLOCKED_HOSTNAMES.has(host)) return `reserved hostname (${host})`;
  // A bare label can be completed by a search domain into something internal.
  if (!host.includes(".")) return `hostname has no public suffix (${host})`;
  for (const suffix of BLOCKED_HOST_SUFFIXES) {
    if (host.endsWith(suffix)) return `reserved hostname suffix (${host})`;
  }
  return null;
}

export type ResolvedAddress = { address: string; family: number };

export type AddressResolver = (
  hostname: string
) => Promise<readonly ResolvedAddress[]>;

export const allowedProtocols: readonly string[] = ["http:", "https:"];

/** Parses a user-supplied url and refuses anything that is not http(s). */
export function parseTargetUrl(input: string): URL {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new TargetRefusedError("A url is required", "empty url");
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new TargetRefusedError(
      `Not an absolute url: ${trimmed}`,
      "malformed url"
    );
  }
  if (!allowedProtocols.includes(url.protocol)) {
    throw new TargetRefusedError(
      `Only http and https urls can be imported (got ${url.protocol.replace(":", "")})`,
      `unsupported protocol ${url.protocol}`
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new TargetRefusedError(
      "Urls carrying credentials are refused",
      "credentials in url"
    );
  }
  return url;
}

function normalizedHost(url: URL): string {
  const host = url.hostname;
  return host.startsWith("[") && host.endsWith("]")
    ? host.slice(1, -1)
    : host;
}

/**
 * Normalized form of a url, used to recognize a re-import of the same page.
 *
 * The fragment is dropped (it never reaches the server) and the host is
 * lower-cased, since those two differences cannot change which page is meant.
 * Everything else — path, query, port, scheme — is kept, because collapsing it
 * could merge two genuinely different pages.
 */
export function canonicalizeUrl(url: URL): string {
  const normalized = new URL(url.toString());
  normalized.hash = "";
  normalized.protocol = normalized.protocol.toLowerCase();
  normalized.hostname = normalized.hostname.toLowerCase();
  // Drop the default port so `https://a.test:443/x` and `https://a.test/x`
  // are recognized as one page.
  if (
    (normalized.protocol === "http:" && normalized.port === "80") ||
    (normalized.protocol === "https:" && normalized.port === "443")
  ) {
    normalized.port = "";
  }
  if (normalized.pathname === "" && normalized.search === "") {
    normalized.pathname = "/";
  }
  return normalized.toString();
}

/**
 * Validates a url and returns the single address the connection must use.
 *
 * Every address the host resolves to is checked, not only the one that will be
 * used: a resolver that answers with a public address first and a private one
 * second must not be able to get through at all.
 */
export async function resolveValidatedTarget(
  url: URL,
  resolve: AddressResolver
): Promise<ResolvedAddress> {
  const host = normalizedHost(url);

  if (isIpLiteral(host)) {
    const reason = isBlockedAddress(host);
    if (reason) {
      throw new TargetRefusedError(
        `Refusing to import ${host}: it is a ${reason}`,
        reason
      );
    }
    return { address: host, family: host.includes(":") ? 6 : 4 };
  }

  const hostnameReason = isBlockedHostname(host);
  if (hostnameReason) {
    throw new TargetRefusedError(`Refusing to import ${host}: ${hostnameReason}`, hostnameReason);
  }

  let addresses: readonly ResolvedAddress[];
  try {
    addresses = await resolve(host);
  } catch (cause) {
    throw new TargetRefusedError(
      `Could not resolve ${host}`,
      cause instanceof Error ? cause.message : "dns failure"
    );
  }
  if (addresses.length === 0) {
    throw new TargetRefusedError(`Could not resolve ${host}`, "no address");
  }
  for (const candidate of addresses) {
    const reason = isBlockedAddress(candidate.address);
    if (reason) {
      throw new TargetRefusedError(
        `Refusing to import ${host}: it resolves to a ${reason} (${candidate.address})`,
        reason
      );
    }
  }
  // Addresses are validated; the caller must connect to this one and must not
  // resolve again, or the check above would be decorative.
  return addresses[0]!;
}
