"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  compareReportSnapshots,
  createReportSnapshot,
  getFactCheckReport,
  getReportSnapshot,
  listReportSnapshots,
  reportSnapshotExportUrl,
  type FactCheckReport,
  type ReportDiffEntry,
  type ReportSnapshotSummary,
  type ReportVersionDiff
} from "./api";
import { getCurrentUser, type AuthUser } from "../arena/api-client";
import { FactCheckReportBody } from "./fact-check-report-body";
import { StatusPill } from "./components";
import {
  formatDateTime,
  reportDiffCategoryLabel,
  reportDiffCategoryTone,
  reportDiffEntityLabel,
  reportDiffFieldLabel,
  reportDiffKindLabel,
  reportDiffKindTone,
  reportSnapshotTaskStatusLabel,
  verificationLabel,
  verificationTone
} from "./labels";

/**
 * Report history and version comparison.
 *
 * Two panels, both reading stored versions only:
 *
 * - `ReportVersionsPanel` saves the current report as a new version, lists
 *   what was saved, and reads one back from its frozen payload.
 * - `ReportComparePanel` puts two saved versions side by side by entity id.
 *
 * Nothing here recomputes a verdict, re-reads a page or re-derives a
 * conclusion: a version is a document that was frozen once, and the only
 * thing that can change it is another save.
 */

/* ------------------------------------------------------------------ *
 * Reading a stored payload
 * ------------------------------------------------------------------ */

/**
 * The payload of a version is the report object as it was frozen. The
 * structural check is deliberately shallow — the server already validated it
 * when it was written — and its only job is to keep a malformed payload from
 * being rendered as if it were a report.
 */
function asFactCheckReport(value: unknown): FactCheckReport | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<FactCheckReport>;
  if (typeof candidate.sessionId !== "string") return null;
  if (!Array.isArray(candidate.findings)) return null;
  if (typeof candidate.materialsFingerprint !== "string") return null;
  return candidate as FactCheckReport;
}

