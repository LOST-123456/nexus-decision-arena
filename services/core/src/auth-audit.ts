/**
 * Login audit trail.
 *
 * Every authentication decision that a deployment might later have to explain
 * — a successful sign-in, a rejected one, a throttled one — is recorded here
 * as one structured line. Two rules are load-bearing:
 *
 * 1. **No credential is ever recorded.** Not the password, not a hash of it,
 *    not a prefix of it. The username is recorded because that is what an
 *    investigator needs to correlate an account with the attempts against it.
 * 2. **The sink is injected.** The default writes to stdout so a container
 *    captures it, but a test passes its own sink and asserts on the events
 *    rather than on console noise.
 */

export type AuthAuditEventType =
  | "login_succeeded"
  | "login_failed"
  | "login_throttled"
  | "user_created";

export type AuthAuditEvent = {
  type: AuthAuditEventType;
  /** The account name that was submitted. Never a password. */
  username: string;
  /** Where the attempt came from, as the transport reported it. */
  ip: string;
  at: string;
  /** Why an attempt was rejected, in words an operator can act on. */
  reason?: string;
  /** Seconds the caller is asked to wait before retrying. */
  retryAfterSeconds?: number;
};

export type AuthAuditSink = (event: AuthAuditEvent) => void;

export type AuthAuditRecorder = (
  type: AuthAuditEventType,
  details: {
    username: string;
    ip: string;
    reason?: string;
    retryAfterSeconds?: number;
  }
) => void;

export function createConsoleAuditSink(
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`)
): AuthAuditSink {
  return (event) => {
    try {
      write(JSON.stringify(event));
    } catch {
      // The audit trail must never be the reason a login fails.
    }
  };
}

export function createAuditRecorder(
  sink: AuthAuditSink,
  now: () => Date = () => new Date()
): AuthAuditRecorder {
  return (type, details) => {
    sink({
      type,
      username: details.username,
      ip: details.ip,
      at: now().toISOString(),
      ...(details.reason === undefined ? {} : { reason: details.reason }),
      ...(details.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: details.retryAfterSeconds })
    });
  };
}
