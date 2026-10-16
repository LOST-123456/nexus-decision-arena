/**
 * Authentication configuration, resolved once before the server starts.
 *
 * The rule this module exists to enforce: a *public* deployment may not run on
 * a secret it did not choose, and may not create an administrator with a
 * password that ships inside the source. A local, single-operator demo run
 * keeps that convenience — but only when the deployment is explicitly local, so
 * "it worked on my machine" can never silently become "the internet knows the
 * owner password".
 *
 * Two consequences worth stating plainly:
 * - Resolution is *pure*: it reads an environment map and returns a value or
 *   throws. Nothing here touches the disk, so the decision is testable without
 *   a process to mutate.
 * - It runs before `app.listen()`. A configuration that fails these checks
 *   stops the process instead of serving traffic it should not serve.
 */

/** Secrets that must never authenticate a public deployment. */
export const LOCAL_DEMO_SECRET = "nexus-local-demo-secret";

/**
 * The convenience accounts a local demo run creates when `.data/users.json`
 * does not exist yet. They are printed on the login page and hard-coded in the
 * browser tests, and they are only ever reachable through
 * `allowDemoBootstrap === true` (see `resolveAuthConfig`).
 */
export const LOCAL_DEMO_OWNER_PASSWORD = "nexus-owner";
export const LOCAL_DEMO_VIEWER_PASSWORD = "nexus-viewer";

/** A 256-bit key is 32 bytes of base64/hex; anything shorter is a passphrase. */
export const MIN_PUBLIC_SECRET_LENGTH = 32;

/** Credentials that are published in the source or the login page. */
export const KNOWN_DEMO_SECRETS: readonly string[] = [LOCAL_DEMO_SECRET];

/** An initial administrator password must not be guessable either. */
export const MIN_INITIAL_PASSWORD_LENGTH = 12;

export type AuthDeploymentMode = "local-demo" | "public";

export type ResolvedAuthConfig = {
  mode: AuthDeploymentMode;
  usersPath: string;
  secret: string;
  /** False when the built-in demo secret is in use (local development only). */
  secretFromEnvironment: boolean;
  /** Null when this deployment must not bootstrap that account at all. */
  defaultOwnerPassword: string | null;
  defaultViewerPassword: string | null;
  /** True when the built-in convenience accounts may be created. */
  allowDemoBootstrap: boolean;
  /** True when the session cookie must carry `Secure`. */
  secureCookies: boolean;
};

export type AuthConfigEnv = {
  NODE_ENV?: string;
  AUTH_SECRET?: string;
  AUTH_USERS_PATH?: string;
  AUTH_DEFAULT_OWNER_PASSWORD?: string;
  AUTH_DEFAULT_VIEWER_PASSWORD?: string;
  AUTH_COOKIE_SECURE?: string;
  WEB_ORIGIN?: string;
  NEXUS_PUBLIC_DEPLOYMENT?: string;
  NEXUS_DEMO_MODE?: string;
  /** Any other variable an environment happens to carry. */
  [key: string]: string | undefined;
};

/**
 * Raised when the deployment is not allowed to start as configured. The
 * reasons are listed so an operator sees every problem in one run rather than
 * fixing them one restart at a time.
 */
export class AuthConfigurationError extends Error {
  readonly reasons: string[];

  constructor(message: string, reasons: string[] = []) {
    super(
      reasons.length > 0
        ? `${message}\n  - ${reasons.join("\n  - ")}`
        : message
    );
    this.name = "AuthConfigurationError";
    this.reasons = reasons;
  }
}

function isTruthy(value: string | undefined): boolean {
  return value === "true" || value === "1";
}

