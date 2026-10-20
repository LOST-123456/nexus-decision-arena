"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  SourceProvenanceKind,
  SourceRelationKind
} from "@nexus/shared";
import {
  declareSourceRelation,
  getSourceAnalysis,
  SourceIndependenceFailedError,
  overrideSourceProfile,
  type SourceAnalysisResult
} from "./api";
import { StatusPill } from "./components";
import {
  formatDate,
  sourceAnalysisFailureLabel,
  sourceLinkConfidenceLabel,
  sourceProvenanceLabel,
  sourceProvenanceTone,
  sourceRelationKindLabel
} from "./labels";

/**
 * Source independence — how many independent information sources there are.
 *
 * The contract this panel holds to:
 *  - three questions are kept apart and never averaged into one score:
 *    来源类型 (what kind of source this is), 对主张的适用性 (which lives in the
 *    citation panel and is not shown here), and 来源之间的独立性 (this panel);
 *  - a page that merely *looks* similar is a 疑似重复 until a person confirms
 *    it — the headline count only merges what the server can prove (the same
 *    normalized url, an identical content version);
 *  - the provenance kind is derived from recorded facts, and "未知" is shown as
 *    a real answer rather than dressed up as one;
 *  - nothing here verifies anything. There is no control that marks an excerpt
 *    verified, and the independence count does not change the verification
 *    gate.
 */

type Notice = { kind: "info" | "success" | "error"; text: string } | null;

/** Relation kinds a person may assert from this panel. */
const ASSERTABLE_RELATIONS: readonly SourceRelationKind[] = [
  "reprint",
  "quotes",
  "same_origin",
  "duplicate",
  "same_page",
  "unrelated"
];

const PROVENANCE_OPTIONS: readonly SourceProvenanceKind[] = [
  "primary",
  "secondary",
  "commentary",
  "official_notice",
  "dataset",
  "unknown"
];

