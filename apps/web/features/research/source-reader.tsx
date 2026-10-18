"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Claim, Evidence, SourceSnapshot } from "@nexus/shared";
import {
  createEvidence,
  getSourceDetail,
  recheckSourceExcerpts,
  type RecheckResult,
  type SourceDetailRecord
} from "./api";
import { StatusPill } from "./components";
import { MultilingualResearchPanel } from "./multilingual-research";
import {
  directionLabel,
  directionTone,
  formatDate,
  formatDateTime,
  locatorStatusLabel,
  locatorStatusTone,
  sourceKindLabel,
  sourceRetrievalLabel,
  sourceRetrievalTone,
  verificationLabel,
  verificationTone
} from "./labels";

/* ------------------------------------------------------------------ *
 * Reading helpers
 *
 * These mirror what the server does in `html-extract.ts` so the reader can
 * point at the same place the server pointed at. They are display-only: they
 * decide which words get highlighted, never whether an excerpt is verified or
 * whether it was located. The server's answer is the record; this only makes
 * that record easier to see.
 * ------------------------------------------------------------------ */

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Locates an excerpt in the stored capture.
 *
 * Exact match first, then a whitespace-tolerant pass — a page can reflow
 * without losing a single word, and a researcher should not be told their
 * quote vanished when it only moved a line. Returns an empty array when the
 * text is not there, which the caller renders as "not in this version"
 * rather than silently highlighting nothing.
 */
function locateExcerpt(
  text: string,
  phrase: string | null | undefined
): Array<{ start: number; end: number }> {
  const needle = phrase?.trim();
  if (!needle) return [];

  const exact = text.indexOf(needle);
  if (exact !== -1) return [{ start: exact, end: exact + needle.length }];

  const pattern = escapeRegExp(needle).replace(/\s+/g, "\\s+");
  const regex = new RegExp(pattern, "gi");
  const ranges: Array<{ start: number; end: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
    if (match.index === regex.lastIndex) regex.lastIndex += 1;
  }
  return ranges;
}

