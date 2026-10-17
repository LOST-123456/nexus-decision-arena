import { describe, expect, it } from "vitest";
import type { AuthConfigEnv } from "../../auth-config";
import {
  CSRF_REJECTION_BODY,
  evaluateOrigin,
  isUnsafeMethod,
  normalizeOrigin,
  OriginPolicyError,
  parseOriginList,
  resolveOriginPolicy,
  type OriginPolicy
} from "./origin-policy";

/**
 * Every rule the origin guard depends on, tested as a pure function.
 *
 * The point of this file is the *adversarial* half: a trusted-origin check is
 * only worth having if the impostors are enumerated rather than imagined, so
 * the cases below are the ones that beat naive implementations — a suffix that
 * looks like the trusted domain, a subdomain of it, an http origin where https
 * is trusted, a different port, a merged header, a trailing dot, an IDN label,
 * a `null` literal, and a value that is not a URL at all.
 */

const LOCAL: AuthConfigEnv = { NODE_ENV: "development" };
const PUBLIC: AuthConfigEnv = { NODE_ENV: "production" };

function policyOf(...origins: string[]): OriginPolicy {
  return {
    allowed: new Set(origins.map((origin) => normalizeOrigin(origin)!)),
    source: "environment",
    empty: origins.length === 0
  };
}

describe("normalizeOrigin", () => {
  it("keeps a plain origin exactly as browsers send it", () => {
    expect(normalizeOrigin("https://nexus.example")).toBe(
      "https://nexus.example"
    );
  });

  it("drops a default port and a bare trailing slash", () => {
    expect(normalizeOrigin("https://nexus.example:443")).toBe(
      "https://nexus.example"
    );
    expect(normalizeOrigin("http://nexus.example:80")).toBe(
      "http://nexus.example"
    );
    expect(normalizeOrigin("https://nexus.example/")).toBe(
      "https://nexus.example"
    );
  });

  it("keeps a non-default port, because a port is part of the origin", () => {
    expect(normalizeOrigin("http://localhost:3000")).toBe(
      "http://localhost:3000"
    );
    expect(normalizeOrigin("https://nexus.example:8443")).toBe(
      "https://nexus.example:8443"
    );
  });

  it("lowercases the scheme and the host", () => {
    expect(normalizeOrigin("HTTPS://NEXUS.EXAMPLE")).toBe(
      "https://nexus.example"
    );
  });

  it("accepts an IPv6 literal", () => {
    expect(normalizeOrigin("http://[::1]:3000")).toBe("http://[::1]:3000");
  });

  it("converts an internationalised host to one canonical form", () => {
    // Both spellings must normalize to the same string, or a deployment could
    // be configured with one and receive the other.
    expect(normalizeOrigin("http://例え.jp")).toBe(
      normalizeOrigin("http://xn--r8jz45g.jp")
    );
  });

  it("refuses the null literal a sandboxed document sends", () => {
    expect(normalizeOrigin("null")).toBeNull();
    expect(normalizeOrigin("NULL")).toBeNull();
  });

  it("refuses an empty value", () => {
    expect(normalizeOrigin("")).toBeNull();
    expect(normalizeOrigin("   ")).toBeNull();
    expect(normalizeOrigin(undefined)).toBeNull();
    expect(normalizeOrigin(null)).toBeNull();
  });

  it("refuses a wildcard", () => {
    expect(normalizeOrigin("*")).toBeNull();
    expect(normalizeOrigin("https://*.example.com")).toBeNull();
  });

  it("refuses two values merged into one header", () => {
    // Node joins repeated headers with ", ", so this is what a double-Origin
    // request looks like by the time a handler sees it.
    expect(normalizeOrigin("https://nexus.example, https://evil.example")).toBeNull();
  });

  it("refuses a value carrying a path, query or fragment", () => {
    expect(normalizeOrigin("https://nexus.example/app")).toBeNull();
    expect(normalizeOrigin("https://nexus.example?x=1")).toBeNull();
    expect(normalizeOrigin("https://nexus.example#top")).toBeNull();
  });

  it("refuses embedded credentials", () => {
    expect(normalizeOrigin("https://nexus.example@evil.example")).toBeNull();
    expect(normalizeOrigin("https://user:pass@nexus.example")).toBeNull();
  });

  it("refuses a non-http scheme", () => {
    expect(normalizeOrigin("ftp://nexus.example")).toBeNull();
    expect(normalizeOrigin("file:///etc/passwd")).toBeNull();
    expect(normalizeOrigin("javascript:alert(1)")).toBeNull();
  });

  it("refuses a bare host with no scheme", () => {
    expect(normalizeOrigin("nexus.example")).toBeNull();
    expect(normalizeOrigin("localhost:3000")).toBeNull();
  });

  it("refuses a trailing dot, which is a different string for the same host", () => {
    expect(normalizeOrigin("https://nexus.example.")).toBeNull();
  });

  it("refuses a value that is not a URL at all", () => {
    expect(normalizeOrigin("not a url")).toBeNull();
    expect(normalizeOrigin("https://exa mple.com")).toBeNull();
  });
});

