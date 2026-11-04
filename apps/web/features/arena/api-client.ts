import {
  DEFAULT_PAGE_LIMIT,
  ExecutionEventTypeSchema,
  SESSION_PHASES,
  type ClaimInspectorDTO,
  type ExecutionEvent,
  type HumanDecision,
  type SessionMaterial,
  type SessionPhase,
  type SessionView
} from "@nexus/shared";
import { ApiTransportError, fetchJson } from "../../lib/api-transport";
import type { ReplayableSession } from "./event-reducer";

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "";

export type CreateSessionCommand = {
  project: {
    name: string;
    summary: string;
    targetUsers: string;
    businessModel: string;
    expectedData: string;
  };
  locale: "zh-CN" | "en-US";
  /** The question this research has to answer. */
  researchQuestion?: string;
};

export type CreatedSession = {
  id: string;
};

export type RuntimeInfo = {
  mode: "mock" | "openai-compatible";
  provider: string;
  model: string;
  /** 是否已经在「模型设置」里配好了真实模型。 */
  configured?: boolean;
  /**
   * 现在是否允许发起分析。为 false 时新建评审和提炼主张都必须拦住并解释，
   * 不能退回去跑固定样例——那会给出一个跟用户项目无关的结论。
   */
  canRunAnalysis?: boolean;
  /**
   * 这一轮到底有没有联网。
   *
   * `enabled: false` 不是"没找到结果"，是"根本没接检索服务"。两者混为一谈，
   * 用户就会以为系统替他查过了。
   */
  search?: { enabled: boolean; provider: string; note: string };
};

/**
 * Why a research is in the list you are looking at.
 *
 * Not a permission level — every value means "readable". It is the *reason*,
 * and a list groups by it: 我创建的 and 别人共享给我的 are one permission and
 * two different facts, and the second is the one that decides what you open.
 */
export type SessionRelation =
  | "owner"
  | "collaborator"
  | "granted"
  | "unowned";

export type SessionSummary = {
  id: string;
  projectId: string;
  projectName: string;
  phase: string;
  operationalStatus: string;
  currentConclusion: string | null;
  conflictCount: number;
  createdAt: string;
  updatedAt: string;
  /**
   * `null` when the deployment runs without identities: an operator has no
   * "other people" to separate, so there is nothing to group by and the list
   * is rendered flat rather than inventing an author.
   */
  relation: SessionRelation | null;
};

export type AuthUser = {
  id: string;
  username: string;
  displayName: string;
  role: "owner" | "reviewer" | "viewer";
};


type SessionPayload = Partial<SessionView> & {
  id?: string;
  nextEventSequence?: number;
  lastSequence?: number;
};

export type HumanDecisionCommand = Pick<
  HumanDecision,
  | "conflictId"
  | "action"
  | "rationale"
  | "affectedClaimIds"
  | "affectedAgentRoleIds"
  | "newConclusion"
  | "operatorId"
>;

export type HumanDecisionResponse = {
  session: SessionPayload & { id: string };
  decision: HumanDecision;
  event: ExecutionEvent;
};

/**
 * Live connection state of the execution-event stream.
 *
 * `polling` is not a failure: the stream is open, but nothing is coming through
 * it, so the timeline is being fed by the fallback poll instead. It exists so
 * the page can say "progress refreshes periodically" instead of pretending the
 * silence is a quiet session.
 */
export type EventStreamStatus = "connecting" | "open" | "error" | "polling";

function isSessionPhase(value: unknown): value is SessionPhase {
  return (
    typeof value === "string" &&
    SESSION_PHASES.includes(value as SessionPhase)
  );
}

function normalizeSession(
  payload: SessionPayload,
  fallbackSessionId: string
): ReplayableSession {
  const persistedSequence =
    payload.lastSequence ??
    (typeof payload.nextEventSequence === "number"
      ? Math.max(0, payload.nextEventSequence - 1)
      : 0);

  return {
    sessionId: payload.sessionId ?? payload.id ?? fallbackSessionId,
    phase: isSessionPhase(payload.phase) ? payload.phase : "CREATED",
    operationalStatus:
      payload.operationalStatus === "PAUSED" ||
      payload.operationalStatus === "FAILED" ||
      payload.operationalStatus === "COMPLETED"
        ? payload.operationalStatus
        : "ACTIVE",
    agents: payload.agents ?? [],
    claims: payload.claims ?? [],
    evidence: payload.evidence ?? [],
    challenges: payload.challenges ?? [],
    conflicts: payload.conflicts ?? [],
    humanDecisions: payload.humanDecisions ?? [],
    currentConclusion:
      typeof payload.currentConclusion === "string"
        ? payload.currentConclusion
        : null,
    lastSequence: persistedSequence
  };
}

