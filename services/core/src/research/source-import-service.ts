import type { EvidenceRepository } from "@nexus/db";
import { SourceNotFoundError, SourceTitleConflictError } from "@nexus/db";
import type { Evidence, Source, SourceSnapshot } from "@nexus/shared";
import { planExcerptAnchor, recheckExcerpt } from "./excerpt-anchor";
import { PageFetchError, type FetchedPage } from "./page-fetch";
import { canonicalizeUrl, parseTargetUrl, TargetRefusedError } from "./ssrf-guard";

/**
 * The importer: one url in, one registered source with a stored capture out.
 *
 * Two rules shape everything here:
 *
 *  1. A failed retrieval is still recorded. The workspace has to be able to say
 *     "we tried to read this page and here is why it did not work", so the
 *     source row is written before the outcome is reported and the error is
 *     persisted with an attempt count.
 *  2. Importing never asserts anything about truth. It stores text, metadata
 *     and a content hash. Whether an excerpt from that text is verified is a
 *     separate, human act performed somewhere else entirely.
 */

export class SourceImportError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly httpStatus: number
  ) {
    super(message);
    this.name = "SourceImportError";
  }
}

export type SourceImportOutcome = {
  source: Source;
  snapshot: SourceSnapshot | null;
  /** True when this capture is a content version that was not stored before. */
  versionCreated: boolean;
  /** True when a row for this page already existed and was refreshed. */
  reused: boolean;
  truncated: boolean;
  redirects: string[];
  finalUrl: string;
};

export type RecheckOutcome = {
  /** Excerpts that carried an anchor and could be checked. */
  checked: number;
  anchored: number;
  missing: number;
  /** Excerpts whose stored state already matched, so nothing was written. */
  unchanged: number;
  /** Excerpts with no anchor or no capture to check against. */
  skipped: number;
  items: Array<{
    evidenceId: string;
    title: string;
    locatorStatus: Evidence["locatorStatus"];
    verificationStatus: Evidence["verificationStatus"];
    locator: string | null;
    current: boolean;
  }>;
};

type IntakeRepository = Pick<
  EvidenceRepository,
  | "createSource"
  | "findSourceByCanonicalUrl"
  | "recordRetrievalSuccess"
  | "recordRetrievalFailure"
  | "getSource"
  | "getCurrentSnapshot"
  | "listSnapshots"
  | "listEvidenceForSource"
  | "updateEvidence"
>;

export class SourceImportService {
  constructor(
    private readonly dependencies: {
      evidence: IntakeRepository;
      fetch: (url: string) => Promise<FetchedPage>;
      now?: () => Date;
    }
  ) {}

  private now(): Date {
    return this.dependencies.now?.() ?? new Date();
  }

