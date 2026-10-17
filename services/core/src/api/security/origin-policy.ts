/**
 * Trusted-origin policy and the one pure decision that uses it.
 *
 * Why this module exists: this service authenticates with a cookie
 * (`nexus_session`) and nothing else. A cookie is *ambient* — the browser
 * attaches it to any request aimed at this origin, including requests a
 * different site caused the browser to make. `SameSite=Lax` reduces that, but
 * it is a browser-side default, it does not cover same-site subdomains, and it
 * is not a server-side guarantee. So the server decides, on its own, whether a
 * state-changing request came from a page it trusts.
 *
 * The rules this module enforces, in order of importance:
 *  1. The trusted list comes from configuration, never from the request. A
 *     server that derives its allowlist from `Host` / `X-Forwarded-Host` trusts
 *     whatever the attacker sends.
 *  2. Comparison is exact on a parsed origin: scheme, host, port. There is no
 *     substring or suffix matching anywhere, because `evil-example.com` ends
 *     with `example.com` and `example.com.attacker.net` starts with it.
 *  3. A missing `Origin` is not trust, `Origin: null` is not trust, an
 *     unparseable `Origin` is not trust.
 *  4. A public deployment with no configured origin refuses to start rather
 *     than falling back to "allow everything".
 *
 * Nothing here reads the clock, the network or the database: it is a pure
 * function of the environment map and the request headers, which is what makes
 * every rule below directly testable.
 */
import { isPublicDeployment, type AuthConfigEnv } from "../../auth-config";

/** Origins a local development run trusts when nothing is configured. */
export const LOCAL_DEFAULT_ORIGINS: readonly string[] = [
  "http://localhost:3000",
  "http://127.0.0.1:3000"
];

/** Unsafe methods: the ones a browser will send a cookie on without a preflight. */
const UNSAFE_METHODS: ReadonlySet<string> = new Set([
  "POST",
  "PUT",
  "PATCH",
  "DELETE"
]);

export function isUnsafeMethod(method: string): boolean {
  return UNSAFE_METHODS.has(method.toUpperCase());
}

export type OriginPolicySource = "environment" | "local-default";

export type OriginPolicy = {
  /** Every origin a browser may present, normalized to `scheme://host[:port]`. */
  readonly allowed: ReadonlySet<string>;
  /** Where the list came from. Recorded so start-up can say it out loud. */
  readonly source: OriginPolicySource;
  /**
   * True when the list is empty. A guard holding an empty policy must refuse
   * every unsafe request rather than let them through unchecked.
   */
  readonly empty: boolean;
};

/**
 * Raised when the deployment cannot be given a safe trusted-origin list. As
 * with `AuthConfigurationError`, every reason is collected so an operator fixes
 * them in one pass instead of one restart at a time.
 */
export class OriginPolicyError extends Error {
  readonly reasons: string[];

  constructor(message: string, reasons: string[] = []) {
    super(
      reasons.length > 0
        ? `${message}\n  - ${reasons.join("\n  - ")}`
        : message
    );
    this.name = "OriginPolicyError";
    this.reasons = reasons;
  }
}

function trimmed(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Normalizes one origin, or returns null when the value is not a bare origin.
 *
 * `new URL` is the only parser used: it lowercases the scheme and host, drops a
 * default port, converts IDN labels to punycode, and resolves odd encodings.
 * Writing that by hand is how comparison bugs get in.
 */
export function normalizeOrigin(raw: string | undefined | null): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value === "") return null;
  // `null` is the literal a sandboxed document sends. It names no origin.
  if (value.toLowerCase() === "null") return null;
  // Two values merged into one header (Node joins duplicate headers) can never
  // be a single origin, and a wildcard can never be configured.
  if (value.includes(",") || value.includes("*")) return null;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // Embedded credentials have no business in an origin and indicate a forged
  // value (`http://trusted.example@evil.example`).
  if (url.username !== "" || url.password !== "") return null;
  // An `Origin` header is a scheme, a host and an optional port. Anything with
  // a path, query or fragment came from something rewriting the header badly.
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return null;
  // `example.com.` resolves to `example.com` but is a different string. Refusing
  // it costs nothing (browsers never send it) and keeps the comparison literal.
  if (url.hostname === "" || url.hostname.endsWith(".")) return null;

  // `url.origin` is already canonical: default ports are dropped, the rest is
  // `scheme://host:port`.
  return url.origin;
}

/**
 * Splits a configured list into origins and the entries that were refused.
 * A refused entry is reported rather than dropped: a typo in a security
 * allowlist must be loud, not silent.
 */
export function parseOriginList(raw: string | undefined): {
  origins: string[];
  rejected: string[];
} {
  const origins: string[] = [];
  const rejected: string[] = [];
  const parts = trimmed(raw)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  for (const part of parts) {
    const normalized = normalizeOrigin(part);
    if (normalized) origins.push(normalized);
    else rejected.push(part);
  }
  return { origins, rejected };
}