export async function createSession(
  command: CreateSessionCommand,
  idempotencyKey: string
): Promise<CreatedSession> {
  const payload = await fetchJson<CreatedSession>(`${apiUrl}/api/sessions`, {
    method: "POST",
    body: JSON.stringify(command),
    idempotencyKey
  });
  if (!payload.id) {
    throw new Error("Create session response did not contain an id");
  }
  return payload;
}

export async function startSession(
  sessionId: string,
  idempotencyKey: string
): Promise<{ id: string; status: string }> {
  return fetchJson<{ id: string; status: string }>(
    `${apiUrl}/api/sessions/${encodeURIComponent(sessionId)}/start`,
    {
      method: "POST",
      body: "{}",
      idempotencyKey
    }
  );
}

export async function getRuntimeInfo(): Promise<RuntimeInfo> {
  return fetchJson<RuntimeInfo>(`${apiUrl}/api/runtime`, { cache: "no-store" });
}

/**
 * 「我是谁」这件事，一次页面加载只该问一次。
 *
 * 页头徽标、最近会话、工作区、材料面板各自在挂载时问一遍，打开一个会话
 * 就会并发打四五个相同的 /api/auth/me；未登录时它们全是 401，控制台刷出
 * 一排红字，看着像接口坏了。这里做两件事：并发请求合并成一次（单飞），
 * 以及极短的缓存（组件逐个挂载时不至于各打一次）。
 */
const CURRENT_USER_TTL_MS = 2_000;
let currentUserInFlight: Promise<AuthUser | null> | null = null;
let currentUserCache: { user: AuthUser | null; at: number } | null = null;

/** 登录 / 登出之后必须作废——否则换账号后两秒内页头还挂着上一个人。 */
export function invalidateCurrentUser(): void {
  currentUserCache = null;
  currentUserInFlight = null;
}

export async function getCurrentUser(options?: {
  /** 忽略缓存重新问一次（例如用户刚切换账号）。 */
  force?: boolean;
}): Promise<AuthUser | null> {
  if (options?.force !== true && currentUserCache !== null) {
    if (Date.now() - currentUserCache.at < CURRENT_USER_TTL_MS) {
      return currentUserCache.user;
    }
  }
  if (currentUserInFlight !== null) {
    return currentUserInFlight;
  }

  const request = (async () => {
    try {
      return await fetchJson<AuthUser>(`${apiUrl}/api/auth/me`, {
        cache: "no-store"
      });
    } catch (error) {
      // Anonymous is the normal answer here, not a failure.
      if (error instanceof ApiTransportError && error.status === 401) {
        return null;
      }
      throw error;
    }
  })();

  currentUserInFlight = request;
  try {
    const user = await request;
    currentUserCache = { user, at: Date.now() };
    return user;
  } finally {
    currentUserInFlight = null;
  }
}

export async function login(username: string, password: string): Promise<AuthUser> {
  const user = await fetchJson<AuthUser>(`${apiUrl}/api/auth/login`, {
    method: "POST",
    body: JSON.stringify({ username, password })
  });
  invalidateCurrentUser();
  return user;
}

export async function logout(): Promise<void> {
  try {
    await fetchJson<null>(`${apiUrl}/api/auth/logout`, { method: "POST" });
  } finally {
    invalidateCurrentUser();
  }
}

export async function listUsers(): Promise<AuthUser[]> {
  return fetchJson<AuthUser[]>(`${apiUrl}/api/auth/users`, { cache: "no-store" });
}

export async function createUser(command: { username: string; displayName: string; role: AuthUser["role"]; password: string; }): Promise<AuthUser> {
  return fetchJson<AuthUser>(`${apiUrl}/api/auth/users`, {
    method: "POST",
    body: JSON.stringify(command)
  });
}

/**
 * The caller's readable sessions, newest activity first — one page at a time.
 *
 * The cursor is the server's own opaque token: the list is ordered by
 * `(updated_at, id)`, so a client cannot compute the next window itself and
 * must hand the previous `nextCursor` back untouched. That is deliberate —
 * it keeps the tie-break rule in one place instead of in every caller.
 */