  /**
   * Imports a url, or refreshes the row that already represents it.
   *
   * The ids are supplied by the caller so they are derived from the idempotency
   * key: a retried request writes the same rows rather than duplicates.
   */
  async importUrl(input: {
    sessionId: string;
    url: string;
    title?: string | undefined;
    actor: string;
    sourceId: string;
    snapshotId: string;
  }): Promise<SourceImportOutcome> {
    // Validated before anything else: a url that is not http(s) is not a page
    // request at all, so it is refused without writing a source row. A target
    // that *is* page-shaped but points somewhere unsafe is refused inside the
    // fetch instead, and that attempt is recorded — we did try to read a page.
    let requested;
    try {
      requested = parseTargetUrl(input.url);
    } catch (cause) {
      const refusal = describeFetchFailure(cause);
      throw new SourceImportError(
        refusal.message,
        refusal.code,
        refusal.httpStatus
      );
    }
    const canonicalUrl = canonicalizeUrl(requested);

    const existing = await this.dependencies.evidence.findSourceByCanonicalUrl(
      input.sessionId,
      canonicalUrl
    );

    let page: FetchedPage;
    try {
      page = await this.dependencies.fetch(canonicalUrl);
    } catch (cause) {
      throw await this.recordFailure(input, existing, canonicalUrl, cause);
    }

    const retrievedAt = page.retrievedAt;
    const snapshot: SourceSnapshot = {
      id: input.snapshotId,
      sessionId: input.sessionId,
      sourceId: existing?.id ?? input.sourceId,
      canonicalUrl: page.canonicalUrl,
      contentHash: page.contentHash,
      contentType: page.contentType,
      content: page.content,
      contentBytes: page.contentBytes,
      charCount: page.charCount,
      retrievedAt,
      createdAt: this.now().toISOString(),
      ...(page.title ? { title: page.title } : {}),
      ...(page.author ? { author: page.author } : {}),
      ...(page.publisher ? { publisher: page.publisher } : {}),
      ...(page.publishedAt ? { publishedAt: page.publishedAt } : {})
    };

    const target = existing ?? (await this.registerSource(input, page, canonicalUrl));
    const recorded = await this.dependencies.evidence.recordRetrievalSuccess({
      snapshot: { ...snapshot, sourceId: target.id },
      source: {
        ...(page.author ? { author: page.author } : {}),
        ...(page.publisher ? { publisher: page.publisher } : {}),
        ...(page.publishedAt ? { publishedAt: page.publishedAt } : {})
      },
      event: {
        correlationId: target.id,
        type: "SOURCE_RETRIEVED",
        payload: {
          sourceId: target.id,
          canonicalUrl: page.canonicalUrl,
          contentType: page.contentType,
          contentHash: page.contentHash,
          charCount: page.charCount,
          redirectCount: page.redirects.length,
          truncated: page.truncated,
          importedBy: input.actor
        }
      }
    });

    return {
      source: recorded.source,
      snapshot: recorded.snapshot,
      versionCreated: recorded.created,
      reused: existing !== null,
      truncated: page.truncated,
      redirects: page.redirects,
      finalUrl: page.finalUrl
    };
  }

  /** Creates the row for a page that has no source yet. */
  private async registerSource(
    input: { sessionId: string; actor: string; sourceId: string },
    page: FetchedPage,
    canonicalUrl: string
  ): Promise<Source> {
    const now = this.now().toISOString();
    const pageTitle = page.title?.trim();
    const draft: Source = {
      id: input.sourceId,
      sessionId: input.sessionId,
      // The page title is a better label than the url, but the url is a
      // truthful fallback when the page declares none.
      title: (pageTitle && pageTitle.length > 0
        ? pageTitle
        : canonicalUrl
      ).slice(0, 240),
      kind: "url",
      url: canonicalUrl,
      canonicalUrl,
      retrievalStatus: "pending",
      retrievalAttempts: 0,
      createdBy: "human",
      createdAt: now,
      updatedAt: now
    };
    const event = {
      correlationId: draft.id,
      type: "SOURCE_REGISTERED" as const,
      payload: {
        sourceId: draft.id,
        kind: "url",
        url: canonicalUrl,
        registeredBy: input.actor
      }
    };

    try {
      const created = await this.dependencies.evidence.createSource(draft, event);
      return created.source;
    } catch (error) {
      if (!(error instanceof SourceTitleConflictError)) throw error;
      // An unrelated source already uses this title; the url still identifies
      // the page uniquely, so fall back to it rather than failing an import
      // that is otherwise perfectly valid.
      const fallback = await this.dependencies.evidence.createSource(
        { ...draft, title: canonicalUrl.slice(0, 240) },
        event
      );
      return fallback.source;
    }
  }

