import { describe, expect, it } from "vitest";
import {
  canonicalizeUrl,
  isBlockedAddress,
  isBlockedHostname,
  parseIPv4,
  parseIPv6,
  parseTargetUrl,
  resolveValidatedTarget,
  TargetRefusedError,
  type AddressResolver,
  type ResolvedAddress
} from "./ssrf-guard";

/**
 * The SSRF boundary, proved without touching the network.
 *
 * The importer is the one place in this workspace where a user-supplied string
 * causes the server to open a socket, so the policy that decides *what* may be
 * contacted is tested exhaustively and separately from the transport. Every
 * case here is a way the boundary could be walked around in the wild; none of
 * them is hypothetical filler.
 *
 * The rule the whole file rests on: an address is refused unless it is proved
 * public. Anything unparseable, ambiguous or newly written is refused too.
 */

const resolverReturning =
  (addresses: ResolvedAddress[]): AddressResolver =>
  async () =>
    addresses;

const publicAddress = (address = "93.184.216.34"): ResolvedAddress => ({
  address,
  family: address.includes(":") ? 6 : 4
});

describe("protocol policy", () => {
  it("accepts only http and https", () => {
    expect(parseTargetUrl("https://example.test/page").protocol).toBe("https:");
    expect(parseTargetUrl("http://example.test/page").protocol).toBe("http:");

    for (const refused of [
      "file:///etc/passwd",
      "ftp://example.test/x",
      "gopher://example.test:70/_",
      "data:text/html;base64,PHNjcmlwdD4=",
      "javascript:alert(1)",
      "ws://example.test/socket",
      "//example.test/protocol-relative"
    ]) {
      expect(() => parseTargetUrl(refused), refused).toThrow(
        TargetRefusedError
      );
    }
  });

  it("refuses urls that carry credentials", () => {
    expect(() => parseTargetUrl("https://user:pass@example.test/x")).toThrow(
      /credentials/
    );
  });

  it("refuses empty and malformed input", () => {
    expect(() => parseTargetUrl("   ")).toThrow(TargetRefusedError);
    expect(() => parseTargetUrl("example.test/no-scheme")).toThrow(
      TargetRefusedError
    );
  });
});

describe("address classification", () => {
  it("parses IPv4 strictly", () => {
    expect(parseIPv4("127.0.0.1")).toEqual([127, 0, 0, 1]);
    expect(parseIPv4("255.255.255.255")).toEqual([255, 255, 255, 255]);
    // Ambiguous notations are refused rather than guessed at.
    expect(parseIPv4("127.0.0.01")).toBeNull();
    expect(parseIPv4("127.0.0")).toBeNull();
    expect(parseIPv4("-1.0.0.1")).toBeNull();
    expect(parseIPv4("256.0.0.1")).toBeNull();
  });

  it("parses IPv6 including compressed, mapped and zoned forms", () => {
    expect(parseIPv6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6("2001:db8::1")).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6("1:2:3:4:5:6:7:8")).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(parseIPv6("::ffff:127.0.0.1")).toEqual([
      0, 0, 0, 0, 0, 0xffff, 0x7f00, 0x0001
    ]);
    expect(parseIPv6("fe80::1%eth0")).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6("[::1]")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    // `::` is the unspecified address and does parse; the policy is what
    // refuses it, not the parser.
    expect(parseIPv6("::")).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(isBlockedAddress("::")).toBe("unspecified address");
    // Malformed forms must not silently become "some other address".
    expect(parseIPv6("1:2:3:4:5:6:7:8:9")).toBeNull();
    expect(parseIPv6("1:2:3:4:5:6:7")).toBeNull();
    expect(parseIPv6("gggg::1")).toBeNull();
    expect(parseIPv6("127.0.0.1")).toBeNull();
    expect(parseIPv6("1::2::3")).toBeNull();
  });

  it("blocks loopback, private, link-local and reserved IPv4", () => {
    const blocked = [
      "0.0.0.0",
      "0.1.2.3",
      "10.0.0.1",
      "10.255.255.254",
      "100.64.0.1",
      "100.100.100.100", // Alibaba Cloud instance metadata
      "127.0.0.1",
      "127.1.2.3",
      "169.254.0.1",
      "169.254.169.254", // link-local cloud metadata endpoint
      "172.16.0.1",
      "172.31.255.254",
      "192.0.0.1",
      "192.0.2.5",
      "192.88.99.1",
      "192.168.1.1",
      "198.18.0.1",
      "198.51.100.7",
      "203.0.113.9",
      "224.0.0.1",
      "240.0.0.1",
      "255.255.255.255"
    ];
    for (const address of blocked) {
      expect(isBlockedAddress(address), address).not.toBeNull();
    }
  });

  it("allows genuinely public IPv4", () => {
    for (const address of [
      "1.1.1.1",
      "8.8.8.8",
      "93.184.216.34",
      "172.32.0.1", // just past the private block
      "11.0.0.1" // just past the 10/8 block
    ]) {
      expect(isBlockedAddress(address), address).toBeNull();
    }
  });

  it("blocks IPv6 loopback, local, link-local, multicast and mapped private", () => {
    const blocked = [
      "::",
      "::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:10.0.0.1",
      "::ffff:169.254.169.254",
      "::ffff:0:10.0.0.1",
      "64:ff9b::a00:1", // NAT64 wrapping 10.0.0.1
      "64:ff9b::7f00:1", // NAT64 wrapping 127.0.0.1
      "2002:0a00:0001::1", // 6to4 wrapping 10.0.0.1
      "100::1",
      "2001:db8::1",
      "fc00::1",
      "fd00:ec2::254", // AWS IMDS over IPv6
      "fe80::1",
      "fec0::1",
      "ff02::1"
    ];
    for (const address of blocked) {
      expect(isBlockedAddress(address), address).not.toBeNull();
    }
  });

  it("allows public IPv6", () => {
    expect(isBlockedAddress("2606:4700:4700::1111")).toBeNull();
    expect(isBlockedAddress("2001:4860:4860::8888")).toBeNull();
  });

  it("blocks an address it cannot parse rather than trusting it", () => {
    expect(isBlockedAddress("not-an-address")).not.toBeNull();
    expect(isBlockedAddress("")).not.toBeNull();
    expect(isBlockedAddress("0x7f.1")).not.toBeNull();
    // Out-of-range octets never reach the classifier: parseIPv4 refuses them.
    expect(parseIPv4("999.0.0.1")).toBeNull();
    expect(isBlockedAddress("999.0.0.1")).not.toBeNull();
  });
});