export async function listSessions(
  page: { limit?: number; after?: string; relation?: SessionRelation } = {}
): Promise<SessionPage> {
  const query = new URLSearchParams();
  if (page.limit !== undefined) query.set("limit", String(page.limit));
  if (page.after !== undefined) query.set("after", page.after);
  // Narrowed on the server, not here. Filtering an already-fetched page would
  // answer "none shared with you" from whichever fifty rows happened to load.
  if (page.relation !== undefined) query.set("relation", page.relation);
  const suffix = query.toString() === "" ? "" : `?${query.toString()}`;
  return fetchJson<SessionPage>(`${apiUrl}/api/sessions${suffix}`, {
    cache: "no-store"
  });
}

export type SessionPage = {
  sessions: SessionSummary[];
  nextCursor: string | null;
  hasNextPage: boolean;
};

export async function deleteSession(sessionId: string): Promise<void> {
  await fetchJson<null>(
    `${apiUrl}/api/sessions/${encodeURIComponent(sessionId)}`,
    { method: "DELETE" }
  );
}

export async function getSession(
  sessionId: string
): Promise<ReplayableSession> {
  const payload = await fetchJson<SessionPayload>(
    `${apiUrl}/api/sessions/${encodeURIComponent(sessionId)}`,
    { cache: "no-store" }
  );
  return normalizeSession(payload, sessionId);
}

export async function getInspector(
  sessionId: string,
  claimId: string
): Promise<ClaimInspectorDTO> {
  return fetchJson<ClaimInspectorDTO>(
    `${apiUrl}/api/sessions/${encodeURIComponent(sessionId)}/claims/${encodeURIComponent(claimId)}/inspector`,
    { cache: "no-store" }
  );
}

export async function getEvents(
  sessionId: string
): Promise<ExecutionEvent[]> {
  return fetchJson<ExecutionEvent[]>(
    `${apiUrl}/api/sessions/${encodeURIComponent(sessionId)}/events`,
    { cache: "no-store" }
  );
}

export async function submitHumanDecision(
  sessionId: string,
  command: HumanDecisionCommand,
  idempotencyKey: string
): Promise<HumanDecisionResponse> {
  return fetchJson<HumanDecisionResponse>(
    `${apiUrl}/api/sessions/${encodeURIComponent(sessionId)}/human-decisions`,
    {
      method: "POST",
      body: JSON.stringify(command),
      idempotencyKey
    }
  );
}

/**
 * 读取这次评审已经登记的人工材料。
 *
 * 材料是"再跑一轮"的前提，所以列表面板必须能自己刷，不依赖 SSE 是否在线：
 * 事件流断开时仍然要能看见自己交过什么。
 */
export async function listMaterials(
  sessionId: string
): Promise<{ materials: SessionMaterial[] }> {
  return fetchJson<{ materials: SessionMaterial[] }>(
    `${apiUrl}/api/sessions/${encodeURIComponent(sessionId)}/materials`
  );
}

/** 交一份材料。它会被写进事件流，因此不可改写、不可删除。 */
export async function addMaterial(
  sessionId: string,
  material: { title: string; content: string },
  idempotencyKey: string
): Promise<{ material: SessionMaterial }> {
  return fetchJson<{ material: SessionMaterial }>(
    `${apiUrl}/api/sessions/${encodeURIComponent(sessionId)}/materials`,
    {
      method: "POST",
      body: JSON.stringify(material),
      idempotencyKey
    }
  );
}

/**
 * 巡检间隔。SSE 正常时这一步几乎每次都拿不到东西，代价是一次很小的 GET；
 * SSE 被中间层攒住时，它就是唯一的数据来源。
 */
const STREAM_POLL_INTERVAL_MS = 2000;

/**
 * 连续几轮"只有轮询拿到了事件"才敢说实时那条路没在工作。
 *
 * 不按墙上时钟判断有两个原因：一是测试里时钟不可靠，二是时间长短本来就不
 * 是证据——事件真的只从轮询来，才是证据。
 */
const SILENT_POLLS_BEFORE_REPORT = 3;