describe("parseOriginList", () => {
  it("splits a configured list and reports what it refused", () => {
    const parsed = parseOriginList(
      "https://a.example, http://b.example:3000, nonsense, https://c.example/path"
    );
    expect(parsed.origins).toEqual([
      "https://a.example",
      "http://b.example:3000"
    ]);
    expect(parsed.rejected).toEqual(["nonsense", "https://c.example/path"]);
  });

  it("answers empty for an unset value", () => {
    expect(parseOriginList(undefined)).toEqual({ origins: [], rejected: [] });
    expect(parseOriginList("  ,  ")).toEqual({ origins: [], rejected: [] });
  });
});

describe("evaluateOrigin", () => {
  const policy = policyOf("https://nexus.example", "http://localhost:3000");

  it("accepts a configured origin", () => {
    expect(
      evaluateOrigin({ origin: "https://nexus.example", policy })
    ).toEqual({ allowed: true, origin: "https://nexus.example" });
  });

  it("accepts a configured origin written with its default port", () => {
    expect(
      evaluateOrigin({ origin: "https://nexus.example:443", policy })
    ).toEqual({ allowed: true, origin: "https://nexus.example" });
  });

  it("refuses a request that presents no origin", () => {
    expect(evaluateOrigin({ origin: undefined, policy })).toEqual({
      allowed: false,
      reason: "origin_missing"
    });
    expect(evaluateOrigin({ origin: "   ", policy })).toEqual({
      allowed: false,
      reason: "origin_missing"
    });
  });

  it("refuses the null origin", () => {
    expect(evaluateOrigin({ origin: "null", policy })).toEqual({
      allowed: false,
      reason: "origin_null"
    });
  });

  it("refuses a malformed origin", () => {
    expect(evaluateOrigin({ origin: "nexus.example", policy })).toEqual({
      allowed: false,
      reason: "origin_malformed"
    });
  });

  it("refuses an unknown origin", () => {
    expect(
      evaluateOrigin({ origin: "https://evil.example", policy })
    ).toEqual({ allowed: false, reason: "origin_untrusted" });
  });

  it("refuses a domain that only ends with the trusted one", () => {
    // `evil-nexus.example` ends with `nexus.example`; endsWith would let it in.
    expect(
      evaluateOrigin({ origin: "https://evil-nexus.example", policy })
    ).toEqual({ allowed: false, reason: "origin_untrusted" });
    expect(
      evaluateOrigin({ origin: "https://nexus.example.attacker.test", policy })
    ).toEqual({ allowed: false, reason: "origin_untrusted" });
  });

  it("refuses a subdomain of the trusted domain", () => {
    // A sibling subdomain is a different origin and may be run by someone else.
    expect(
      evaluateOrigin({ origin: "https://app.nexus.example", policy })
    ).toEqual({ allowed: false, reason: "origin_untrusted" });
  });

  it("refuses http where https is trusted", () => {
    expect(
      evaluateOrigin({ origin: "http://nexus.example", policy })
    ).toEqual({ allowed: false, reason: "origin_untrusted" });
  });

  it("refuses a different port on the same host", () => {
    expect(
      evaluateOrigin({ origin: "http://localhost:4100", policy })
    ).toEqual({ allowed: false, reason: "origin_untrusted" });
  });

  it("refuses everything when the policy is empty", () => {
    expect(
      evaluateOrigin({ origin: "https://nexus.example", policy: policyOf() })
    ).toEqual({ allowed: false, reason: "policy_empty" });
  });

  it("refuses a request a browser itself marks as cross-site", () => {
    expect(
      evaluateOrigin({
        origin: "https://nexus.example",
        secFetchSite: "cross-site",
        policy
      })
    ).toEqual({ allowed: false, reason: "cross_site_fetch" });
  });

  it("does not treat a missing Sec-Fetch-Site as trust", () => {
    // An older browser sends no Fetch Metadata. It must still pass the origin
    // check, and an origin-less request from it must still be refused.
    expect(
      evaluateOrigin({ origin: "https://nexus.example", policy })
    ).toMatchObject({ allowed: true });
    expect(evaluateOrigin({ origin: undefined, policy })).toEqual({
      allowed: false,
      reason: "origin_missing"
    });
  });

  it("accepts same-origin and same-site Fetch Metadata when the origin matches", () => {
    for (const site of ["same-origin", "same-site", "none"]) {
      expect(
        evaluateOrigin({
          origin: "https://nexus.example",
          secFetchSite: site,
          policy
        })
      ).toMatchObject({ allowed: true });
    }
  });
});