/** Merge overlaps so adjacent phrases do not produce nested marks. */
function mergeRanges(
  ranges: Array<{ start: number; end: number }>
): Array<{ start: number; end: number }> {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/**
 * Renders stored text as text nodes with `<mark>` around the located ranges.
 *
 * The captured page is untrusted input. It is rendered by slicing a string
 * into React children — never as HTML — so nothing in it can be interpreted,
 * and this is also why a highlight cannot smuggle markup in.
 */
function ReaderText({
  text,
  phrases,
  focusRange,
  ref,
  ...rest
}: {
  text: string;
  phrases: readonly (string | null | undefined)[];
  /** The range to scroll into view and mark as the current target. */
  focusRange?: { start: number; end: number } | null | undefined;
  ref?: React.Ref<HTMLPreElement> | undefined;
} & Omit<React.HTMLAttributes<HTMLPreElement>, "children">) {
  const ranges = useMemo(() => {
    const all: Array<{ start: number; end: number }> = [];
    for (const phrase of phrases) all.push(...locateExcerpt(text, phrase));
    return mergeRanges(all);
  }, [text, phrases]);

  const nodes = useMemo(() => {
    if (ranges.length === 0) return text;
    const parts: React.ReactNode[] = [];
    let cursor = 0;
    ranges.forEach((range, index) => {
      if (range.start > cursor) parts.push(text.slice(cursor, range.start));
      const isFocus =
        focusRange !== null &&
        focusRange !== undefined &&
        range.start === focusRange.start &&
        range.end === focusRange.end;
      parts.push(
        <mark
          key={`${range.start}-${index}`}
          data-reader-focus={isFocus ? "true" : undefined}
        >
          {text.slice(range.start, range.end)}
        </mark>
      );
      cursor = range.end;
    });
    if (cursor < text.length) parts.push(text.slice(cursor));
    return parts;
  }, [text, ranges, focusRange]);

  return <pre {...rest} ref={ref}>{nodes}</pre>;
}

/**
 * Whether a stored url can be opened as a link.
 *
 * The server validates urls as urls, which still admits schemes a browser
 * would happily execute. Anything that is not plain http(s) is therefore shown
 * as text — a researcher can always read and copy the address.
 */
function safeExternalUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Who entered an excerpt, as a fact about the record.
 *
 * `createdBy` and `agentRunId` are stored per excerpt, so the distinction
 * between "an agent proposed this" and "a person wrote this down" is read
 * from the record rather than inferred from the wording of a free-text
 * description. Neither value is a verification: an excerpt a person typed is
 * still `unverified` until someone stands behind it.
 */
function excerptOriginLabel(evidence: Evidence): string | null {
  if (evidence.createdBy === "agent") return "AI 抽取建议";
  if (evidence.createdBy === "human") return "人工录入";
  if (evidence.createdBy === "system") return "系统登记";
  return null;
}

/**
 * The source reader: read the stored page text, pick the sentence that matters,
 * and hand it to the existing evidence API as a citation.
 *
 * Two things it deliberately does NOT do. It never marks an excerpt verified —
 * confirming that a sentence exists in a page is not the same as standing
 * behind what it says. And it never decides whether the excerpt was located:
 * the position shown after submission is the server's answer, not a guess made
 * here from string comparison.
 */
export function SourceReader({
  sessionId,
  sourceId,
  claims,
  defaultClaimId,
  canEdit,
  onClose,
  onChanged,
  onOpenEvidence
}: {
  sessionId: string;
  sourceId: string;
  claims: Claim[];
  defaultClaimId: string | null;
  canEdit: boolean;
  onClose: () => void;
  /** Called after anything that should refresh the workspace. */
  onChanged: () => Promise<void> | void;
  onOpenEvidence?: ((evidenceId: string) => void) | undefined;
}) {
  const [detail, setDetail] = useState<SourceDetailRecord | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<string | null>(null);

  const [anchorText, setAnchorText] = useState("");
  const [claimId, setClaimId] = useState(defaultClaimId ?? "");
  const [direction, setDirection] =
    useState<"supports" | "opposes" | "context">("supports");
  const [reliability, setReliability] = useState("0.7");
  const [title, setTitle] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    locatorStatus: Evidence["locatorStatus"];
    locator: string | null;
    verificationStatus: Evidence["verificationStatus"];
  } | null>(null);

  const [recheck, setRecheck] = useState<RecheckResult | null>(null);
  const [recheckError, setRecheckError] = useState<string | null>(null);

  /* Which stored excerpt the text panel is currently pointing at. Changing the
   * snapshot clears it: the same words may not be in a different capture, and
   * highlighting a range from another version would be a false claim. */
  const [focusedExcerptId, setFocusedExcerptId] = useState<string | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const textRef = useRef<HTMLPreElement | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await getSourceDetail(sessionId, sourceId);
      setDetail(next);
      setSelectedSnapshotId((current) =>
        current && next.snapshots.some((item) => item.id === current)
          ? current
          : (next.currentSnapshotId ?? next.snapshots[0]?.id ?? null)
      );
      setLoadError(null);
    } catch (cause) {
      setLoadError(
        cause instanceof Error ? cause.message : "无法读取来源原文"
      );
    }
  }, [sessionId, sourceId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setClaimId(defaultClaimId ?? "");
  }, [defaultClaimId]);

  /* Switching version invalidates any located range: the excerpt was matched
   * against a specific capture, and a different capture is a different text. */
  useEffect(() => {
    setFocusedExcerptId(null);
    setSelectionError(null);
  }, [selectedSnapshotId]);

  if (loadError) {
    return (
      <div className="research-column" data-testid="source-reader">
        <section className="research-panel">
          <p className="research-error" role="alert">
            {loadError}
          </p>
        </section>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="research-column" data-testid="source-reader">
        <div className="research-empty">正在载入原文…</div>
      </div>
    );
  }

  const { source, snapshots, excerpts } = detail;
  const shown: SourceSnapshot | undefined =
    snapshots.find((item) => item.id === selectedSnapshotId) ?? snapshots[0];
  const currentHash = snapshots.find(
    (item) => item.id === detail.currentSnapshotId
  )?.contentHash;

  /* Only http(s) addresses become links. A url that fails the check is still
   * displayed as text so the researcher can read and copy it. */
  const openableUrl = safeExternalUrl(source.canonicalUrl ?? source.url);

  /* The excerpt the text panel is pointing at, and the range it occupies in the
   * capture on screen. Null when nothing is focused, when the excerpt has no
   * anchor text, or when its words are not in the version being read — the last
   * case is a real answer (the quote is gone from this capture) and is reported
   * as such rather than shown as an empty highlight. */
  const focusedExcerpt: Evidence | null =
    excerpts.find((item) => item.id === focusedExcerptId) ?? null;
  const focusRange: { start: number; end: number } | null =
    shown && focusedExcerpt
      ? (locateExcerpt(shown.content, focusedExcerpt.anchorText ?? focusedExcerpt.content)[0] ??
        null)
      : null;

  /* Every stored excerpt's anchor text, so the capture can show where each one
   * came from. Excerpts without an anchor cannot be pointed at and are left
   * out rather than matched against their own body text. */
  const highlightPhrases = excerpts
    .map((item) => item.anchorText)
    .filter(
      (value): value is string =>
        typeof value === "string" && value.trim() !== ""
    );

  /**
   * Copies the researcher's current text selection into the excerpt field.
   *
   * Reading a long capture and typing a sentence back out of it is the slowest
   * step in this flow; selecting it instead keeps the excerpt byte-identical to
   * what is on screen, which is what the server will try to locate. Selection is
   * still available as text — this only saves retyping it.
   */
  function useSelectedText() {
    const selection =
      typeof window === "undefined" ? null : window.getSelection();
    const selected = selection?.toString() ?? "";
    if (selected.trim() === "") {
      setSelectionError("请先在原文区域选中一段文字，再点击此处填入。");
      return;
    }
    /* Only accept a selection made inside the capture on screen: text picked
     * from elsewhere on the page would not be locatable in this source. */
    const container = textRef.current;
    const anchorNode = selection?.anchorNode ?? null;
    const fromReader =
      container !== null &&
      anchorNode !== null &&
      container.contains(anchorNode);
    if (!fromReader) {
      setSelectionError("选中的文字不在原文区域内，请在上方正文中选择。");
      return;
    }
    setAnchorText(selected.trim());
    setSelectionError(null);
    setError(null);
  }

  /** Points the text panel at one stored excerpt and scrolls it into view. */
  function focusExcerpt(evidence: Evidence) {
    setFocusedExcerptId(evidence.id);
    /* Let the highlight render before scrolling to it. */
    window.requestAnimationFrame(() => {
      const mark = textRef.current?.querySelector<HTMLElement>(
        'mark[data-reader-focus="true"]'
      );
      mark?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }

  async function confirmExcerpt() {
    const excerpt = anchorText.trim();
    if (excerpt.length === 0) {
      setError("请先在下方粘贴或选择要引用的原文摘录。");
      return;
    }
    if (claimId === "") {
      setError("请选择这条摘录要支持/反对的主张。");
      return;
    }
    const parsedReliability = Number(reliability);
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const created = await createEvidence(sessionId, {
        kind: "external_reference",
        title: title.trim() === "" ? excerpt.slice(0, 60) : title.trim(),
        content: excerpt,
        description: `引自《${source.title}》${
          shown ? `（版本 ${shown.contentHash.slice(0, 8)}）` : ""
        }`,
        sourceId,
        locatorKind: "quote",
        anchorText: excerpt,
        direction,
        reliability: Number.isFinite(parsedReliability)
          ? Math.min(Math.max(parsedReliability, 0), 1)
          : 0.7,
        claimIds: [claimId]
      });
      setResult({
        locatorStatus: created.evidence.locatorStatus,
        locator: created.evidence.locator ?? null,
        verificationStatus: created.evidence.verificationStatus
      });
      setAnchorText("");
      setTitle("");
      await load();
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "确认摘录失败");
    } finally {
      setBusy(false);
    }
  }

  async function runRecheck() {
    setBusy(true);
    setRecheckError(null);
    try {
      const outcome = await recheckSourceExcerpts(sessionId, sourceId);
      setRecheck(outcome);
      await load();
      await onChanged();
    } catch (cause) {
      setRecheckError(
        cause instanceof Error ? cause.message : "重新核对定位失败"
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="research-column" data-testid="source-reader">
      <section className="research-panel">
        <div className="research-panel-head">
          <span className="research-panel-title">来源原文</span>
          <div className="research-actions">
            <StatusPill tone={sourceRetrievalTone(source.retrievalStatus)}>
              {sourceRetrievalLabel(source.retrievalStatus)}
            </StatusPill>
            <button
              type="button"
              className="research-button research-button-secondary"
              onClick={onClose}
            >
              关闭
            </button>
          </div>
        </div>
        <p className="research-question">{source.title}</p>
        <dl className="research-facts" style={{ marginTop: 8 }}>
          <dt>来源类型</dt>
          <dd>{sourceKindLabel(source.kind)}</dd>
          <dt>规范化地址</dt>
          <dd>
            {openableUrl ? (
              <a
                className="research-reader-link"
                href={openableUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {source.canonicalUrl ?? source.url}
              </a>
            ) : (
              /* No url, or a scheme that must not become a link. The address is
               * still shown and copyable — only the navigation is withheld. */
              (source.canonicalUrl ?? source.url ?? "—")
            )}
          </dd>
          {source.author || source.publisher || source.publishedAt ? (
            <>
              <dt>发布信息</dt>
              <dd>
                {[
                  source.author,
                  source.publisher,
                  source.publishedAt
                    ? `发布于 ${formatDate(source.publishedAt)}`
                    : null
                ]
                  .filter((value): value is string => Boolean(value))
                  .join(" · ")}
              </dd>
            </>
          ) : null}
          <dt>抓取时间</dt>
          <dd>{formatDateTime(source.retrievedAt)}</dd>
          <dt>当前版本哈希</dt>
          <dd style={{ overflowWrap: "anywhere" }}>
            {source.contentHash ?? "—"}
          </dd>
          <dt>抓取次数</dt>
          <dd>{source.retrievalAttempts ?? 0}</dd>
          {source.retrievalError ? (
            <>
              <dt>上次失败原因</dt>
              <dd style={{ overflowWrap: "anywhere" }}>{source.retrievalError}</dd>
            </>
          ) : null}
        </dl>
        {snapshots.length > 1 ? (
          <p className="research-muted" style={{ marginTop: 8 }}>
            该页面共有 {snapshots.length} 个已保存版本，旧版本保留以便复核早先的引用。
          </p>
        ) : null}
      </section>

      {snapshots.length === 0 ? (
        <section className="research-panel">
          <p className="research-muted">
            这个来源还没有抓到原文
            {source.retrievalStatus === "failed"
              ? "（上次抓取失败，原因见上）。"
              : "。请先导入网页地址。"}
          </p>
        </section>
      ) : (
        <>
          <section className="research-panel">
            <div className="research-panel-head">
              <span className="research-panel-title">已保存的版本</span>
              <span className="research-muted">{snapshots.length} 个</span>
            </div>
            <ul className="research-plain-list">
              {snapshots.map((item) => (
                <li key={item.id} className="research-challenge">
                  <div className="research-claim-meta">
                    <button
                      type="button"
                      className="research-button research-button-secondary"
                      aria-pressed={item.id === shown?.id}
                      onClick={() => setSelectedSnapshotId(item.id)}
                    >
                      {item.id === detail.currentSnapshotId
                        ? "当前版本"
                        : "历史版本"}
                    </button>
                    {item.contentHash === currentHash ? (
                      /* "This is the newest snapshot" describes the material's
                         history, not a verification — neutral, not verified. */
                      <StatusPill tone="research-pill-context">最新</StatusPill>
                    ) : (
                      <StatusPill tone="research-pill-neutral">
                        已被新版本取代
                      </StatusPill>
                    )}
                    <span className="research-muted">
                      {formatDate(item.retrievedAt)} · {item.charCount} 字
                    </span>
                  </div>
                  <div className="research-muted" style={{ overflowWrap: "anywhere" }}>
                    {item.contentHash}
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <section className="research-panel">
            <div className="research-panel-head">
              <span className="research-panel-title">原文文本</span>
              <span className="research-muted">
                {shown ? `${shown.charCount} 字` : ""}
              </span>
            </div>
            <p className="research-muted">
              以下是服务器抓取并保存的正文纯文本（不执行任何脚本）。选中其中连续的
              一句话，点下方「填入选中文字」即可作为引用确认。已登记引用在原文中高亮显示。
            </p>
            {/* Focusable and named so a keyboard user can scroll the capture:
                a plain <pre> is not in the tab order at all. */}
            <ReaderText
              ref={textRef}
              className="research-reader-text"
              data-testid="snapshot-content"
              tabIndex={0}
              role="region"
              aria-label={
                shown ? `来源原文，${shown.charCount} 字，可滚动` : "来源原文"
              }
              text={shown?.content ?? ""}
              phrases={highlightPhrases}
              focusRange={focusRange}
            />
            {/*
              * Saying "the quote is not in this version" is a finding. A
              * silently unhighlighted excerpt would read as a rendering fault.
              */}
            {focusedExcerpt && focusRange === null && shown ? (
              <p
                className="research-reader-note"
                data-testid="reader-excerpt-not-in-version"
              >
                这段引用不在当前显示的版本里
                {shown.contentHash === currentHash
                  ? "，且它是最新版本——该摘录已无法在此原文中定位，需要重新确认。"
                  : "。可切换到它被登记时的版本再核对。"}
              </p>
            ) : null}
          </section>

          {/* The multilingual reading aid: original stays the anchor, any
              translation is auxiliary and labelled as such. It reads the same
              snapshot the panel above shows and never verifies anything. */}
          <section className="research-panel">
            <div className="research-panel-head">
              <span className="research-panel-title">多语言阅读辅助</span>
              <span className="research-muted">译文仅供辅助理解</span>
            </div>
            <MultilingualResearchPanel
              sessionId={sessionId}
              sourceId={sourceId}
              canEdit={canEdit}
            />
          </section>

          <section className="research-panel">
            <div className="research-panel-head">
              <span className="research-panel-title">确认引用摘录</span>
              <span className="research-muted">
                服务器会在原文中定位，并给出定位结果
              </span>
            </div>
            {canEdit ? (
              <>
                <div className="research-field">
                  <label className="research-label" htmlFor="excerpt-anchor">
                    原文摘录（必须是原文中的连续文字）
                  </label>
                  <textarea
                    id="excerpt-anchor"
                    className="research-textarea"
                    rows={3}
                    value={anchorText}
                    onChange={(event) => {
                      setAnchorText(event.target.value);
                      setSelectionError(null);
                    }}
                  />
                  {/* Selecting the excerpt keeps it identical to the words on
                      screen, which is what the server will try to locate. */}
                  <div className="research-actions" style={{ marginTop: 6 }}>
                    <button
                      type="button"
                      className="research-button research-button-secondary"
                      onClick={useSelectedText}
                    >
                      填入选中文字
                    </button>
                  </div>
                  {selectionError ? (
                    <p className="research-error" role="alert">
                      {selectionError}
                    </p>
                  ) : null}
                </div>
                <div className="research-field">
                  <label className="research-label" htmlFor="excerpt-title">
                    引用标题（可选）
                  </label>
                  <input
                    id="excerpt-title"
                    className="research-input"
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                  />
                </div>
                <div
                  className="research-form"
                  style={{ flexDirection: "row", flexWrap: "wrap" }}
                >
                  <div className="research-field" style={{ minWidth: 200, flex: 1 }}>
                    <label className="research-label" htmlFor="excerpt-claim">
                      关联主张
                    </label>
                    <select
                      id="excerpt-claim"
                      className="research-select"
                      value={claimId}
                      onChange={(event) => setClaimId(event.target.value)}
                    >
                      <option value="">请选择主张</option>
                      {claims.map((claim) => (
                        <option key={claim.id} value={claim.id}>
                          {claim.statement}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="research-field" style={{ minWidth: 120 }}>
                    <label className="research-label" htmlFor="excerpt-direction">
                      方向
                    </label>
                    <select
                      id="excerpt-direction"
                      className="research-select"
                      value={direction}
                      onChange={(event) =>
                        setDirection(
                          event.target.value as "supports" | "opposes" | "context"
                        )
                      }
                    >
                      <option value="supports">支持</option>
                      <option value="opposes">反对</option>
                      <option value="context">背景</option>
                    </select>
                  </div>
                  <div className="research-field" style={{ minWidth: 120 }}>
                    <label className="research-label" htmlFor="excerpt-reliability">
                      可靠度 0–1
                    </label>
                    <input
                      id="excerpt-reliability"
                      className="research-input"
                      value={reliability}
                      onChange={(event) => setReliability(event.target.value)}
                    />
                  </div>
                </div>
                {error ? (
                  <p className="research-error" role="alert">
                    {error}
                  </p>
                ) : null}
                {result ? (
                  <div
                    className="research-panel"
                    data-testid="excerpt-confirm-result"
                    style={{ marginTop: 8 }}
                  >
                    <div className="research-claim-meta">
                      <StatusPill tone={locatorStatusTone(result.locatorStatus)}>
                        {locatorStatusLabel(result.locatorStatus)}
                      </StatusPill>
                      <StatusPill
                        tone={verificationTone(result.verificationStatus)}
                      >
                        {verificationLabel(result.verificationStatus)}
                      </StatusPill>
                      <span className="research-muted">
                        定位：{result.locator ?? "—"}
                      </span>
                    </div>
                    <p className="research-muted" style={{ marginTop: 6 }}>
                      {result.locatorStatus === "anchored"
                        ? "已在原文中定位到这段文字。引用已登记，仍未核实——核实是独立的动作。"
                        : result.locatorStatus === "missing"
                          ? "这段文字没有出现在当前保存的原文中，无法定位，需要重新确认。"
                          : "该来源没有保存的原文，无法定位；引用已登记但仍未核实。"}
                    </p>
                  </div>
                ) : null}
                <div className="research-actions" style={{ marginTop: 8 }}>
                  <button
                    type="button"
                    className="research-button"
                    onClick={() => void confirmExcerpt()}
                    disabled={busy}
                  >
                    定位并确认引用
                  </button>
                  <button
                    type="button"
                    className="research-button research-button-secondary"
                    onClick={() => void runRecheck()}
                    disabled={busy}
                  >
                    重新核对全部引用定位
                  </button>
                </div>
              </>
            ) : (
              <p className="research-muted">
                当前账号为只读角色，无法登记引用。
              </p>
            )}

            {recheckError ? (
              <p className="research-error" role="alert">
                {recheckError}
              </p>
            ) : null}
            {recheck ? (
              <p className="research-muted" data-testid="recheck-summary">
                已核对 {recheck.checked} 条：仍在原文 {recheck.anchored} 条，
                无法定位 {recheck.missing} 条，状态未变 {recheck.unchanged} 条，
                无可核对锚点 {recheck.skipped} 条。定位结果不影响核实状态。
              </p>
            ) : null}
          </section>

          <section className="research-panel">
            <div className="research-panel-head">
              <span className="research-panel-title">
                该来源的引用（{excerpts.length}）
              </span>
            </div>
            {excerpts.length === 0 ? (
              <p className="research-muted">还没有从这个来源登记的引用。</p>
            ) : (
              <ul className="research-plain-list" data-testid="source-excerpts">
                {excerpts.map((item) => {
                  const origin = excerptOriginLabel(item);
                  const canLocate =
                    shown !== undefined &&
                    (item.anchorText ?? item.content).trim() !== "" &&
                    locateExcerpt(shown.content, item.anchorText ?? item.content)
                      .length > 0;
                  return (
                    <li key={item.id} className="research-challenge">
                      <div className="research-claim-meta">
                        <StatusPill tone={locatorStatusTone(item.locatorStatus)}>
                          {locatorStatusLabel(item.locatorStatus)}
                        </StatusPill>
                        <StatusPill tone={verificationTone(item.verificationStatus)}>
                          {verificationLabel(item.verificationStatus)}
                        </StatusPill>
                        {/* How the excerpt bears on its claim(s). Read from the
                            stored `direction`, never derived from wording. */}
                        <StatusPill tone={directionTone(item.direction)}>
                          {directionLabel(item.direction)}
                        </StatusPill>
                        {/*
                          * Who entered it. `createdBy` is stored per excerpt, so
                          * this is a fact about the record — not a claim about
                          * whether its contents are any good.
                          */}
                        {origin ? (
                          <StatusPill
                            tone={
                              item.createdBy === "agent"
                                ? "research-pill-unverified"
                                : "research-pill-neutral"
                            }
                          >
                            {origin}
                          </StatusPill>
                        ) : null}
                        <span className="research-muted">
                          {item.locator ?? "未提供定位信息"}
                        </span>
                      </div>
                      <div>
                        <strong>{item.title}</strong>
                      </div>
                      <div className="research-excerpt">{item.content}</div>
                      {/*
                        * Verification context. Present only when the record has
                        * it: an unverified excerpt has no reviewer, and printing
                        * an empty one would imply a check that never happened.
                        */}
                      <div className="research-reader-attribution">
                        {item.verificationStatus === "unverified" ? (
                          <span>尚未由人工核实</span>
                        ) : (
                          <>
                            <span>
                              核验人：{item.verifiedBy ?? "未记录"}
                            </span>
                            <span>核验时间：{formatDateTime(item.verifiedAt)}</span>
                          </>
                        )}
                        {item.verificationNote ? (
                          <span>核验备注：{item.verificationNote}</span>
                        ) : null}
                      </div>
                      {item.claimIds.length > 0 ? (
                        <p className="research-reader-note">
                          关联主张：
                          {item.claimIds
                            .map((id) =>
                              claims.find((claim) => claim.id === id)?.statement ??
                              "（主张已不在当前研究）"
                            )
                            .join("；")}
                        </p>
                      ) : null}
                      <div className="research-actions" style={{ marginTop: 6 }}>
                        {canLocate ? (
                          <button
                            type="button"
                            className="research-button research-button-secondary"
                            onClick={() => focusExcerpt(item)}
                            aria-pressed={focusedExcerptId === item.id}
                          >
                            在原文中定位
                          </button>
                        ) : null}
                        {onOpenEvidence ? (
                          <button
                            type="button"
                            className="research-button research-button-secondary"
                            onClick={() => onOpenEvidence(item.id)}
                          >
                            打开原始详情
                          </button>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
