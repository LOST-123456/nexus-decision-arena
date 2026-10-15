"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  LibrarySessionSummary,
  LibrarySourceDetail,
  LibrarySourceSummary,
  ShareGrant,
  SourceCopyRecord
} from "@nexus/shared";
import {
  copyLibrarySource,
  createShareGrant,
  getCopyLineage,
  getLibrarySource,
  LibraryFailedError,
  listLibrarySessions,
  listShareGrants,
  readLibrarySnapshot,
  revokeShareGrant,
  searchLibrarySources,
  type LibrarySearchQuery
} from "./api";
import { getCurrentUser, type AuthUser } from "../arena/api-client";
import { forkStateLabel, grantScopeLabel, originStatusLabel } from "./labels";

/**
 * The cross-research library.
 *
 * A browse-and-copy surface, not a "show me everything" page: results are
 * limited to the researches this account owns or was explicitly granted, a
 * source id the account may not see answers 404, and copying material never
 * copies a human verification with it. The panel says those things out loud so
 * a reader never has to infer them.
 */

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function shortDate(value: string | undefined): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toISOString().slice(0, 10);
}

export type SourceLibraryPanelProps = {
  /** The research a copy would land in by default, when one is open. */
  currentSessionId?: string | undefined;
  /**
   * False for a read-only account. Omitted means "ask the server who is signed
   * in": a page that does not know the role must not offer controls the
   * account may not use, and discovering that by a refused request is a worse
   * answer than not offering them.
   */
  canEdit?: boolean | undefined;
  /**
   * Called after this research actually gained a source. The workspace reloads
   * so the copied source is visible there; the panel never writes to the
   * workspace's own state, because the backend is the record.
   */
  onChanged?: (() => void | Promise<void>) | undefined;
};

