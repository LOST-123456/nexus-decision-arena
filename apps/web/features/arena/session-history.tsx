"use client";

import Link from "next/link";
import { AuthUserBadge } from "../../components/auth-user-badge";
import { useEffect, useState } from "react";
import {
  getCurrentUser,
  deleteSession,
  listSessions,
  type AuthUser,
  type SessionSummary
} from "./api-client";

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

export function SessionHistory() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);

  useEffect(() => {
    getCurrentUser()
      .then(setCurrentUser)
      .catch(() => setCurrentUser(null));
    listSessions()
      .then(setSessions)
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : "历史记录加载失败")
      )
      .finally(() => setLoading(false));
  }, []);

  async function remove(session: SessionSummary): Promise<void> {
    if (!window.confirm(`确认删除“${session.projectName}”？`)) return;
    setBusyId(session.id);
    try {
      await deleteSession(session.id);
      setSessions((current) =>
        current.filter((item) => item.id !== session.id)
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "删除失败");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <main className="review-list-shell">
      <header className="review-list-header">
        <Link className="brand-lockup brand-lockup-compact" href="/">
          <span className="brand-mark" aria-hidden="true">N</span>
          <span>
            <strong>Nexus Decision Arena</strong>
            <small>DECISION HISTORY</small>
          </span>
        </Link>
        <div className="entry-actions">
          <AuthUserBadge />
          <Link className="header-secondary-link" href="/sessions/demo">固定演示</Link>
          <Link className="primary-link" href="/sessions/new">新建评审 <span aria-hidden="true">→</span></Link>
        </div>
      </header>
      <section className="review-list-content">
        <div className="review-list-heading">
          <div><p className="eyebrow">DECISION HISTORY</p><h1>历史记录</h1></div>
          <span>{sessions.length} SESSIONS</span>
        </div>
        {error ? <div className="new-session-error"><strong>操作失败</strong><p>{error}</p></div> : null}
        {loading ? <div className="review-empty">正在加载...</div> : sessions.length === 0 ? (
          <div className="review-empty"><strong>还没有评审记录</strong><p>创建项目后会在这里显示。</p></div>
        ) : (
          <div className="review-grid">
            {sessions.map((session) => {
              const reportReady = session.phase === "DECIDED" || session.phase === "REPORT_READY";
              return (
                <article className="review-card" key={session.id}>
                  <header><span className="review-phase">{session.phase.replaceAll("_", " ")}</span></header>
                  <h2>{session.projectName}</h2>
                  <dl>
                    <div><dt>当前结论</dt><dd>{session.currentConclusion ?? "正在形成结论"}</dd></div>
                    <div><dt>冲突数量</dt><dd>{session.conflictCount}</dd></div>
                    <div><dt>最近更新</dt><dd>{formatTime(session.updatedAt)}</dd></div>
                  </dl>
                  <div className="review-actions">
                    <Link href={`/sessions/${session.id}`}>继续</Link>
                    {reportReady ? <Link href={`/sessions/${session.id}/report`}>查看报告</Link> : <span className="review-action-disabled">报告未就绪</span>}
                    {currentUser?.role === "owner" ? (<button type="button" className="review-delete" disabled={busyId === session.id} onClick={() => remove(session)}>删除</button>) : null}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}