  /**
   * Persists why a retrieval failed and returns the error the route should
   * report. The row is written first, so a page that cannot be read still
   * leaves a trace a researcher can act on.
   */
  private async recordFailure(
    input: { sessionId: string; actor: string; sourceId: string },
    existing: Source | null,
    canonicalUrl: string,
    cause: unknown
  ): Promise<SourceImportError> {
    const failure = describeFetchFailure(cause);
    const attemptedAt = this.now().toISOString();

    let sourceId = existing?.id ?? null;
    if (sourceId === null) {
      const registered = await this.dependencies.evidence.createSource(
        {
          id: input.sourceId,
          sessionId: input.sessionId,
          title: canonicalUrl.slice(0, 240),
          kind: "url",
          url: canonicalUrl,
          canonicalUrl,
          retrievalStatus: "pending",
          retrievalAttempts: 0,
          createdBy: "human",
          createdAt: attemptedAt,
          updatedAt: attemptedAt
        },
        {
          correlationId: input.sourceId,
          type: "SOURCE_REGISTERED",
          payload: {
            sourceId: input.sourceId,
            kind: "url",
            url: canonicalUrl,
            registeredBy: input.actor,
            pendingRetrieval: true
          }
        }
      ).catch((error: unknown) => {
        // A title clash with an unrelated source must not hide the real
        // failure; fall back to a distinguishable title.
        if (error instanceof SourceTitleConflictError) return null;
        throw error;
      });
      sourceId = registered?.source.id ?? null;
      if (sourceId === null) {
        const fallback = await this.dependencies.evidence.createSource({
          id: input.sourceId,
          sessionId: input.sessionId,
          title: `${canonicalUrl} (无法抓取)`.slice(0, 240),
          kind: "url",
          url: canonicalUrl,
          canonicalUrl,
          retrievalStatus: "pending",
          retrievalAttempts: 0,
          createdBy: "human",
          createdAt: attemptedAt,
          updatedAt: attemptedAt
        });
        sourceId = fallback.source.id;
      }
    }

    await this.dependencies.evidence.recordRetrievalFailure({
      sessionId: input.sessionId,
      sourceId,
      error: failure.message,
      attemptedAt,
      event: {
        correlationId: sourceId,
        type: "SOURCE_RETRIEVAL_FAILED",
        payload: {
          sourceId,
          canonicalUrl,
          code: failure.code,
          message: failure.message,
          attemptedBy: input.actor
        }
      }
    });

    return new SourceImportError(failure.message, failure.code, failure.httpStatus);
  }

  /**
   * Re-checks every excerpt of a source against its current capture.
   *
   * This is what turns a silent page edit into a visible problem: excerpts
   * whose anchor is gone are marked `missing`, and excerpts that are still
   * present are re-anchored to the current version. Verification status is
   * never touched — a locator is not a verdict.
   */
  async recheckExcerpts(input: {
    sessionId: string;
    sourceId: string;
    actor: string;
  }): Promise<RecheckOutcome> {
    const source = await this.dependencies.evidence.getSource(
      input.sessionId,
      input.sourceId
    );
    if (!source) {
      throw new SourceNotFoundError(input.sourceId);
    }
    const snapshot = await this.dependencies.evidence.getCurrentSnapshot(
      input.sessionId,
      input.sourceId
    );
    const excerpts = await this.dependencies.evidence.listEvidenceForSource(
      input.sessionId,
      input.sourceId
    );

    const outcome: RecheckOutcome = {
      checked: 0,
      anchored: 0,
      missing: 0,
      unchanged: 0,
      skipped: 0,
      items: []
    };

    for (const excerpt of excerpts) {
      const plan = recheckExcerpt({
        content: snapshot?.content ?? null,
        contentHash: snapshot?.contentHash ?? null,
        anchorText: excerpt.anchorText ?? null,
        typedLocator: excerpt.locator ?? null
      });

      if (plan === null) {
        outcome.skipped += 1;
        outcome.items.push({
          evidenceId: excerpt.id,
          title: excerpt.title,
          locatorStatus: excerpt.locatorStatus,
          verificationStatus: excerpt.verificationStatus,
          locator: excerpt.locator ?? null,
          current: false
        });
        continue;
      }

      outcome.checked += 1;
      if (plan.locatorStatus === "anchored") outcome.anchored += 1;
      else outcome.missing += 1;

      const alreadyCurrent =
        excerpt.locatorStatus === plan.locatorStatus &&
        (excerpt.locator ?? null) === plan.locator &&
        (excerpt.sourceContentHash ?? null) === plan.sourceContentHash;

      if (alreadyCurrent) {
        outcome.unchanged += 1;
        outcome.items.push({
          evidenceId: excerpt.id,
          title: excerpt.title,
          locatorStatus: excerpt.locatorStatus,
          verificationStatus: excerpt.verificationStatus,
          locator: excerpt.locator ?? null,
          current: true
        });
        continue;
      }

      await this.dependencies.evidence.updateEvidence({
        sessionId: input.sessionId,
        evidenceId: excerpt.id,
        patch: {
          locator: plan.locator ?? undefined,
          locatorStatus: plan.locatorStatus,
          anchorText: plan.anchorText ?? undefined,
          sourceContentHash: plan.sourceContentHash ?? undefined
        },
        event: {
          correlationId: excerpt.id,
          type: "EVIDENCE_RECORDED",
          payload: {
            evidenceId: excerpt.id,
            recheckedAgainstSource: input.sourceId,
            locatorFrom: excerpt.locatorStatus,
            locatorTo: plan.locatorStatus,
            recheckedBy: input.actor
          }
        }
      });

      outcome.items.push({
        evidenceId: excerpt.id,
        title: excerpt.title,
        locatorStatus: plan.locatorStatus,
        // Read back unchanged on purpose: this call never rules on the excerpt.
        verificationStatus: excerpt.verificationStatus,
        locator: plan.locator,
        current: true
      });
    }

    return outcome;
  }
}