describe("hostname policy", () => {
  it("refuses reserved names and bare labels", () => {
    for (const host of [
      "localhost",
      "LocalHost",
      "api.localhost",
      "printer.local",
      "vault.internal",
      "router.home.arpa",
      "1.0.0.127.in-addr.arpa",
      "metadata.google.internal",
      "metadata",
      "intranet" // single label: a search domain could complete it
    ]) {
      expect(isBlockedHostname(host), host).not.toBeNull();
    }
  });

  it("allows ordinary public hostnames", () => {
    for (const host of ["example.test", "www.stats.gov.cn", "a.b.c.example.org"]) {
      expect(isBlockedHostname(host), host).toBeNull();
    }
  });
});

describe("target resolution", () => {
  it("refuses an IP-literal private target without asking DNS", async () => {
    let called = false;
    const resolve: AddressResolver = async () => {
      called = true;
      return [publicAddress()];
    };
    await expect(
      resolveValidatedTarget(new URL("http://127.0.0.1/"), resolve)
    ).rejects.toThrow(/loopback/);
    await expect(
      resolveValidatedTarget(new URL("http://[::1]/"), resolve)
    ).rejects.toThrow(/loopback/);
    expect(called).toBe(false);
  });

  it("refuses the cloud metadata endpoint whatever notation is used", async () => {
    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "http://[::ffff:169.254.169.254]/latest/meta-data/",
      "http://metadata.google.internal/computeMetadata/v1/"
    ]) {
      await expect(
        resolveValidatedTarget(new URL(url), resolverReturning([publicAddress()]))
      ).rejects.toThrow(TargetRefusedError);
    }
  });

  it("refuses a hostname that resolves to a private address", async () => {
    await expect(
      resolveValidatedTarget(
        new URL("https://looks-public.test/x"),
        resolverReturning([{ address: "10.0.0.5", family: 4 }])
      )
    ).rejects.toThrow(/private address/);
  });

  it("refuses when any answer is private, not only the first", async () => {
    // A resolver that answers public first and private second is the classic
    // rebinding shape; validating only the address we intend to use would miss
    // it, so every answer is checked.
    await expect(
      resolveValidatedTarget(
        new URL("https://looks-public.test/x"),
        resolverReturning([
          { address: "93.184.216.34", family: 4 },
          { address: "127.0.0.1", family: 4 }
        ])
      )
    ).rejects.toThrow(/loopback address/);
  });

  it("refuses when a resolver answers only with unparseable data", async () => {
    await expect(
      resolveValidatedTarget(
        new URL("https://example.test/x"),
        resolverReturning([{ address: "0x7f.1", family: 4 }])
      )
    ).rejects.toThrow(TargetRefusedError);
  });

  it("refuses when the host does not resolve at all", async () => {
    await expect(
      resolveValidatedTarget(new URL("https://nowhere.test/x"), async () => [])
    ).rejects.toThrow(/Could not resolve/);
  });

  it("returns the validated address so the connection can be pinned", async () => {
    const pinned = await resolveValidatedTarget(
      new URL("https://example.test/page"),
      resolverReturning([publicAddress()])
    );
    expect(pinned).toEqual({ address: "93.184.216.34", family: 4 });
  });

  it("returns a public IPv6 literal directly", async () => {
    const pinned = await resolveValidatedTarget(
      new URL("https://[2606:4700:4700::1111]/"),
      resolverReturning([])
    );
    expect(pinned).toEqual({ address: "2606:4700:4700::1111", family: 6 });
  });
});

describe("url canonicalization", () => {
  it("drops the fragment, lower-cases the host and the default port", () => {
    expect(
      canonicalizeUrl(new URL("https://EXAMPLE.test:443/Path?q=1#section"))
    ).toBe("https://example.test/Path?q=1");
    expect(canonicalizeUrl(new URL("http://example.test:80/"))).toBe(
      "http://example.test/"
    );
  });

  it("keeps differences that change which page is meant", () => {
    const a = canonicalizeUrl(new URL("https://example.test/a"));
    const b = canonicalizeUrl(new URL("https://example.test/b"));
    const c = canonicalizeUrl(new URL("https://example.test/a?page=2"));
    const d = canonicalizeUrl(new URL("http://example.test/a"));
    expect(new Set([a, b, c, d]).size).toBe(4);
  });
});