describe("resolveOriginPolicy", () => {
  it("uses the two loopback origins for a local run with nothing configured", () => {
    const policy = resolveOriginPolicy(LOCAL);
    expect(policy.source).toBe("local-default");
    expect([...policy.allowed].sort()).toEqual([
      "http://127.0.0.1:3000",
      "http://localhost:3000"
    ]);
  });

  it("trusts exactly what WEB_ORIGIN names", () => {
    const policy = resolveOriginPolicy({
      ...LOCAL,
      WEB_ORIGIN: "https://nexus.example"
    });
    expect(policy.source).toBe("environment");
    expect([...policy.allowed]).toEqual(["https://nexus.example"]);
  });

  it("adds WEB_ORIGINS to WEB_ORIGIN rather than replacing it", () => {
    const policy = resolveOriginPolicy({
      ...LOCAL,
      WEB_ORIGIN: "https://nexus.example",
      WEB_ORIGINS: "https://admin.nexus.example, http://localhost:3000"
    });
    expect([...policy.allowed].sort()).toEqual([
      "http://localhost:3000",
      "https://admin.nexus.example",
      "https://nexus.example"
    ]);
  });

  it("normalizes what was configured", () => {
    const policy = resolveOriginPolicy({
      ...LOCAL,
      WEB_ORIGIN: "HTTPS://NEXUS.EXAMPLE:443/"
    });
    expect([...policy.allowed]).toEqual(["https://nexus.example"]);
  });

  it("refuses to start a public deployment with no configured origin", () => {
    expect(() => resolveOriginPolicy(PUBLIC)).toThrow(OriginPolicyError);
    try {
      resolveOriginPolicy(PUBLIC);
    } catch (error) {
      expect((error as OriginPolicyError).reasons).toHaveLength(1);
      expect((error as OriginPolicyError).reasons[0]).toContain("WEB_ORIGIN");
    }
  });

  it("refuses to start when a configured origin cannot be parsed", () => {
    // A typo in an allowlist must be loud: silently dropping it would leave a
    // deployment that looks configured and trusts nothing.
    expect(() =>
      resolveOriginPolicy({ ...PUBLIC, WEB_ORIGIN: "nexus.example" })
    ).toThrow(OriginPolicyError);
    expect(() =>
      resolveOriginPolicy({ ...PUBLIC, WEB_ORIGIN: "https://nexus.example/app" })
    ).toThrow(OriginPolicyError);
  });

  it("reports every unusable entry at once", () => {
    try {
      resolveOriginPolicy({
        ...PUBLIC,
        WEB_ORIGIN: "nexus.example",
        WEB_ORIGINS: "ftp://a.example"
      });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(OriginPolicyError);
      const reasons = (error as OriginPolicyError).reasons;
      // Two unusable entries, plus the outcome that nothing survived parsing.
      expect(reasons).toHaveLength(3);
      expect(reasons.some((r) => r.includes('"nexus.example"'))).toBe(true);
      expect(reasons.some((r) => r.includes('"ftp://a.example"'))).toBe(true);
      expect(reasons.some((r) => r.includes("No usable origin remained"))).toBe(true);
    }
  });

  it("accepts a public deployment that names its origin", () => {
    const policy = resolveOriginPolicy({
      ...PUBLIC,
      WEB_ORIGIN: "https://nexus.example"
    });
    expect(policy.empty).toBe(false);
    expect([...policy.allowed]).toEqual(["https://nexus.example"]);
  });

  it("lets a caller supply the origin instead of the environment", () => {
    const policy = resolveOriginPolicy(LOCAL, {
      webOriginOverride: "http://localhost:4321"
    });
    expect([...policy.allowed]).toEqual(["http://localhost:4321"]);
  });

  it("treats NEXUS_DEMO_MODE=false as public, so it also needs an origin", () => {
    expect(() =>
      resolveOriginPolicy({ ...LOCAL, NEXUS_DEMO_MODE: "false" })
    ).toThrow(OriginPolicyError);
  });
});

describe("isUnsafeMethod", () => {
  it("names every method that changes state", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "post", "patch"]) {
      expect(isUnsafeMethod(method)).toBe(true);
    }
    for (const method of ["GET", "HEAD", "OPTIONS", "get"]) {
      expect(isUnsafeMethod(method)).toBe(false);
    }
  });
});

describe("the refusal body", () => {
  it("names the class of refusal without naming the origin or the route", () => {
    expect(CSRF_REJECTION_BODY).toEqual({
      error: "Request origin rejected",
      code: "csrf_origin_rejected"
    });
  });
});