/**
 * Opens the execution-event stream.
 *
 * `onStatus` reports the browser's own view of the connection. The browser
 * reconnects by itself, so "error" is a status to show ("live updates paused,
 * reconnecting"), never a reason to tear the subscription down — silently
 * stopping the timeline is how a dead stream looks like a quiet session.
 *
 * 为什么还要一条轮询：
 *
 * 经 Cloudflare 快速隧道访问时，`text/event-stream` 会被隧道整段攒住。实测
 * 同一条流：本机 13ms 收到 108 条事件；经隧道 12 秒仍是 0 字节，40 秒仍是
 * 0 字节。EventSource 于是"连上了、没消息"，页面看着像卡死，用户只能刷新。
 *
 * 服务端的心跳救不了这个场景——它是 `: heartbeat` 注释，EventSource 不会把
 * 注释交给业务回调，客户端根本看不见。所以这里不猜：连上之后每两秒用普通
 * GET（`?after=<游标>`）问一次，普通请求不受隧道缓冲影响。两条通道送的是
 * 同一批事件，序号去重由 `deliver` 统一负责。
 */
export function subscribeToEvents(
  sessionId: string,
  lastEventId: number,
  onEvent: (event: ExecutionEvent) => void,
  onStatus?: (status: EventStreamStatus) => void
): () => void {
  const url = new URL(
    `${apiUrl}/api/sessions/${encodeURIComponent(sessionId)}/events/stream`,
    window.location.origin
  );
  if (lastEventId > 0) {
    url.searchParams.set("after", String(lastEventId));
  }

  const source = new EventSource(url);
  const delivered = new Set<number>();
  let cursor = lastEventId;
  let closed = false;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let pollScheduled = false;
  /** 自上一轮巡检以来，流有没有亲自送过事件。 */
  let streamDeliveredSincePoll = false;
  /** 连续多少轮事件只从巡检来。 */
  let pollsCarriedTheStream = 0;

  /** 流和巡检会送来重复事件（重放 + 轮询重叠），序号去重只做在这一处。 */
  const deliver = (event: ExecutionEvent): void => {
    if (closed) return;
    if (typeof event.sequence === "number") {
      if (delivered.has(event.sequence)) return;
      delivered.add(event.sequence);
      if (event.sequence > cursor) cursor = event.sequence;
    }
    onEvent(event);
  };

  const schedulePoll = (): void => {
    if (closed || pollScheduled) return;
    pollScheduled = true;
    pollTimer = setTimeout(runPoll, STREAM_POLL_INTERVAL_MS);
  };

  const runPoll = async (): Promise<void> => {
    pollScheduled = false;
    if (closed) return;
    try {
      const events = await fetchJson<ExecutionEvent[]>(
        `${apiUrl}/api/sessions/${encodeURIComponent(sessionId)}/events?after=${cursor}`,
        { cache: "no-store" }
      );
      if (Array.isArray(events) && events.length > 0) {
        for (const event of events) deliver(event);
        pollsCarriedTheStream = streamDeliveredSincePoll
          ? 0
          : pollsCarriedTheStream + 1;
        streamDeliveredSincePoll = false;
        if (pollsCarriedTheStream >= SILENT_POLLS_BEFORE_REPORT) {
          onStatus?.("polling");
        }
      }
    } catch {
      /*
       * 一次问不到不算结论，下一轮继续。真正的失败由页面状态条体现，
       * 这里把错误也抛出去只会变成没人处理的 rejection。
       */
    }
    schedulePoll();
  };

  const listener = (message: MessageEvent<string>): void => {
    streamDeliveredSincePoll = true;
    deliver(JSON.parse(message.data) as ExecutionEvent);
  };
  for (const eventType of ExecutionEventTypeSchema.options) {
    source.addEventListener(eventType, listener as EventListener);
  }
  source.onopen = (): void => {
    onStatus?.("open");
    // 只有连上之后才值得巡检：还没连上时问一次说明不了任何问题。
    schedulePoll();
  };
  source.onerror = (): void => {
    onStatus?.("error");
    // 浏览器自己会重连；重连期间让巡检顶上，别让时间线停在这一刻。
    schedulePoll();
  };

  return () => {
    closed = true;
    if (pollTimer !== undefined) clearTimeout(pollTimer);
    for (const eventType of ExecutionEventTypeSchema.options) {
      source.removeEventListener(eventType, listener as EventListener);
    }
    source.onopen = null;
    source.onerror = null;
    source.close();
  };
}