export type ResolveOriginPolicyOptions = {
  /**
   * An origin handed in by the caller (tests, or an embedding process) instead
   * of the environment. Still parsed and still subject to the public-mode rule.
   */
  webOriginOverride?: string;
};

/**
 * Resolves the trusted origins for this process.
 *
 * `WEB_ORIGINS` is the multi-origin form (a legitimate deployment may serve the
 * UI from one origin and call the API from another); `WEB_ORIGIN` is the older
 * single-origin setting and keeps working. When neither is set, a local demo
 * gets the two loopback origins it actually uses, and a public deployment
 * refuses to start.
 */
export function resolveOriginPolicy(
  env: AuthConfigEnv,
  options: ResolveOriginPolicyOptions = {}
): OriginPolicy {
  const isPublic = isPublicDeployment(env);
  const reasons: string[] = [];

  const override = trimmed(options.webOriginOverride);
  const multi = trimmed(env.WEB_ORIGINS);
  const single = trimmed(env.WEB_ORIGIN);
  const configured = [override, multi, single].filter(Boolean).join(",");

  if (configured === "") {
    if (isPublic) {
      reasons.push(
        "WEB_ORIGIN (or WEB_ORIGINS) is not set. A public deployment must name the web origin it trusts: without it every browser write request would either be refused or wrongly trusted."
      );
      throw new OriginPolicyError(
        "Refusing to start: this deployment is public but has no trusted web origin configured.",
        reasons
      );
    }
    return {
      allowed: new Set(LOCAL_DEFAULT_ORIGINS.map((origin) => normalizeOrigin(origin)!)),
      source: "local-default",
      empty: false
    };
  }

  const { origins, rejected } = parseOriginList(configured);
  for (const value of rejected) {
    reasons.push(
      `"${value}" is not a bare http(s) origin. Use the form scheme://host[:port], with no path, query, fragment, credentials or wildcard.`
    );
  }
  if (origins.length === 0) {
    reasons.push(
      "No usable origin remained after parsing the configured value(s)."
    );
  }
  if (reasons.length > 0) {
    throw new OriginPolicyError(
      "Refusing to start: the trusted web origin configuration cannot be used.",
      reasons
    );
  }

  return {
    allowed: new Set(origins),
    source: "environment",
    empty: origins.length === 0
  };
}

/**
 * Why a request was refused. Kept as a closed set so the audit trail and the
 * tests can both name the exact rule that fired; it never reaches the client,
 * whose answer is one uniform 403.
 */
export type OriginRefusal =
  | "policy_empty"
  | "cross_site_fetch"
  | "origin_missing"
  | "origin_null"
  | "origin_malformed"
  | "origin_untrusted";

export type OriginVerdict =
  | { allowed: true; origin: string }
  | { allowed: false; reason: OriginRefusal };

/**
 * The decision for one request.
 *
 * `Sec-Fetch-Site: cross-site` is a refusal on its own: a browser that says the
 * request came from another site has already told us it is not our client, and
 * it can never be overridden by a trusted-looking `Origin` (the pair being
 * inconsistent means one of them was forged).
 *
 * A *missing* `Sec-Fetch-Site` is not a refusal and is not trust either: it
 * falls through to the origin check, so an old browser without Fetch Metadata
 * gets exactly the same protection as a new one. There is deliberately no
 * Referer fallback: a `Referer` can be suppressed by the attacker's page or
 * stripped by policy, it carries a full URL rather than an origin, and it adds
 * no strength over `Origin` for the clients this service actually has.
 */
export function evaluateOrigin(input: {
  origin: string | undefined;
  secFetchSite?: string | undefined;
  policy: OriginPolicy;
}): OriginVerdict {
  if (input.policy.empty) {
    return { allowed: false, reason: "policy_empty" };
  }

  const secFetchSite =
    typeof input.secFetchSite === "string"
      ? input.secFetchSite.trim().toLowerCase()
      : "";
  if (secFetchSite === "cross-site") {
    return { allowed: false, reason: "cross_site_fetch" };
  }

  const raw = input.origin;
  if (typeof raw !== "string" || raw.trim() === "") {
    return { allowed: false, reason: "origin_missing" };
  }
  if (raw.trim().toLowerCase() === "null") {
    return { allowed: false, reason: "origin_null" };
  }

  const normalized = normalizeOrigin(raw);
  if (!normalized) {
    return { allowed: false, reason: "origin_malformed" };
  }
  if (!input.policy.allowed.has(normalized)) {
    return { allowed: false, reason: "origin_untrusted" };
  }
  return { allowed: true, origin: normalized };
}

/** The single 403 body. It names the class of refusal, never the detail. */
export const CSRF_REJECTION_BODY = {
  error: "Request origin rejected",
  code: "csrf_origin_rejected"
} as const;