function trimmed(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * A deployment is public when the runtime says so, when an operator says so,
 * or when the demo convenience is explicitly switched off. Any one of the
 * three is enough: they are independent switches, not a consensus.
 */
export function isPublicDeployment(env: AuthConfigEnv): boolean {
  return (
    env.NODE_ENV === "production" ||
    isTruthy(env.NEXUS_PUBLIC_DEPLOYMENT) ||
    env.NEXUS_DEMO_MODE === "false"
  );
}

/**
 * Whether the session cookie must be marked `Secure`.
 *
 * An explicit `AUTH_COOKIE_SECURE` always wins. Otherwise a public deployment
 * behind an https origin gets `Secure`; a local demo on http does not, because
 * a `Secure` cookie is silently dropped over plain http and the login would
 * appear to succeed while leaving nobody signed in.
 */
export function resolveSecureCookies(
  env: AuthConfigEnv,
  isPublic: boolean
): boolean {
  const explicit = trimmed(env.AUTH_COOKIE_SECURE);
  if (explicit === "true" || explicit === "1") return true;
  if (explicit === "false" || explicit === "0") return false;
  return isPublic && trimmed(env.WEB_ORIGIN).startsWith("https://");
}

export function resolveAuthConfig(
  env: AuthConfigEnv,
  defaults: { usersPath: string }
): ResolvedAuthConfig {
  const isPublic = isPublicDeployment(env);
  const reasons: string[] = [];

  const rawSecret = trimmed(env.AUTH_SECRET);
  const secretFromEnvironment = rawSecret.length > 0;
  if (isPublic && !secretFromEnvironment) {
    reasons.push(
      "AUTH_SECRET is not set. A public deployment must sign its session tokens with a secret it chose; refusing to fall back to the value shipped in the source."
    );
  }
  if (isPublic && secretFromEnvironment) {
    if (rawSecret.length < MIN_PUBLIC_SECRET_LENGTH) {
      reasons.push(
        `AUTH_SECRET is only ${rawSecret.length} characters. Use at least ${MIN_PUBLIC_SECRET_LENGTH} (for example 32 bytes of base64 from a random generator).`
      );
    }
    if (KNOWN_DEMO_SECRETS.includes(rawSecret)) {
      reasons.push(
        "AUTH_SECRET is one of the values published in the source. Choose a different one."
      );
    }
  }

  const ownerPassword = trimmed(env.AUTH_DEFAULT_OWNER_PASSWORD);
  const viewerPassword = trimmed(env.AUTH_DEFAULT_VIEWER_PASSWORD);

  if (isPublic) {
    // A public deployment may only ever create an administrator from a
    // password an operator typed. The check runs at start-up rather than at
    // the first request, because "what would happen on a fresh machine" has to
    // be answered before the machine is in service.
    if (ownerPassword.length === 0) {
      reasons.push(
        "AUTH_DEFAULT_OWNER_PASSWORD is not set. A public deployment may not create the first administrator with the password shipped in the source."
      );
    } else if (ownerPassword.length < MIN_INITIAL_PASSWORD_LENGTH) {
      reasons.push(
        `AUTH_DEFAULT_OWNER_PASSWORD is only ${ownerPassword.length} characters. Use at least ${MIN_INITIAL_PASSWORD_LENGTH}.`
      );
    }
    if (
      viewerPassword.length > 0 &&
      viewerPassword.length < MIN_INITIAL_PASSWORD_LENGTH
    ) {
      reasons.push(
        `AUTH_DEFAULT_VIEWER_PASSWORD is only ${viewerPassword.length} characters. Use at least ${MIN_INITIAL_PASSWORD_LENGTH}, or leave it unset.`
      );
    }
  }

  // Everything is reported at once: an operator fixing these one restart at a
  // time is a worse experience than reading the whole list in one refusal.
  if (reasons.length > 0) {
    throw new AuthConfigurationError(
      "Refusing to start: this deployment is public but its authentication configuration is not safe to use.",
      reasons
    );
  }

  let defaultOwnerPassword: string | null;
  let defaultViewerPassword: string | null;
  if (isPublic) {
    defaultOwnerPassword = ownerPassword;
    // A viewer account is optional; when it is not asked for, it is not
    // created, rather than being created with a published password.
    defaultViewerPassword = viewerPassword.length > 0 ? viewerPassword : null;
  } else {
    defaultOwnerPassword =
      ownerPassword.length > 0 ? ownerPassword : LOCAL_DEMO_OWNER_PASSWORD;
    defaultViewerPassword =
      viewerPassword.length > 0 ? viewerPassword : LOCAL_DEMO_VIEWER_PASSWORD;
  }

  return {
    mode: isPublic ? "public" : "local-demo",
    usersPath: trimmed(env.AUTH_USERS_PATH) || defaults.usersPath,
    secret: secretFromEnvironment ? rawSecret : LOCAL_DEMO_SECRET,
    secretFromEnvironment,
    defaultOwnerPassword,
    defaultViewerPassword,
    allowDemoBootstrap: !isPublic || defaultOwnerPassword !== null,
    secureCookies: resolveSecureCookies(env, isPublic)
  };
}