/**
 * What a researcher is told when a page cannot be read.
 *
 * Keyed by the fetch error code, which stays the machine-readable contract in
 * the API response and the event payload. The wording explains what happened
 * in terms someone can act on — a login wall, a script-rendered page and a
 * 404 are different problems — without leaking a stack or an internal address.
 */
const FETCH_FAILURE_MESSAGES: Record<string, string> = {
  timeout: "抓取超时：在限定时间内没有读完这个页面。",
  transport: "读取页面失败：无法完成连接或读取响应。",
  "bad-status": "页面返回了非成功状态（不是 2xx），无法读取正文。",
  "unsupported-content-type":
    "这个地址不是可读取的文本页面；只支持 text/html、application/xhtml+xml 与 text/plain。",
  "no-content":
    "页面没有可读正文：可能由脚本渲染、需要登录，或受访问限制拦截。",
  "too-many-redirects": "跳转次数过多或出现跳转循环，已停止抓取。",
  "invalid-redirect": "跳转目标地址无法解析。",
  "response-too-large":
    "页面内容超过大小上限（包含解压后的正文），已停止抓取。",
  "unsupported-encoding": "页面使用了不支持的压缩编码。"
};

/**
 * Turns a retrieval failure into a code, a user-facing message and a status.
 *
 * The message is shown to a researcher, so it says what happened in terms they
 * can act on and never carries a stack or an internal address. The server's own
 * wording is kept alongside it: it is where details such as the exact status
 * code survive, and dropping it would make a failure harder to diagnose.
 */
export function describeFetchFailure(cause: unknown): {
  code: string;
  message: string;
  httpStatus: number;
} {
  if (cause instanceof TargetRefusedError) {
    return {
      code: "blocked-target",
      message: `拒绝导入该地址：${cause.reason}。只允许访问公网 http/https 页面。`,
      httpStatus: 400
    };
  }
  if (cause instanceof PageFetchError) {
    const httpStatus =
      cause.code === "timeout"
        ? 504
        : cause.code === "transport"
          ? 502
          : 400;
    const localized = FETCH_FAILURE_MESSAGES[cause.code];
    return {
      code: cause.code,
      message: localized
        ? `${localized}（服务器原始信息：${cause.message}）`
        : cause.message,
      httpStatus
    };
  }
  return {
    code: "unknown",
    message: "导入该页面时发生未知错误。",
    httpStatus: 502
  };
}