/** A diff value, printed the way it was stored — never reinterpreted. */
function valueText(value: unknown): string {
  if (value === null || value === undefined) return "（无）";
  if (typeof value === "string") return value === "" ? "（空）" : value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function errorText(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

/* ------------------------------------------------------------------ *
 * History: save, list, read one back
 * ------------------------------------------------------------------ */

export function ReportVersionsPanel({
  sessionId,
  currentFingerprint
}: {
  sessionId: string;
  currentFingerprint: string;
}) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [userLoaded, setUserLoaded] = useState(false);
  const [snapshots, setSnapshots] = useState<ReportSnapshotSummary[] | null>(null);
  /**
   * The fingerprint of the material as it stands now, re-read whenever the
   * list is refreshed. Taking it once from the parent and keeping it would
   * let this panel keep saying "matches the current material" after someone
   * else changed that material — the sentence is about the material, not
   * about the report this page happens to have rendered.
   */
  const [liveFingerprint, setLiveFingerprint] = useState(currentFingerprint);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [changeReason, setChangeReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<FactCheckReport | null>(null);
  const [selectedMeta, setSelectedMeta] = useState<{
    version: number;
    createdAt: string;
    createdBy: string;
    snapshotHash: string;
    materialsFingerprint: string;
    changeReason: string | null;
  } | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  /**
   * Saving is a write, so the panel waits until it knows who is reading
   * before offering the button at all. An unknown account (`user === null`
   * after a failed lookup) is not silently upgraded to a writer either:
   * the server is still the one that decides, and it answers 403 on its own.
   */
  const canSave = userLoaded && user !== null && user.role !== "viewer";

  const reload = useCallback(async () => {
    setLoadError(null);
    try {
      // A failure to re-read the live material must not cost the reader the
      // version list. When the current fingerprint cannot be read, the last
      // known one stays on screen rather than being replaced by a guess.
      const [{ snapshots: next }, live] = await Promise.all([
        listReportSnapshots(sessionId),
        getFactCheckReport(sessionId).catch(() => null)
      ]);
      setSnapshots(next);
      if (live) setLiveFingerprint(live.materialsFingerprint);
    } catch (cause) {
      setLoadError(errorText(cause, "历史版本加载失败"));
    }
  }, [sessionId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const current = await getCurrentUser();
        if (!cancelled) setUser(current);
      } catch {
        if (!cancelled) setUser(null);
      } finally {
        if (!cancelled) setUserLoaded(true);
      }
      await reload();
    })();
    return () => {
      cancelled = true;
    };
  }, [reload]);

  async function save() {
    setSaving(true);
    setSaveError(null);
    setSavedNotice(null);
    try {
      const created = await createReportSnapshot(
        sessionId,
        changeReason.trim() || undefined
      );
      setChangeReason("");
      setSavedNotice(`已保存为第 ${created.version} 版。`);
      await reload();
      setSelectedId(created.snapshotId);
    } catch (cause) {
      setSaveError(errorText(cause, "保存失败，请重试。"));
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    if (!selectedId) {
      setSelected(null);
      setSelectedMeta(null);
      setDetailError(null);
      return;
    }
    let cancelled = false;
    (async () => {
      setDetailError(null);
      try {
        const snapshot = await getReportSnapshot(sessionId, selectedId);
        if (cancelled) return;
        const payload = asFactCheckReport(snapshot.reportPayload);
        if (!payload) {
          setDetailError("这一版的报告内容无法识别，可能保存时的结构版本与当前不同。");
          setSelected(null);
          setSelectedMeta(null);
          return;
        }
        setSelected(payload);
        setSelectedMeta({
          version: snapshot.version,
          createdAt: snapshot.createdAt,
          createdBy: snapshot.createdBy,
          snapshotHash: snapshot.snapshotHash,
          materialsFingerprint: snapshot.materialsFingerprint,
          changeReason: snapshot.changeReason
        });
      } catch (cause) {
        if (!cancelled) {
          setDetailError(errorText(cause, "这一版读取失败"));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, selectedId]);

  return (
    <div className="research-report-versions" data-testid="report-versions">
      {!canSave ? (
        <section className="research-report-section">
          <h2>保存当前报告为新版本</h2>
          {userLoaded ? (
            <p className="research-muted" data-testid="report-snapshot-viewer-note">
              当前是查看者账户：可以阅读、比较和导出历史版本，保存新版本需要 Reviewer 或 Owner 账户。
            </p>
          ) : (
            <p className="research-muted">正在确认当前账户的权限…</p>
          )}
        </section>
      ) : (
        <section className="research-report-section">
          <h2>保存当前报告为新版本</h2>
          <p className="research-muted">
            保存会把当前的主张结论、材料核实状态、人工裁定、所引来源版本与来源监测状态一起冻结成一个不可变的版本；
            保存之后资料再发生变化，也不会改动已经保存的任何一版。可以随时回来查看、比较或导出。
          </p>
          <label className="research-label" htmlFor="report-snapshot-reason">
            变更原因（可选，会随版本一起保存）
          </label>
          <textarea
            id="report-snapshot-reason"
            className="research-input"
            rows={2}
            maxLength={2000}
            value={changeReason}
            placeholder="例如：补充了两条已核实证据后重新定稿"
            onChange={(event) => setChangeReason(event.target.value)}
          />
          <div className="research-actions">
            <button
              type="button"
              className="research-button"
              data-testid="save-report-snapshot"
              disabled={saving}
              onClick={save}
            >
              {saving ? "正在保存…" : "保存当前报告"}
            </button>
          </div>
          {saveError ? (
            <p className="research-error" role="alert" data-testid="report-snapshot-save-error">
              {saveError}
            </p>
          ) : null}
          {savedNotice ? (
            <p className="research-muted" data-testid="report-snapshot-saved">
            {savedNotice}
          </p>
          ) : null}
        </section>
      )}

      <section className="research-report-section">
        <h2>已保存的版本</h2>
        {!loadError ? (
          <div className="research-actions">
            <button
              type="button"
              className="research-button research-button-secondary"
              onClick={reload}
            >
              刷新列表
            </button>
          </div>
        ) : null}
        {loadError ? (
          <>
            <p className="research-error" role="alert">
              {loadError}
            </p>
            <button type="button" className="research-button" onClick={reload}>
              重试
            </button>
          </>
        ) : snapshots === null ? (
          <div className="research-empty">正在加载历史版本…</div>
        ) : snapshots.length === 0 ? (
          <div className="research-empty" data-testid="report-versions-empty">
            还没有保存任何报告版本。保存第一版之后，这里会列出全部历史版本，
            可以逐版查看、两版比较，或按当时的内容导出。
          </div>
        ) : (
          <ul className="research-plain-list" data-testid="report-snapshot-list">
            {snapshots.map((item) => (
              <li
                key={item.snapshotId}
                className="research-report-version"
                data-testid="report-snapshot-item"
                data-version={item.version}
              >
                <div className="research-claim-meta">
                  <StatusPill tone="research-pill-neutral">第 {item.version} 版</StatusPill>
                  <span className="research-muted">
                    保存于 {formatDateTime(item.createdAt)} · {item.createdBy}
                  </span>
                  {item.materialsFingerprint !== liveFingerprint ? (
                    <StatusPill tone="research-pill-unverified">
                      与当前资料已不同（指纹不同）
                    </StatusPill>
                  ) : (
                    <StatusPill tone="research-pill-verified">与当前资料一致</StatusPill>
                  )}
                </div>
                <div className="research-muted">
                  主张 {item.claimCount} · 材料 {item.evidenceCount} · 来源{" "}
                  {item.sourceCount} · 未解决冲突 {item.unresolvedConflicts} ·
                  待处理监测 {item.openRevalidations} · 复核中 {item.inReviewRevalidations}
                </div>
                {item.changeReason ? (
                  <div className="research-muted">变更原因：{item.changeReason}</div>
                ) : null}
                <div className="research-actions">
                  <button
                    type="button"
                    className="research-button research-button-secondary"
                    data-testid="report-snapshot-open"
                    onClick={() => setSelectedId(item.snapshotId)}
                  >
                    查看这一版
                  </button>
                  <a
                    className="research-button research-button-secondary"
                    href={reportSnapshotExportUrl(sessionId, item.snapshotId, "markdown")}
                    data-testid="report-snapshot-export-markdown"
                  >
                    导出 Markdown
                  </a>
                  <a
                    className="research-button research-button-secondary"
                    href={reportSnapshotExportUrl(sessionId, item.snapshotId, "html")}
                    data-testid="report-snapshot-export-html"
                  >
                    导出 HTML
                  </a>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {selectedMeta && selected ? (
        <section className="research-report-section" data-testid="report-snapshot-detail">
          <h2>历史版本 第 {selectedMeta.version} 版</h2>
          <div className="research-report-version-banner" data-testid="report-snapshot-banner">
            <p>
              <strong>这是保存时的快照。</strong>保存于 {formatDateTime(selectedMeta.createdAt)}，
              保存人 {selectedMeta.createdBy}。内容冻结在保存那一刻，不包含之后的任何变更；
              当前资料可能已经与这一版不同。
            </p>
            <p className="research-muted">
              快照哈希 <code>{selectedMeta.snapshotHash}</code> · 材料指纹{" "}
              <code>{selectedMeta.materialsFingerprint}</code>
              {selectedMeta.changeReason ? ` · 变更原因：${selectedMeta.changeReason}` : ""}
            </p>
            <div className="research-actions">
              <a
                className="research-button research-button-secondary"
                href={reportSnapshotExportUrl(sessionId, selectedId!, "markdown")}
              >
                导出这一版 Markdown
              </a>
              <a
                className="research-button research-button-secondary"
                href={reportSnapshotExportUrl(sessionId, selectedId!, "html")}
              >
                导出这一版 HTML
              </a>
            </div>
          </div>
          <FactCheckReportBody report={selected} sessionId={sessionId} />
        </section>
      ) : null}

      {detailError ? (
        <p className="research-error" role="alert">
          {detailError}
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Comparison
 * ------------------------------------------------------------------ */

function DiffEntryRow({ entry }: { entry: ReportDiffEntry }) {
  const changed = entry.kind === "changed";
  return (
    <li
      className="research-report-diff-entry"
      data-testid="report-diff-entry"
      data-entity-type={entry.entityType}
      data-kind={entry.kind}
      data-category={entry.category}
    >
      <div className="research-claim-meta">
        <StatusPill tone="research-pill-neutral">
          {reportDiffEntityLabel(entry.entityType)}
        </StatusPill>
        <StatusPill tone={reportDiffKindTone(entry.kind)}>
          {reportDiffKindLabel(entry.kind)}
        </StatusPill>
        <StatusPill tone={reportDiffCategoryTone(entry.category)}>
          {reportDiffCategoryLabel(entry.category)}
        </StatusPill>
        <span className="research-muted">{entry.entityId.slice(0, 8)}</span>
      </div>
      {changed ? (
        <div>
          <strong>{reportDiffFieldLabel(entry.field)}</strong>：
          {valueText(entry.oldValue)} → {valueText(entry.newValue)}
        </div>
      ) : (
        <div>
          {entry.kind === "added" ? "新增内容：" : "消失的内容："}
          {valueText(entry.kind === "added" ? entry.newValue : entry.oldValue)}
        </div>
      )}
      {entry.reason ? (
        <div className="research-muted">记录下来的原因：{entry.reason}</div>
      ) : null}
      {entry.changedAt ? (
        <div className="research-muted">该行变动时间：{formatDateTime(entry.changedAt)}</div>
      ) : null}
      {entry.relatedSourceIds.length > 0 ? (
        <div className="research-muted">
          关联来源：{entry.relatedSourceIds.map((id) => id.slice(0, 8)).join("、")}
        </div>
      ) : null}
    </li>
  );
}

export function ReportComparePanel({ sessionId }: { sessionId: string }) {
  const [snapshots, setSnapshots] = useState<ReportSnapshotSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [diff, setDiff] = useState<ReportVersionDiff | null>(null);
  const [comparing, setComparing] = useState(false);
  const [compareError, setCompareError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoadError(null);
    try {
      const { snapshots: next } = await listReportSnapshots(sessionId);
      // Newest first from the server; the selects read better oldest-first.
      // The default pair is the last two versions: what the most recent save
      // changed. With a single version the panel asks for another one anyway.
      const oldestFirst = [...next].reverse();
      const newest = oldestFirst[oldestFirst.length - 1];
      const previous = oldestFirst[oldestFirst.length - 2];
      setSnapshots(oldestFirst);
      setFromId(
        (current) =>
          current || previous?.snapshotId || oldestFirst[0]?.snapshotId || ""
      );
      setToId((current) => current || newest?.snapshotId || "");
    } catch (cause) {
      setLoadError(errorText(cause, "历史版本加载失败"));
    }
  }, [sessionId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const grouped = useMemo(() => {
    if (!diff) return null;
    return {
      verdict: diff.entries.filter((entry) => entry.category === "verdict"),
      risk: diff.entries.filter((entry) => entry.category === "risk")
    };
  }, [diff]);

  async function compare() {
    if (!fromId || !toId || fromId === toId) return;
    setComparing(true);
    setCompareError(null);
    try {
      setDiff(await compareReportSnapshots(sessionId, fromId, toId));
    } catch (cause) {
      setCompareError(errorText(cause, "比较失败，请重试。"));
      setDiff(null);
    } finally {
      setComparing(false);
    }
  }

  return (
    <div className="research-report-versions" data-testid="report-compare">
      <section className="research-report-section">
        <h2>比较两个已保存版本</h2>
        <p className="research-muted">
          比较按实体身份进行：同一条主张、同一条摘录、同一个来源版本、同一条裁定，
          靠的是它们自己的编号，不是文字像不像。对不上的一律标为新增或消失，不做猜测。
        </p>
        {loadError ? (
          <>
            <p className="research-error" role="alert">
              {loadError}
            </p>
            <button type="button" className="research-button" onClick={reload}>
              重试
            </button>
          </>
        ) : snapshots === null ? (
          <div className="research-empty">正在加载历史版本…</div>
        ) : snapshots.length < 2 ? (
          <div className="research-empty" data-testid="report-compare-empty">
            至少需要保存两个版本才能比较。请先到「历史版本」保存几版报告。
          </div>
        ) : (
          <>
            <div className="research-actions">
              <label className="research-label" htmlFor="report-compare-from">
                从这一版
              </label>
              <select
                id="report-compare-from"
                className="research-input"
                value={fromId}
                onChange={(event) => setFromId(event.target.value)}
              >
                {snapshots.map((item) => (
                  <option key={item.snapshotId} value={item.snapshotId}>
                    第 {item.version} 版 · {formatDateTime(item.createdAt)}
                  </option>
                ))}
              </select>
              <label className="research-label" htmlFor="report-compare-to">
                到这一版
              </label>
              <select
                id="report-compare-to"
                className="research-input"
                value={toId}
                onChange={(event) => setToId(event.target.value)}
              >
                {snapshots.map((item) => (
                  <option key={item.snapshotId} value={item.snapshotId}>
                    第 {item.version} 版 · {formatDateTime(item.createdAt)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="research-button"
                data-testid="report-compare-run"
                disabled={comparing || !fromId || !toId || fromId === toId}
                onClick={compare}
              >
                {comparing ? "正在比较…" : "开始比较"}
              </button>
            </div>
            {fromId === toId ? (
              <p className="research-muted">比较同一版没有结果，请选择两个不同的版本。</p>
            ) : null}
          </>
        )}
        {compareError ? (
          <p className="research-error" role="alert" data-testid="report-compare-error">
            {compareError}
          </p>
        ) : null}
      </section>

      {diff && grouped ? (
        <section className="research-report-section" data-testid="report-diff">
          <h2>
            比较结果：第 {diff.fromVersion} 版 → 第 {diff.toVersion} 版
          </h2>
          <div className="research-claim-meta">
            <StatusPill tone="research-pill-neutral">
              新增 {diff.counts.added}
            </StatusPill>
            <StatusPill tone="research-pill-neutral">消失 {diff.counts.removed}</StatusPill>
            <StatusPill tone="research-pill-unverified">变化 {diff.counts.changed}</StatusPill>
            <StatusPill tone={reportDiffCategoryTone("verdict")}>
              结论 / 裁定变化 {diff.counts.verdict}
            </StatusPill>
            <StatusPill tone={reportDiffCategoryTone("risk")}>
              来源时效风险 {diff.counts.risk}
            </StatusPill>
          </div>
          <p className="research-muted">
            材料指纹 {diff.fromMaterialsFingerprint} → {diff.toMaterialsFingerprint}
            {diff.fromMaterialsFingerprint === diff.toMaterialsFingerprint
              ? "（两版材料指纹相同）"
              : "（材料在两版之间发生过变化）"}
          </p>
          {diff.entries.length === 0 ? (
            <div className="research-empty" data-testid="report-diff-empty">
              两个版本之间没有可识别的差异：同一批实体、同样的状态。
            </div>
          ) : (
            <>
              <h3>结论与裁定变化（{grouped.verdict.length}）</h3>
              {grouped.verdict.length === 0 ? (
                <p className="research-muted">两版之间没有结论或裁定发生变化。</p>
              ) : (
                <ul className="research-plain-list">
                  {grouped.verdict.map((entry) => (
                    <DiffEntryRow
                      key={`${entry.entityType}-${entry.entityId}-${entry.field ?? entry.kind}`}
                      entry={entry}
                    />
                  ))}
                </ul>
              )}
              <h3>来源时效风险（{grouped.risk.length}）</h3>
              <p className="research-muted">
                这一类只说明所引材料是否仍然对得上原文，不代表结论被推翻：
                页面移动是重新阅读的理由，不是重新判决的理由。
              </p>
              {grouped.risk.length === 0 ? (
                <p className="research-muted">两版之间没有来源或定位状态发生变化。</p>
              ) : (
                <ul className="research-plain-list">
                  {grouped.risk.map((entry) => (
                    <DiffEntryRow
                      key={`${entry.entityType}-${entry.entityId}-${entry.field ?? entry.kind}`}
                      entry={entry}
                    />
                  ))}
                </ul>
              )}
            </>
          )}
        </section>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Shared small pieces
 * ------------------------------------------------------------------ */

/** A monitoring task as a version recorded it, for the detail view. */
export function ReportSnapshotTaskPill({ status }: { status: string }) {
  return (
    <StatusPill tone="research-pill-unverified">
      {reportSnapshotTaskStatusLabel(status)}
    </StatusPill>
  );
}

/** Verification wording, re-exported so panels read consistently. */
export function ReportSnapshotVerificationPill({
  status
}: {
  status: "unverified" | "verified" | "rejected";
}) {
  return <StatusPill tone={verificationTone(status)}>{verificationLabel(status)}</StatusPill>;
}
