"use client";

import { useCallback, useEffect, useState } from "react";
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
  formatDate,
  locatorStatusLabel,
  locatorStatusTone,
  sourceRetrievalLabel,
  sourceRetrievalTone,
  verificationLabel,
  verificationTone
} from "./labels";

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
          <dt>规范化地址</dt>
          <dd style={{ overflowWrap: "anywhere" }}>
            {source.canonicalUrl ?? source.url ?? "—"}
          </dd>
          <dt>抓取时间</dt>
          <dd>{formatDate(source.retrievedAt)}</dd>
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
                      <StatusPill tone="research-pill-verified">最新</StatusPill>
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
              以下是服务器抓取并保存的正文纯文本（不执行任何脚本）。复制其中连续的
              一句话到下方填写框，即可作为引用确认。
            </p>
            <pre
              data-testid="snapshot-content"
              style={{
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
                maxHeight: 320,
                overflowY: "auto",
                margin: "8px 0 0",
                padding: 10,
                borderRadius: 8,
                background: "var(--wb-surface-subtle, rgba(0,0,0,0.03))",
                font: "inherit",
                fontSize: 13,
                lineHeight: 1.6
              }}
            >
              {shown?.content ?? ""}
            </pre>
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
                    onChange={(event) => setAnchorText(event.target.value)}
                  />
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
                {excerpts.map((item) => (
                  <li key={item.id} className="research-challenge">
                    <div className="research-claim-meta">
                      <StatusPill tone={locatorStatusTone(item.locatorStatus)}>
                        {locatorStatusLabel(item.locatorStatus)}
                      </StatusPill>
                      <StatusPill tone={verificationTone(item.verificationStatus)}>
                        {verificationLabel(item.verificationStatus)}
                      </StatusPill>
                      <span className="research-muted">
                        {item.locator ?? "—"}
                      </span>
                    </div>
                    <div>
                      <strong>{item.title}</strong>
                    </div>
                    <div className="research-excerpt">{item.content}</div>
                    {onOpenEvidence ? (
                      <button
                        type="button"
                        className="research-button research-button-secondary"
                        onClick={() => onOpenEvidence(item.id)}
                      >
                        打开原始详情
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