export function SourceIndependencePanel({
  sessionId,
  canEdit,
  onChanged
}: {
  sessionId: string;
  canEdit: boolean;
  onChanged?: () => void | Promise<void>;
}) {
  const [result, setResult] = useState<SourceAnalysisResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [failure, setFailure] = useState<string | null>(null);

  // Two inline forms, both per source: declare a relation, or override a kind.
  const [relation, setRelation] = useState<{
    fromSourceId: string;
    toSourceId: string;
    kind: SourceRelationKind;
    reason: string;
  } | null>(null);
  const [override, setOverride] = useState<{
    sourceId: string;
    provenanceKind: SourceProvenanceKind;
    note: string;
  } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setFailure(null);
    try {
      const analysis = await getSourceAnalysis(sessionId);
      setResult(analysis);
    } catch (error) {
      setFailure(
        error instanceof SourceIndependenceFailedError
          ? sourceAnalysisFailureLabel(error.code)
          : error instanceof Error
            ? error.message
            : "读取来源分析失败"
      );
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const profilesById = useMemo(() => {
    const map = new Map<string, SourceAnalysisResult["profiles"][number]>();
    for (const profile of result?.profiles ?? []) {
      map.set(profile.sourceId, profile);
    }
    return map;
  }, [result]);

  const sourceIdsByCluster = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const cluster of result?.summary.clusters ?? []) {
      map.set(cluster.clusterId, cluster.sourceIds);
    }
    return map;
  }, [result]);

  const submitRelation = useCallback(
    async (input: {
      fromSourceId: string;
      toSourceId: string;
      kind: SourceRelationKind;
      reason: string;
    }) => {
      setBusy(true);
      try {
        await declareSourceRelation(sessionId, input);
        setNotice({ kind: "success", text: "已记录来源关系。" });
        setRelation(null);
        await load();
        await onChanged?.();
      } catch (error) {
        setNotice({
          kind: "error",
          text:
            error instanceof SourceIndependenceFailedError
              ? sourceAnalysisFailureLabel(error.code)
              : error instanceof Error
                ? `记录来源关系失败：${error.message}`
                : "记录来源关系失败"
        });
      } finally {
        setBusy(false);
      }
    },
    [load, onChanged, sessionId]
  );

  const submitOverride = useCallback(
    async (input: {
      sourceId: string;
      provenanceKind: SourceProvenanceKind;
      note: string;
    }) => {
      setBusy(true);
      try {
        await overrideSourceProfile(sessionId, input);
        setNotice({ kind: "success", text: "已记录来源类型判定。" });
        setOverride(null);
        await load();
        await onChanged?.();
      } catch (error) {
        setNotice({
          kind: "error",
          text:
            error instanceof SourceIndependenceFailedError
              ? sourceAnalysisFailureLabel(error.code)
              : error instanceof Error
                ? `记录来源类型判定失败：${error.message}`
                : "记录来源类型判定失败"
        });
      } finally {
        setBusy(false);
      }
    },
    [load, onChanged, sessionId]
  );

  const summary = result?.summary;

  return (
    <section className="research-panel" data-testid="source-independence">
      <header className="research-panel-header">
        <div>
          <h2 className="research-panel-title">来源独立性与可信度</h2>
          <p className="research-muted">
            同一份信息源被多个页面转载时，只算一条独立来源；仅凭文字相似不会自动合并。
          </p>
        </div>
        <div className="research-actions">
          <button
            type="button"
            className="research-button research-button-secondary"
            data-testid="refresh-analysis"
            disabled={busy}
            onClick={() => void load()}
          >
            重新分析
          </button>
        </div>
      </header>

      {notice ? (
        <p
          className={
            notice.kind === "error" ? "research-error" : "research-muted"
          }
          data-testid="analysis-notice"
        >
          {notice.text}
        </p>
      ) : null}

      {failure ? (
        <div className="research-actions" data-testid="source-analysis-error">
          <p className="research-error">{failure}</p>
          <button
            type="button"
            className="research-button research-button-secondary"
            data-testid="retry-analysis"
            onClick={() => void load()}
          >
            重试
          </button>
        </div>
      ) : null}

      {loading && !result ? (
        <p className="research-muted" data-testid="analysis-loading">
          正在分析来源…
        </p>
      ) : null}

      {summary ? (
        <>
          <dl className="research-deflist" data-testid="independence-summary">
            <div>
              <dt className="research-label">独立信息源</dt>
              <dd data-testid="independence-headline" style={{ margin: 0 }}>
                {summary.pages === 0
                  ? "尚未登记来源"
                  : `${summary.pages} 个页面、${
                      summary.suspectedIndependentSources ===
                      summary.confirmedIndependentSources
                        ? summary.confirmedIndependentSources
                        : `${summary.suspectedIndependentSources}–${summary.confirmedIndependentSources}`
                    } 条独立信息源`}
              </dd>
            </div>
            <div>
              <dt className="research-label">已确认合并的页面</dt>
              <dd style={{ margin: 0 }} data-testid="merged-page-count">
                {summary.clusters.reduce(
                  (total, cluster) =>
                    cluster.pageCount > 1 ? total + cluster.pageCount : total,
                  0
                )}{" "}
                个
              </dd>
            </div>
            <div>
              <dt className="research-label">疑似重复待确认</dt>
              <dd style={{ margin: 0 }} data-testid="suspected-count">
                {summary.suspectedLinks.length} 组
              </dd>
            </div>
          </dl>

          {summary.notes.length > 0 ? (
            <ul className="research-plain-list" data-testid="independence-notes">
              {summary.notes.map((note) => (
                <li key={note} className="research-muted">
                  {note}
                </li>
              ))}
            </ul>
          ) : null}

          <p className="research-muted" data-testid="independence-disclaimer">
            独立性只影响报告如何陈述佐证数量，不会自动核实任何摘录，也不会改变核查门禁。
          </p>

          {summary.suspectedLinks.length > 0 ? (
            <div data-testid="suspected-list">
              <h3 className="research-label">疑似重复（需人工确认）</h3>
              <ul className="research-plain-list">
                {summary.suspectedLinks.map((link, index) => (
                  <li key={`${link.fromSourceId}-${link.toSourceId}`}>
                    <div className="research-actions">
                      <StatusPill tone="research-pill-unverified">
                        {sourceRelationKindLabel(link.kind)}
                      </StatusPill>
                      <span className="research-muted">
                        {sourceLinkConfidenceLabel(link.confidence)}
                      </span>
                      <span className="research-muted">
                        {profilesById.get(link.fromSourceId)?.title ??
                          link.fromSourceId}
                        {" ↔ "}
                        {profilesById.get(link.toSourceId)?.title ??
                          link.toSourceId}
                      </span>
                    </div>
                    <p className="research-muted">{link.reason}</p>
                    {canEdit ? (
                      <div
                        className="research-actions"
                        data-testid={`suspected-${index}`}
                      >
                        <button
                          type="button"
                          className="research-button research-button-secondary"
                          data-testid={`confirm-suspected-${index}`}
                          disabled={busy}
                          onClick={() =>
                            void submitRelation({
                              fromSourceId: link.fromSourceId,
                              toSourceId: link.toSourceId,
                              kind: "duplicate",
                              reason:
                                "人工确认这两份正文是同一份信息源的重复登记。"
                            })
                          }
                        >
                          确认为重复
                        </button>
                        <button
                          type="button"
                          className="research-button research-button-secondary"
                          data-testid={`reject-suspected-${index}`}
                          disabled={busy}
                          onClick={() =>
                            void submitRelation({
                              fromSourceId: link.fromSourceId,
                              toSourceId: link.toSourceId,
                              kind: "unrelated",
                              reason:
                                "人工确认这两份正文只是措辞相近，并非同一信息源。"
                            })
                          }
                        >
                          标记为不相关
                        </button>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div>
            <h3 className="research-label">来源画像</h3>
            <ul className="research-plain-list" data-testid="profile-list">
              {result?.profiles.map((profile) => {
                const cluster = result.summary.clusters.find((item) =>
                  item.sourceIds.includes(profile.sourceId)
                );
                const isMerged = (cluster?.pageCount ?? 1) > 1;
                return (
                  <li key={profile.sourceId} data-testid={`profile-${profile.sourceId}`}>
                    <div className="research-actions">
                      <strong>{profile.title}</strong>
                      <span data-testid={`provenance-pill-${profile.sourceId}`}>
                        <StatusPill tone={sourceProvenanceTone(profile.provenanceKind)}>
                          {sourceProvenanceLabel(profile.provenanceKind)}
                          {profile.provenanceOrigin === "human" ? "（人工判定）" : ""}
                        </StatusPill>
                      </span>
                      {isMerged ? (
                        <span className="research-muted">
                          与另外 {cluster!.pageCount - 1} 个页面同属一份独立信息源
                        </span>
                      ) : null}
                    </div>

                    <p className="research-muted">
                      依据：{profile.provenanceReasons.join("；")}
                    </p>

                    <dl className="research-deflist">
                      <div>
                        <dt className="research-label">发布机构</dt>
                        <dd>{profile.facts.publisher ?? "未登记"}</dd>
                      </div>
                      <div>
                        <dt className="research-label">作者</dt>
                        <dd>{profile.facts.author ?? "未登记"}</dd>
                      </div>
                      <div>
                        <dt className="research-label">发布时间</dt>
                        <dd>{formatDate(profile.facts.publishedAt)}</dd>
                      </div>
                      <div>
                        <dt className="research-label">抓取时间</dt>
                        <dd>{formatDate(profile.facts.retrievedAt)}</dd>
                      </div>
                      <div>
                        <dt className="research-label">内容版本</dt>
                        <dd>
                          {profile.facts.contentVersion
                            ? profile.facts.contentVersion.slice(0, 12)
                            : "无快照"}
                        </dd>
                      </div>
                    </dl>

                    {profile.qualityLabels.length > 0 ? (
                      <p className="research-muted" data-testid={`quality-${profile.sourceId}`}>
                        已确认事实：{profile.qualityLabels.join("；")}
                      </p>
                    ) : null}

                    {profile.limitations.length > 0 ? (
                      <ul
                        className="research-plain-list"
                        data-testid={`limitations-${profile.sourceId}`}
                      >
                        {profile.limitations.map((line) => (
                          <li key={line} className="research-muted">
                            {line}
                          </li>
                        ))}
                      </ul>
                    ) : null}

                    {profile.referencesSourceIds.length > 0 ? (
                      <p className="research-muted">
                        引用了：
                        {profile.referencesSourceIds
                          .map(
                            (id) => profilesById.get(id)?.title ?? id
                          )
                          .join("、")}
                      </p>
                    ) : null}
                    {profile.referencedBySourceIds.length > 0 ? (
                      <p className="research-muted">
                        被引用：
                        {profile.referencedBySourceIds
                          .map(
                            (id) => profilesById.get(id)?.title ?? id
                          )
                          .join("、")}
                      </p>
                    ) : null}

                    {canEdit ? (
                      <div className="research-actions">
                        <button
                          type="button"
                          className="research-button research-button-secondary"
                          data-testid={`override-kind-${profile.sourceId}`}
                          onClick={() =>
                            setOverride({
                              sourceId: profile.sourceId,
                              provenanceKind: profile.provenanceKind,
                              note: ""
                            })
                          }
                        >
                          纠正来源类型
                        </button>
                        <button
                          type="button"
                          className="research-button research-button-secondary"
                          data-testid={`add-relation-${profile.sourceId}`}
                          onClick={() =>
                            setRelation({
                              fromSourceId: profile.sourceId,
                              toSourceId:
                                result.profiles.find(
                                  (item) => item.sourceId !== profile.sourceId
                                )?.sourceId ?? "",
                              kind: "reprint",
                              reason: ""
                            })
                          }
                        >
                          记录来源关系
                        </button>
                      </div>
                    ) : null}

                    {override && override.sourceId === profile.sourceId ? (
                      <form
                        className="research-deflist"
                        data-testid="override-form"
                        onSubmit={(event) => {
                          event.preventDefault();
                          if (override.note.trim().length < 10) {
                            setNotice({
                              kind: "error",
                              text: "判定理由至少 10 个字。"
                            });
                            return;
                          }
                          void submitOverride({
                            sourceId: override.sourceId,
                            provenanceKind: override.provenanceKind,
                            note: override.note.trim()
                          });
                        }}
                      >
                        <div>
                          <label className="research-label" htmlFor="override-kind">
                            来源类型
                          </label>
                          <select
                            id="override-kind"
                            data-testid="override-kind-select"
                            value={override.provenanceKind}
                            onChange={(event) =>
                              setOverride({
                                ...override,
                                provenanceKind: event.target
                                  .value as SourceProvenanceKind
                              })
                            }
                          >
                            {PROVENANCE_OPTIONS.map((value) => (
                              <option key={value} value={value}>
                                {sourceProvenanceLabel(value)}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="research-label" htmlFor="override-note">
                            判定理由
                          </label>
                          <textarea
                            id="override-note"
                            data-testid="override-note"
                            value={override.note}
                            rows={2}
                            onChange={(event) =>
                              setOverride({ ...override, note: event.target.value })
                            }
                          />
                        </div>
                        <div className="research-actions">
                          <button
                            type="submit"
                            className="research-button"
                            data-testid="override-submit"
                            disabled={busy}
                          >
                            提交判定
                          </button>
                          <button
                            type="button"
                            className="research-button research-button-secondary"
                            onClick={() => setOverride(null)}
                          >
                            取消
                          </button>
                        </div>
                      </form>
                    ) : null}

                    {relation && relation.fromSourceId === profile.sourceId ? (
                      <form
                        className="research-deflist"
                        data-testid="relation-form"
                        onSubmit={(event) => {
                          event.preventDefault();
                          if (!relation.toSourceId) {
                            setNotice({
                              kind: "error",
                              text: "请选择关联的来源。"
                            });
                            return;
                          }
                          if (relation.reason.trim().length < 10) {
                            setNotice({
                              kind: "error",
                              text: "关系理由至少 10 个字。"
                            });
                            return;
                          }
                          void submitRelation({
                            fromSourceId: relation.fromSourceId,
                            toSourceId: relation.toSourceId,
                            kind: relation.kind,
                            reason: relation.reason.trim()
                          });
                        }}
                      >
                        <div>
                          <label className="research-label" htmlFor="relation-target">
                            关联来源
                          </label>
                          <select
                            id="relation-target"
                            data-testid="relation-target"
                            value={relation.toSourceId}
                            onChange={(event) =>
                              setRelation({
                                ...relation,
                                toSourceId: event.target.value
                              })
                            }
                          >
                            {result.profiles
                              .filter(
                                (item) => item.sourceId !== profile.sourceId
                              )
                              .map((item) => (
                                <option key={item.sourceId} value={item.sourceId}>
                                  {item.title}
                                </option>
                              ))}
                          </select>
                        </div>
                        <div>
                          <label className="research-label" htmlFor="relation-kind">
                            关系
                          </label>
                          <select
                            id="relation-kind"
                            data-testid="relation-kind"
                            value={relation.kind}
                            onChange={(event) =>
                              setRelation({
                                ...relation,
                                kind: event.target.value as SourceRelationKind
                              })
                            }
                          >
                            {ASSERTABLE_RELATIONS.map((value) => (
                              <option key={value} value={value}>
                                {sourceRelationKindLabel(value)}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="research-label" htmlFor="relation-reason">
                            判断依据
                          </label>
                          <textarea
                            id="relation-reason"
                            data-testid="relation-reason"
                            value={relation.reason}
                            rows={2}
                            onChange={(event) =>
                              setRelation({ ...relation, reason: event.target.value })
                            }
                          />
                        </div>
                        <div className="research-actions">
                          <button
                            type="submit"
                            className="research-button"
                            data-testid="relation-submit"
                            disabled={busy}
                          >
                            提交关系
                          </button>
                          <button
                            type="button"
                            className="research-button research-button-secondary"
                            onClick={() => setRelation(null)}
                          >
                            取消
                          </button>
                        </div>
                      </form>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>

          {sourceIdsByCluster.size > 0 &&
          summary.clusters.some((cluster) => cluster.pageCount > 1) ? (
            <div>
              <h3 className="research-label">已合并的独立信息源</h3>
              <ul className="research-plain-list" data-testid="cluster-list">
                {summary.clusters
                  .filter((cluster) => cluster.pageCount > 1)
                  .map((cluster) => (
                    <li key={cluster.clusterId} data-testid={`cluster-${cluster.clusterId}`}>
                      <div className="research-actions">
                        <strong>{cluster.pageCount} 个页面</strong>
                        <span className="research-muted">
                          {cluster.confirmedKinds
                            .map(sourceRelationKindLabel)
                            .join("、")}
                        </span>
                      </div>
                      <ul className="research-plain-list">
                        {cluster.sourceIds.map((id) => (
                          <li key={id} className="research-muted">
                            {profilesById.get(id)?.title ?? id}
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
