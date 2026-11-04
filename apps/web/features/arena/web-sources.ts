import type { ExecutionEvent } from "@nexus/shared";

/**
 * 检索到的候选来源，从事件流里读回来。
 *
 * 为什么不留在提示词里：一段查过但没留下痕迹的检索，事后没人能回答"这条
 * 质询是看了什么才问出来的"。落成事件之后，审计包、页面和材料面板读的是
 * 同一份记录。
 *
 * 强调"候选"：这些条目**不是证据**。采用它们只是把它变成一条待核实的材料，
 * `verificationStatus` 仍然是 unverified，覆盖率不会因为它动一分。
 */
export type WebSourceCandidate = {
  url: string;
  title: string;
  snippet: string;
  /** 哪条质询用它问出来的。 */
  challengeId: string;
  /** 当时实际发出去的检索词。 */
  query: string;
};

type RawEvent = Pick<ExecutionEvent, "type" | "payload">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

export function collectWebSources(events: readonly RawEvent[]): WebSourceCandidate[] {
  const seen = new Set<string>();
  const candidates: WebSourceCandidate[] = [];
  for (const event of events) {
    if (event.type !== "WEB_SOURCES_FOUND") continue;
    const payload = event.payload;
    if (!isRecord(payload)) continue;
    const sources = Array.isArray(payload.sources) ? payload.sources : [];
    const challengeId =
      typeof payload.challengeId === "string" ? payload.challengeId : "";
    const query = typeof payload.query === "string" ? payload.query : "";
    for (const raw of sources) {
      if (!isRecord(raw)) continue;
      const url = typeof raw.url === "string" ? raw.url : "";
      if (url === "" || seen.has(url)) continue;
      seen.add(url);
      candidates.push({
        url,
        title: typeof raw.title === "string" && raw.title !== "" ? raw.title : url,
        snippet: typeof raw.snippet === "string" ? raw.snippet : "",
        challengeId,
        query
      });
    }
  }
  return candidates;
}
