/**
 * Shared browser -> core transport.
 *
 * Why this exists: a bare `fetch` has no timeout, and a refused connection
 * surfaces as an opaque "Failed to fetch" (or, through the Next rewrite, as a
 * bare `Request failed: 500`). Both leave the operator watching a spinner with
 * no way to tell "the service is down" from "the request is slow" from "the
 * server refused this". Every request in the app goes through here so the UI
 * can tell those apart and say what to do next.
 *
 * Conventions carried over from the hand-rolled clients this replaces:
 * - a body-less POST must NOT declare a JSON content-type, or the API answers
 *   400 before the route is ever reached;
 * - `idempotency-key` is forwarded verbatim;
 * - nothing is cached (`cache: "no-store"` stays the caller's choice).
 */

export type ApiTransportErrorKind = "unavailable" | "timeout" | "http";

export class ApiTransportError extends Error {
  /** Which layer failed, so the UI can pick the right recovery. */
  readonly kind: ApiTransportErrorKind;
  /** HTTP status when `kind === "http"`, otherwise null. */
  readonly status: number | null;
  /** Parsed response body when there was one, otherwise null. */
  readonly payload: Record<string, unknown> | null;

  constructor(
    kind: ApiTransportErrorKind,
    message: string,
    options: {
      status?: number | null;
      payload?: Record<string, unknown> | null;
    } = {}
  ) {
    super(message);
    this.name = "ApiTransportError";
    this.kind = kind;
    this.status = options.status ?? null;
    this.payload = options.payload ?? null;
  }
}

/** Long enough for a slow agent run, short enough that nobody stares forever. */
export const DEFAULT_TIMEOUT_MS = 30_000;

export type FetchJsonInit = RequestInit & {
  idempotencyKey?: string;
  timeoutMs?: number;
};

function unavailableMessage(): string {
  return "无法连接到核心 API。请确认服务仍在运行，然后重新检查。";
}

function timeoutMessage(timeoutMs: number): string {
  const seconds = Math.max(1, Math.round(timeoutMs / 1000));
  return `请求超时（${seconds} 秒）。核心 API 可能繁忙或已停止响应，请稍后重试。`;
}

function httpFallbackMessage(status: number): string {
  if (status >= 500) {
    return `核心 API 返回 ${status} 错误。请确认服务正常运行后重试。`;
  }
  if (status === 404) {
    return "未找到请求的资源（404）。";
  }
  if (status === 401 || status === 403) {
    return `没有权限执行该操作（${status}）。请重新登录或联系管理员。`;
  }
  return `请求失败（${status}）。`;
}

/**
 * Performs one JSON request and either returns the parsed body or throws an
 * `ApiTransportError` whose message is already safe to show an operator.
 */
export async function fetchJson<T>(
  url: string,
  init: FetchJsonInit = {}
): Promise<T> {
  const { idempotencyKey, timeoutMs, ...rest } = init;
  const effectiveTimeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Same rule the hand-rolled clients followed: a POST with no body must not
  // claim a JSON content-type.
  const hasBody = rest.body !== undefined && rest.body !== null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), effectiveTimeout);

  let response: Response;
  try {
    response = await fetch(url, {
      ...rest,
      signal: controller.signal,
      headers: {
        ...(hasBody ? { "content-type": "application/json" } : {}),
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
        ...(rest.headers ?? {})
      }
    });
  } catch (error) {
    // Our own timer fired: the request was too slow, not the service absent.
    if (controller.signal.aborted) {
      throw new ApiTransportError("timeout", timeoutMessage(effectiveTimeout));
    }
    // A caller-supplied abort is theirs to handle; pass it through untouched.
    if (error instanceof Error && error.name === "AbortError") {
      throw error;
    }
    throw new ApiTransportError("unavailable", unavailableMessage());
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    const serverMessage =
      typeof payload?.message === "string"
        ? payload.message
        : typeof payload?.error === "string"
          ? payload.error
          : null;
    throw new ApiTransportError(
      "http",
      serverMessage ?? httpFallbackMessage(response.status),
      { status: response.status, payload }
    );
  }

  // A 204 (or any empty body) is a valid success; `response.json()` would
  // throw a SyntaxError on it.
  const text = await response.text();
  if (!text) {
    return null as T;
  }
  return JSON.parse(text) as T;
}