export function SourceLibraryPanel({
  currentSessionId,
  canEdit,
  onChanged
}: SourceLibraryPanelProps) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [sessions, setSessions] = useState<LibrarySessionSummary[]>([]);
  const [filters, setFilters] = useState<LibrarySearchQuery>({});
  const [results, setResults] = useState<LibrarySourceSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [detail, setDetail] = useState<LibrarySourceDetail | null>(null);
  const [openSnapshot, setOpenSnapshot] = useState<{
    snapshotId: string;
    content: string;
  } | null>(null);
  const [targetSessionId, setTargetSessionId] = useState<string>(
    currentSessionId ?? ""
  );
  const [managedSessionId, setManagedSessionId] = useState<string>("");
  const [grants, setGrants] = useState<ShareGrant[]>([]);
  const [grantSubjectType, setGrantSubjectType] = useState<"user" | "role">(
    "user"
  );
  const [grantSubjectId, setGrantSubjectId] = useState("");
  const [grantScope, setGrantScope] = useState<"read" | "copy">("read");
  const [lineage, setLineage] = useState<Record<string, SourceCopyRecord>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const ownSessions = sessions.filter((session) => session.access === "own");

  /**
   * Who is signed in, when the caller did not already tell us.
   *
   * The standalone library page has no session to read a role from, so it asks
   * the server. Until the answer arrives the panel behaves like every other
   * write surface in the app (editable), and a viewer's controls are then
   * turned off with the reason shown — never left to fail on click.
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const current = await getCurrentUser().catch(() => null);
      if (!cancelled) {
        setUser(current ?? null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const allowsEdit = canEdit ?? (user === null || user.role !== "viewer");

  /**
   * Whether the caller may take this research's material into their own.
   *
   * Ownership allows it; a grant only allows it when its scope says `copy`. A
   * `read` grant is browsing only, so the copy control is offered disabled
   * rather than letting the server refuse it after the fact.
   */
  const mayCopyFrom = (sessionId: string): boolean => {
    const session = sessions.find((row) => row.sessionId === sessionId);
    if (!session) return false;
    return session.access === "own" || session.grantScope === "copy";
  };

  const refreshSessions = useCallback(async () => {
    const response = await listLibrarySessions();
    setSessions(response.sessions);
    return response.sessions;
  }, []);

  const runSearch = useCallback(
    async (next: LibrarySearchQuery) => {
      const response = await searchLibrarySources({
        ...next,
        ...(targetSessionId ? { targetSessionId } : {})
      });
      setResults(response.sources);
      setTotal(response.total);
      return response;
    },
    [targetSessionId]
  );

  useEffect(() => {
    void (async () => {
      try {
        const loaded = await refreshSessions();
        await runSearch({});
        const firstOwn = loaded.find((session) => session.access === "own");
        if (firstOwn) {
          setManagedSessionId((current) => current || firstOwn.sessionId);
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "资料库加载失败");
      }
    })();
    // Intentionally once: later refreshes are explicit user actions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!managedSessionId) {
      setGrants([]);
      return;
    }
    void (async () => {
      try {
        const response = await listShareGrants(managedSessionId);
        setGrants(response.grants);
      } catch {
        setGrants([]);
      }
    })();
  }, [managedSessionId]);

  useEffect(() => {
    if (!targetSessionId) {
      setLineage({});
      return;
    }
    void (async () => {
      try {
        const response = await getCopyLineage(targetSessionId);
        setLineage(response.lineage);
      } catch {
        setLineage({});
      }
    })();
  }, [targetSessionId]);

  const search = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await runSearch(filters);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "检索失败");
    } finally {
      setBusy(false);
    }
  };

  const openSource = async (sourceId: string) => {
    setError(null);
    setOpenSnapshot(null);
    try {
      setDetail(await getLibrarySource(sourceId));
    } catch (cause) {
      setDetail(null);
      setError(cause instanceof Error ? cause.message : "无法打开该来源");
    }
  };

  const openVersion = async (sourceId: string, snapshotId: string) => {
    setError(null);
    try {
      const snapshot = await readLibrarySnapshot(sourceId, snapshotId);
      setOpenSnapshot({ snapshotId: snapshot.snapshotId, content: snapshot.content });
    } catch (cause) {
      setOpenSnapshot(null);
      setError(cause instanceof Error ? cause.message : "无法读取该版本");
    }
  };

  const copy = async (
    source: LibrarySourceSummary | LibrarySourceDetail,
    mode: "copy" | "reference"
  ) => {
    if (!targetSessionId) {
      setError("请先选择要复制到的研究");
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const outcome = await copyLibrarySource(targetSessionId, {
        sourceSessionId: source.sessionId,
        sourceId: source.sourceId,
        mode
      });
      setMessage(
        mode === "copy"
          ? `已复制到本研究（含已保存原文）。新来源仍在"未核实"状态，需要重新登记证据并人工核实。`
          : `已引用到本研究（仅元数据，尚未抓取原文）。`
      );
      const response = await runSearch(filters);
      void response;
      const refreshed = await getCopyLineage(targetSessionId);
      setLineage(refreshed.lineage);
      // Only the research this workspace is showing needs to reload: a copy
      // into some other research is not part of this one's state.
      if (onChanged && targetSessionId === currentSessionId) {
        await onChanged();
      }
    } catch (cause) {
      if (cause instanceof LibraryFailedError && cause.code === "duplicate_source") {
        setMessage(
          `本研究已录入过该来源（${cause.duplicate?.title ?? "同名来源"}）。同一研究不会重复保存同一来源。`
        );
      } else if (
        cause instanceof LibraryFailedError &&
        cause.code === "source_has_no_capture"
      ) {
        setError(
          "该来源还没有已保存的原文，无法复制快照。可以改用“仅引用”，把参考信息带入本研究后再抓取。"
        );
      } else {
        setError(cause instanceof Error ? cause.message : "复制失败");
      }
    } finally {
      setBusy(false);
    }
  };

  const submitGrant = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!managedSessionId || !grantSubjectId.trim()) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await createShareGrant({
        sessionId: managedSessionId,
        subjectType: grantSubjectType,
        subjectId: grantSubjectId.trim(),
        scope: grantScope
      });
      setGrantSubjectId("");
      setGrants((await listShareGrants(managedSessionId)).grants);
      setMessage("已授权。被授权账号可以浏览该研究的资料，并按授权范围复制。");
      await refreshSessions();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "授权失败");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (grantId: string) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await revokeShareGrant(grantId, "撤销共享");
      setGrants((await listShareGrants(managedSessionId)).grants);
      setMessage(
        "已撤销共享。已复制到其他研究的副本与审计记录保留，但无法再从原研究读取。"
      );
      await refreshSessions();
      if (targetSessionId) {
        setLineage((await getCopyLineage(targetSessionId)).lineage);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "撤销失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="research-library-grid" data-testid="source-library">
      <div className="research-column">
        <section className="research-panel">
          <div className="research-panel-head">
            <span className="research-panel-title">资料库检索</span>
            <span className="research-muted">
              只显示本账号拥有或被授权的研究
            </span>
          </div>
          <form className="research-form" onSubmit={search} data-testid="library-filters">
            <div className="research-field">
              <label className="research-label" htmlFor="library-query">
                关键词
              </label>
              <input
                id="library-query"
                className="research-input"
                value={filters.query ?? ""}
                onChange={(event) => setFilters((current) => ({ ...current, query: event.target.value }))}
                placeholder="标题、发布者、作者或链接"
              />
            </div>
            <div className="research-field">
              <label className="research-label" htmlFor="library-publisher">
                发布者
              </label>
              <input
                id="library-publisher"
                className="research-input"
                value={filters.publisher ?? ""}
                onChange={(event) => setFilters((current) => ({ ...current, publisher: event.target.value }))}
              />
            </div>
            <div className="research-field">
              <label className="research-label" htmlFor="library-author">
                作者
              </label>
              <input
                id="library-author"
                className="research-input"
                value={filters.author ?? ""}
                onChange={(event) => setFilters((current) => ({ ...current, author: event.target.value }))}
              />
            </div>
            <div className="research-field">
              <label className="research-label" htmlFor="library-domain">
                域名
              </label>
              <input
                id="library-domain"
                className="research-input"
                value={filters.domain ?? ""}
                onChange={(event) => setFilters((current) => ({ ...current, domain: event.target.value }))}
                placeholder="例如 stats.gov.cn"
              />
            </div>
            <div className="research-field">
              <label className="research-label" htmlFor="library-from">
                发布日期起
              </label>
              <input
                id="library-from"
                className="research-input"
                type="date"
                value={(filters.publishedFrom ?? "").slice(0, 10)}
                onChange={(event) =>
                  setFilters((current) => ({
                    ...current,
                    publishedFrom: event.target.value
                      ? new Date(`${event.target.value}T00:00:00.000Z`).toISOString()
                      : undefined
                  }))
                }
              />
            </div>
            <div className="research-field">
              <label className="research-label" htmlFor="library-to">
                发布日期止
              </label>
              <input
                id="library-to"
                className="research-input"
                type="date"
                value={(filters.publishedTo ?? "").slice(0, 10)}
                onChange={(event) =>
                  setFilters((current) => ({
                    ...current,
                    publishedTo: event.target.value
                      ? new Date(`${event.target.value}T23:59:59.000Z`).toISOString()
                      : undefined
                  }))
                }
              />
            </div>
            <div className="research-field">
              <label className="research-label" htmlFor="library-language">
                语言
              </label>
              <input
                id="library-language"
                className="research-input"
                value={filters.language ?? ""}
                onChange={(event) => setFilters((current) => ({ ...current, language: event.target.value }))}
                placeholder="例如 en"
              />
              <span className="research-muted" data-testid="library-language-hint">
                只匹配已登记的语言：抓取时登记的语言，或已存译文的原文语言。不做语言猜测。
              </span>
            </div>
            <div className="research-field">
              <label className="research-label" htmlFor="library-session">
                来源研究
              </label>
              <select
                id="library-session"
                className="research-input"
                value={filters.sessionId ?? ""}
                onChange={(event) =>
                  setFilters((current) => ({
                    ...current,
                    sessionId: event.target.value || undefined
                  }))
                }
              >
                <option value="">全部可见研究</option>
                {sessions.map((session) => (
                  <option key={session.sessionId} value={session.sessionId}>
                    {session.access === "own"
                      ? "自有"
                      : `被授权/${grantScopeLabel(session.grantScope ?? "read")}`}{" "}
                    · {session.researchQuestion ?? session.sessionId.slice(0, 8)}
                  </option>
                ))}
              </select>
            </div>
            <div className="research-field">
              <label className="research-label" htmlFor="library-target">
                复制到本研究
              </label>
              <select
                id="library-target"
                className="research-input"
                data-testid="library-target"
                value={targetSessionId}
                onChange={(event) => setTargetSessionId(event.target.value)}
              >
                <option value="">选择目标研究</option>
                {ownSessions.map((session) => (
                  <option key={session.sessionId} value={session.sessionId}>
                    自有 · {session.researchQuestion ?? session.sessionId.slice(0, 8)}
                  </option>
                ))}
              </select>
              <span className="research-muted">
                只能复制到自有研究：被授权访问别人的研究不等于可以把资料写进它。
              </span>
            </div>
            <button className="research-button" type="submit" disabled={busy}>
              检索
            </button>
          </form>
          {!allowsEdit ? (
            <p className="research-muted" data-testid="library-readonly">
              当前账号为只读角色：可以检索与阅读被授权的资料，但不能复制或管理共享。
            </p>
          ) : null}
        </section>

        <section className="research-panel">
          <div className="research-panel-head">
            <span className="research-panel-title">可见研究</span>
          </div>
          <ul className="research-plain-list" data-testid="library-sessions">
            {sessions.map((session) => (
              <li key={session.sessionId} className="research-plain-list-item">
                <span className="research-source-title">
                  {session.researchQuestion ?? "未命名研究"}
                </span>
                <span className="research-muted">
                  {session.access === "own"
                    ? "自有"
                    : `被授权 · ${grantScopeLabel(session.grantScope ?? "read")}`}{" "}
                  · {session.sourceCount} 个来源 · 更新于 {shortDate(session.updatedAt)}
                </span>
              </li>
            ))}
            {sessions.length === 0 ? (
              <li className="research-muted">暂无可见研究。</li>
            ) : null}
          </ul>
        </section>
      </div>

      <div className="research-column">
        {message ? (
          <p className="research-muted" data-testid="library-message" role="status">
            {message}
          </p>
        ) : null}
        {error ? (
          <p className="research-error" data-testid="library-error" role="alert">
            {error}
          </p>
        ) : null}

        <section className="research-panel">
          <div className="research-panel-head">
            <span className="research-panel-title">
              检索结果（{results.length}/{total}）
            </span>
            <span className="research-muted">
              复制会带走原文快照，但不会带走对方的核实结论
            </span>
          </div>
          <div className="research-table-scroll">
            <table className="research-table" data-testid="library-results">
              <thead>
                <tr>
                  <th>来源</th>
                  <th>发布者 / 作者</th>
                  <th>域名</th>
                  <th>发布日期</th>
                  <th>已记录语言</th>
                  <th>版本</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {results.map((source) => (
                  <tr key={source.sourceId} data-testid="library-row">
                    <td>
                      <span className="research-source-title">{source.title}</span>
                      {lineage[source.sourceId] ? (
                        <span className="research-pill research-pill-neutral" data-testid="library-copy-pill">
                          副本 · {originStatusLabel(lineage[source.sourceId]!.originStatus)}
                        </span>
                      ) : null}
                    </td>
                    <td>
                      {source.publisher ?? "—"} / {source.author ?? "—"}
                    </td>
                    <td>{hostOf(source.canonicalUrl ?? source.url) ?? "—"}</td>
                    <td>{shortDate(source.publishedAt)}</td>
                    <td>{source.languages.length ? source.languages.join(", ") : "—"}</td>
                    <td>{source.snapshotCount}</td>
                    <td>
                      <button
                        className="research-button-secondary"
                        type="button"
                        onClick={() => void openSource(source.sourceId)}
                      >
                        查看原文与版本
                      </button>
                      <button
                        className="research-button"
                        type="button"
                        data-testid="library-copy"
                        disabled={
                          busy ||
                          !allowsEdit ||
                          !targetSessionId ||
                          !mayCopyFrom(source.sessionId)
                        }
                        title={
                          mayCopyFrom(source.sessionId)
                            ? "复制到选定的自有研究"
                            : "来源研究只授予了浏览权限，不能复制"
                        }
                        onClick={() => void copy(source, "copy")}
                      >
                        复制到本研究
                      </button>
                      {source.snapshotCount === 0 ? (
                        <button
                          className="research-button-secondary"
                          type="button"
                          disabled={
                            busy ||
                            !allowsEdit ||
                            !targetSessionId ||
                            !mayCopyFrom(source.sessionId)
                          }
                          onClick={() => void copy(source, "reference")}
                        >
                          仅引用
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
                {results.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="research-muted">
                      没有符合条件的来源。资料库不会把未授权研究的资料混入结果。
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>

        {detail ? (
          <section className="research-panel" data-testid="library-detail">
            <div className="research-panel-head">
              <span className="research-panel-title">{detail.title}</span>
              <span className="research-muted">
                {detail.publisher ?? "未记录发布者"} ·{" "}
                {hostOf(detail.canonicalUrl ?? detail.url) ?? "无链接"}
              </span>
            </div>
            <ul className="research-plain-list" data-testid="library-versions">
              {detail.versions.map((version) => (
                <li key={version.snapshotId} className="research-plain-list-item">
                  <span className="research-source-title">
                    版本 {version.contentHash.slice(0, 12)}
                  </span>
                  <span className="research-muted">
                    抓取于 {shortDate(version.retrievedAt)} · {version.charCount} 字 ·{" "}
                    {version.contentType}
                    {version.sourceLanguage ? ` · ${version.sourceLanguage}` : ""}
                  </span>
                  <button
                    className="research-button-secondary"
                    type="button"
                    onClick={() => void openVersion(detail.sourceId, version.snapshotId)}
                  >
                    阅读该版本
                  </button>
                </li>
              ))}
              {detail.versions.length === 0 ? (
                <li className="research-muted">该来源还没有已保存的原文。</li>
              ) : null}
            </ul>
            {openSnapshot ? (
              <pre
                data-testid="library-snapshot-content"
                style={{ maxHeight: 320, overflowY: "auto", whiteSpace: "pre-wrap" }}
              >
                {openSnapshot.content}
              </pre>
            ) : null}
          </section>
        ) : null}

        {allowsEdit && ownSessions.length > 0 ? (
          <section className="research-panel" data-testid="library-grants">
            <div className="research-panel-head">
              <span className="research-panel-title">共享管理</span>
              <span className="research-muted">
                撤销共享不会删除别人已复制走的副本与审计记录
              </span>
            </div>
            <div className="research-field">
              <label className="research-label" htmlFor="library-managed">
                管理哪个研究
              </label>
              <select
                id="library-managed"
                className="research-input"
                value={managedSessionId}
                onChange={(event) => setManagedSessionId(event.target.value)}
              >
                <option value="">选择研究</option>
                {ownSessions.map((session) => (
                  <option key={session.sessionId} value={session.sessionId}>
                    {session.researchQuestion ?? session.sessionId.slice(0, 8)}
                  </option>
                ))}
              </select>
            </div>
            <form className="research-form" onSubmit={submitGrant} data-testid="library-grant-form">
              <div className="research-field">
                <label className="research-label" htmlFor="library-subject-type">
                  授权对象
                </label>
                <select
                  id="library-subject-type"
                  className="research-input"
                  value={grantSubjectType}
                  onChange={(event) =>
                    setGrantSubjectType(event.target.value as "user" | "role")
                  }
                >
                  <option value="user">指定账号</option>
                  <option value="role">某个角色</option>
                </select>
              </div>
              <div className="research-field">
                <label className="research-label" htmlFor="library-subject-id">
                  {grantSubjectType === "user" ? "账号用户名或 ID" : "角色名"}
                </label>
                <input
                  id="library-subject-id"
                  className="research-input"
                  value={grantSubjectId}
                  onChange={(event) => setGrantSubjectId(event.target.value)}
                  placeholder={
                    grantSubjectType === "user"
                      ? "例如 viewer"
                      : "owner / reviewer / viewer"
                  }
                />
                <span className="research-muted" data-testid="library-subject-hint">
                  {grantSubjectType === "user"
                    ? "填用户名会自动解析成账号；匹配不到账号的授权会被拒绝，不会留下一条谁也用不上的授权。"
                    : "角色只能填 owner、reviewer 或 viewer。"}
                </span>
              </div>
              <div className="research-field">
                <label className="research-label" htmlFor="library-scope">
                  授权范围
                </label>
                <select
                  id="library-scope"
                  className="research-input"
                  value={grantScope}
                  onChange={(event) => setGrantScope(event.target.value as "read" | "copy")}
                >
                  <option value="read">可浏览</option>
                  <option value="copy">可浏览并复制</option>
                </select>
              </div>
              <button className="research-button" type="submit" disabled={busy}>
                授权
              </button>
            </form>
            <div className="research-table-scroll">
              <table className="research-table">
                <thead>
                  <tr>
                    <th>对象</th>
                    <th>范围</th>
                    <th>授权人</th>
                    <th>授权时间</th>
                    <th>状态</th>
                  </tr>
                </thead>
                <tbody>
                  {grants.map((grant) => (
                    <tr key={grant.id} data-testid="library-grant-row">
                      <td>
                        {grant.subjectType === "user" ? "账号" : "角色"} · {grant.subjectId}
                      </td>
                      <td>{grantScopeLabel(grant.scope)}</td>
                      <td>{grant.grantedBy}</td>
                      <td>{shortDate(grant.grantedAt)}</td>
                      <td>
                        {grant.revokedAt ? (
                          <span className="research-muted">
                            已撤销（{grant.revokedBy ?? "—"}）
                          </span>
                        ) : (
                          <button
                            className="research-button-secondary"
                            type="button"
                            data-testid="library-grant-revoke"
                            disabled={busy}
                            onClick={() => void revoke(grant.id)}
                          >
                            撤销
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {grants.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="research-muted">
                        这个研究还没有对外共享。
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
