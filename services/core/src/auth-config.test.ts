import { describe, expect, it } from "vitest";
import {
  AuthConfigurationError,
  KNOWN_DEMO_SECRETS,
  LOCAL_DEMO_OWNER_PASSWORD,
  LOCAL_DEMO_SECRET,
  MIN_PUBLIC_SECRET_LENGTH,
  isPublicDeployment,
  resolveAuthConfig,
  resolveSecureCookies
} from "./auth-config";

/**
 * The configuration decision is the whole fix, so it is tested as a pure
 * function over an environment map. No process environment is mutated and no
 * file is touched, which is what makes "public deployment refuses to start"
 * cheap to prove rather than something you discover in production.
 */

const STRONG_SECRET = "kQ7vN2pL9xR4tW8mB3cF6hJ1sD5gA0zY";
const STRONG_PASSWORD = "correct-horse-battery";

function resolve(env: Record<string, string | undefined> = {}) {
  return resolveAuthConfig(env, { usersPath: "/tmp/users.json" });
}

describe("resolveAuthConfig · local development", () => {
  it("keeps the demo convenience available when nothing is configured", () => {
    const config = resolve({});
    expect(config.mode).toBe("local-demo");
    expect(config.secretFromEnvironment).toBe(false);
    expect(config.secret).toBe(LOCAL_DEMO_SECRET);
    expect(config.defaultOwnerPassword).toBe(LOCAL_DEMO_OWNER_PASSWORD);
    expect(config.allowDemoBootstrap).toBe(true);
    expect(config.secureCookies).toBe(false);
  });

  it("uses an explicitly configured secret when one is given", () => {
    const config = resolve({ AUTH_SECRET: "a-local-secret" });
    expect(config.secretFromEnvironment).toBe(true);
    expect(config.secret).toBe("a-local-secret");
  });

  it("honours an explicit users path", () => {
    const config = resolve({ AUTH_USERS_PATH: "/var/lib/nexus/users.json" });
    expect(config.usersPath).toBe("/var/lib/nexus/users.json");
  });
});

describe("resolveAuthConfig · public deployment", () => {
  const production = { NODE_ENV: "production" as const };

  it("refuses to start without AUTH_SECRET", () => {
    expect(() => resolve(production)).toThrow(AuthConfigurationError);
  });

  it("refuses a secret shorter than the minimum", () => {
    let error: unknown;
    try {
      resolve({ ...production, AUTH_SECRET: "too-short" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AuthConfigurationError);
    expect((error as AuthConfigurationError).reasons.join(" ")).toContain(
      String(MIN_PUBLIC_SECRET_LENGTH)
    );
  });

  it("refuses a secret that is published in the source", () => {
    for (const secret of KNOWN_DEMO_SECRETS) {
      expect(() =>
        resolve({ ...production, AUTH_SECRET: secret })
      ).toThrow(AuthConfigurationError);
    }
  });

  it("refuses to create the first owner with the shipped password", () => {
    let error: unknown;
    try {
      resolve({ ...production, AUTH_SECRET: STRONG_SECRET });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AuthConfigurationError);
    expect((error as AuthConfigurationError).reasons.join(" ")).toContain(
      "AUTH_DEFAULT_OWNER_PASSWORD"
    );
  });

  it("refuses a weak initial owner password", () => {
    expect(() =>
      resolve({
        ...production,
        AUTH_SECRET: STRONG_SECRET,
        AUTH_DEFAULT_OWNER_PASSWORD: "short"
      })
    ).toThrow(AuthConfigurationError);
  });

  it("starts when the secret and the initial owner password are both set", () => {
    const config = resolve({
      ...production,
      AUTH_SECRET: STRONG_SECRET,
      AUTH_DEFAULT_OWNER_PASSWORD: STRONG_PASSWORD
    });
    expect(config.mode).toBe("public");
    expect(config.defaultOwnerPassword).toBe(STRONG_PASSWORD);
    // No viewer is invented when none was asked for.
    expect(config.defaultViewerPassword).toBeNull();
    expect(config.allowDemoBootstrap).toBe(true);
  });

  it("keeps an explicitly requested viewer password", () => {
    const config = resolve({
      ...production,
      AUTH_SECRET: STRONG_SECRET,
      AUTH_DEFAULT_OWNER_PASSWORD: STRONG_PASSWORD,
      AUTH_DEFAULT_VIEWER_PASSWORD: "another-strong-password"
    });
    expect(config.defaultViewerPassword).toBe("another-strong-password");
  });

  it("reports every problem at once rather than one restart at a time", () => {
    let error: unknown;
    try {
      resolve({ ...production, AUTH_SECRET: "weak" });
    } catch (caught) {
      error = caught;
    }
    const reasons = (error as AuthConfigurationError).reasons;
    expect(reasons.length).toBeGreaterThanOrEqual(2);
  });
});

describe("isPublicDeployment", () => {
  it("treats production as public", () => {
    expect(isPublicDeployment({ NODE_ENV: "production" })).toBe(true);
  });

  it("treats an explicit public flag as public", () => {
    expect(isPublicDeployment({ NEXUS_PUBLIC_DEPLOYMENT: "true" })).toBe(true);
  });

  it("treats switching the demo off as public", () => {
    expect(isPublicDeployment({ NEXUS_DEMO_MODE: "false" })).toBe(true);
  });

  it("treats development, test and an unset runtime as local", () => {
    expect(isPublicDeployment({})).toBe(false);
    expect(isPublicDeployment({ NODE_ENV: "development" })).toBe(false);
    expect(isPublicDeployment({ NODE_ENV: "test" })).toBe(false);
  });
});

describe("resolveSecureCookies", () => {
  it("marks the cookie Secure on an https public deployment", () => {
    expect(
      resolveSecureCookies(
        { NODE_ENV: "production", WEB_ORIGIN: "https://nexus.example.com" },
        true
      )
    ).toBe(true);
  });

  it("does not mark it Secure on a local http run", () => {
    expect(
      resolveSecureCookies({ WEB_ORIGIN: "http://localhost:3000" }, false)
    ).toBe(false);
  });

  it("lets an explicit setting win in both directions", () => {
    expect(
      resolveSecureCookies(
        { WEB_ORIGIN: "http://localhost:3000", AUTH_COOKIE_SECURE: "true" },
        false
      )
    ).toBe(true);
    expect(
      resolveSecureCookies(
        {
          NODE_ENV: "production",
          WEB_ORIGIN: "https://nexus.example.com",
          AUTH_COOKIE_SECURE: "false"
        },
        true
      )
    ).toBe(false);
  });
});
