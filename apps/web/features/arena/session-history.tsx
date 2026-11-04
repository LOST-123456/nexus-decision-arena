"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  getCurrentUser,
  deleteSession,
  listSessions,
  type AuthUser,
  type SessionRelation,
  type SessionSummary
} from "./api-client";
import { SessionRelationFilter } from "./session-relation-filter";
import {
  presentRelations,
  RELATION_LABELS,
  visibleRelations
} from "./session-relation";
import { ActionLink, Button } from "../../components/ui/button";
import { ConfirmDialog } from "../../components/ui/dialog";
import { Notice } from "../../components/ui/notice";
import { toLoadFailure, type LoadFailure } from "../../lib/load-failure";

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

export function SessionHistory() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  /**
   * The cursor for the next page, and whether there is one.
   *
   * The list is served one window at a time; without these two the header
   * printed "{n} SESSIONS" for a window of at most fifty and made it read like
   * the size of the workspace.
   */
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasNextPage, setHasNextPage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  /**
   * A failed *read* is not the same as a failed *action*, and they used to
   * share one string slot. That let "you are not signed in" render as
   * "操作失败 / Authentication required": half English, no way forward, and
   * describing a permission problem as if the click had gone wrong.
   */
  const [failure, setFailure] = useState<LoadFailure | null>(null);
  /** A failed delete or failed next-page read — the rows already read stay. */
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
  /**
   * Which relation is selected, and which ones the list has shown so far.
   *
   * The filter is server-side: it narrows the readable set before the page is
   * cut, so page two of 共享给我 is page two *of the shared ones* rather than
   * whatever shared rows happened to land in the first window. Doing it in the
   * browser would make the answer depend on how far down the user had scrolled.
   */
  const [relation, setRelation] = useState<SessionRelation | null>(null);
  const [relations, setRelations] = useState<SessionRelation[]>([]);
  // The session waiting for a confirmation. This used to be `window.confirm`,
  // which is the one confirmation in the app that cannot be styled, cannot be
  // reached by a screen reader's dialog pattern, and blocks the whole thread
  // while it is up. Deletion here is a cascading hard delete, so it now goes
  // through the same dialog every other destructive action uses.
  const [deleteTarget, setDeleteTarget] = useState<SessionSummary | null>(null);

  const load = useCallback(
    async (filter: SessionRelation | null): Promise<void> => {
      setLoading(true);
      setFailure(null);
      try {
        const page = await listSessions(
          filter === null ? {} : { relation: filter }
        );
        setSessions(page.sessions);
        setNextCursor(page.nextCursor);
        setHasNextPage(page.hasNextPage);
        // Accumulated, never replaced. A filtered page only contains the
        // selected relation, so rebuilding the tabs from it would delete every
        // other tab and leave the user stuck on a filter with no way back.
        // `visibleRelations` re-sorts from the canonical order, so the order
        // these were observed in does not leak into the tab strip.
        setRelations((current) => {
          const merged = new Set<SessionRelation>(current);
          for (const item of presentRelations(page.sessions)) merged.add(item);
          return [...merged];
        });
      } catch (reason) {
        // The list is account-scoped, so a signed-out visitor is answered 401
        // rather than an empty page. Saying "the service is unavailable" there
        // would send them to inspect a healthy process.
        setFailure(
          toLoadFailure(reason, "历史记录不存在", "无法加载历史记录")
        );
        setSessions([]);
        setNextCursor(null);
        setHasNextPage(false);
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    void load(relation);
  }, [load, relation]);

  useEffect(() => {
    getCurrentUser()
      .then(setCurrentUser)
      .catch(() => setCurrentUser(null));
  }, []);

  /** The next window, appended — the rows on screen are pages already read. */
  async function loadMore(): Promise<void> {
    if (!hasNextPage || nextCursor === null) return;
    setLoadingMore(true);
    setActionError(null);
    try {
      // The cursor alone is not enough: it must be followed under the same
      // filter that issued it, or page two is cut from a different set than
      // page one and the rows overlap while some never appear at all.
      const page = await listSessions(
        relation === null ? { after: nextCursor } : { after: nextCursor, relation }
      );
      setSessions((current) => [...current, ...page.sessions]);
      setNextCursor(page.nextCursor);
      setHasNextPage(page.hasNextPage);
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : "加载更多失败");
    } finally {
      setLoadingMore(false);
    }
  }

  async function remove(session: SessionSummary): Promise<void> {
    setBusyId(session.id);
    setActionError(null);
    try {
      await deleteSession(session.id);
      setSessions((current) =>
        current.filter((item) => item.id !== session.id)
      );
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : "删除失败");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <main id="main" tabIndex={-1} className="review-list-shell">
      <section className="review-list-content">
        <div className="review-list-heading">
          <div><p className="eyebrow">DECISION HISTORY</p><h1>历史记录</h1></div>
          {/*
            A failed read must not print "共 0 项". That is a count of a list
            nobody managed to fetch, printed where the workspace size goes.
          */}
          {failure ? null : (
            <span>{hasNextPage ? `已加载 ${sessions.length} 项` : `共 ${sessions.length} 项`}</span>
          )}
        </div>
        {actionError ? <div className="new-session-error" role="alert"><strong>操作失败</strong><p>{actionError}</p></div> : null}
        {/*
          Why a research is on this list, as a filter. Every card already says
          it in a badge; this is the same fact made actionable, because "which
          of these did I make" is a question about the whole list, not about
          one row at a time.
        */}
        {failure ? null : (
          <SessionRelationFilter
            relations={visibleRelations(relations, relation)}
            value={relation}
            onChange={setRelation}
          />
        )}
        {failure ? (
          <Notice
            testId="history-load-error"
            role="alert"
            eyebrow={failure.kind === "sign-in" ? "SIGN-IN REQUIRED" : "HISTORY UNAVAILABLE"}
            title={failure.kind === "sign-in" ? "需要登录" : "无法加载历史记录"}
            reason={
              failure.kind === "sign-in"
                ? "评审记录按账户隔离，登录后只能看到你有权查看的那些。"
                : failure.message
            }
            hint={
              failure.kind === "sign-in"
                ? "登录后回到这里，列表会自己加载。"
                : "如果是刚启动，等几秒再试一次。"
            }
            actions={
              failure.kind === "sign-in" ? (
                <ActionLink href="/login">去登录</ActionLink>
              ) : (
                <Button onClick={() => void load(relation)}>重新加载</Button>
              )
            }
          />
        ) : loading ? (
          <div className="review-empty" role="status">正在加载...</div>
        ) : sessions.length === 0 ? (
          relation === null ? (
            <div className="review-empty">
              <strong>还没有评审记录</strong>
              <p>创建第一个决策评审，它会出现在这里。</p>
              <ActionLink href="/sessions/new">新建评审</ActionLink>
            </div>
          ) : (
            /*
             * A filtered list that came back empty is not an empty workspace,
             * and saying "还没有评审记录" here would deny the existence of rows
             * the user was looking at one click ago.
             */
            <div className="review-empty" data-testid="history-filter-empty">
              <strong>没有「{RELATION_LABELS[relation]}」的记录</strong>
              <p>换一个来源看看，或者清除筛选。</p>
              <Button onClick={() => setRelation(null)}>清除筛选</Button>
            </div>
          )
        ) : (
          <div className="review-grid">
            {sessions.map((session) => {
              const reportReady = session.phase === "DECIDED" || session.phase === "REPORT_READY";
              return (
                <article className="review-card" key={session.id}>
                  <header>
                    <span className="review-phase">{session.phase.replaceAll("_", " ")}</span>
                    {/*
                      Stated on every row, not only in the filter: a card read
                      on its own must still answer "is this mine?". `null` is
                      the no-identity deployment, where there is nobody to
                      attribute the research to and a badge would invent one.
                    */}
                    {session.relation ? (
                      <span
                        className="relation-badge"
                        data-testid="relation-badge"
                        data-relation={session.relation}
                      >
                        {RELATION_LABELS[session.relation]}
                      </span>
                    ) : null}
                  </header>
                  <h2>{session.projectName}</h2>
                  <dl>
                    <div><dt>当前结论</dt><dd>{session.currentConclusion ?? "正在形成结论"}</dd></div>
                    <div><dt>冲突数量</dt><dd>{session.conflictCount}</dd></div>
                    <div><dt>最近更新</dt><dd>{formatTime(session.updatedAt)}</dd></div>
                  </dl>
                  <div className="review-actions">
                    <Link href={`/sessions/${session.id}`}>继续</Link>
                    {reportReady ? <Link href={`/sessions/${session.id}/report`}>查看报告</Link> : <span className="review-action-disabled">报告未就绪</span>}
                    {/*
                      The backend lets two people delete a research: whoever
                      owns the record, and whoever holds the global owner role.
                      The button used to be gated on the global role alone, so
                      a reviewer who had created the research — the row even
                      said "我创建的" in the badge above it — was not offered
                      the delete the backend would have allowed. Gating on the
                      same rule the server applies keeps the offer and the
                      permission from disagreeing.
                    */}
                    {session.relation === "owner" || currentUser?.role === "owner" ? (<button type="button" className="review-delete" disabled={busyId === session.id} onClick={() => setDeleteTarget(session)}>删除</button>) : null}
                  </div>
                </article>
              );
            })}
          </div>
        )}
        {/*
          The list is newest-first, so this fetches older records. Said out
          loud because "more" alone reads as "more recent" to anyone who
          expects an inbox.
        */}
        {hasNextPage ? (
          <div className="review-list-more">
            <button
              type="button"
              className="review-more"
              data-testid="session-history-more"
              disabled={loadingMore}
              onClick={() => void loadMore()}
            >
              {loadingMore ? "载入中…" : "加载更早的记录"}
            </button>
          </div>
        ) : null}
      </section>
      <ConfirmDialog
        open={deleteTarget !== null}
        title={deleteTarget ? `删除「${deleteTarget.projectName}」？` : ""}
        description="这会永久删除该评审会话及其主张、证据、运行记录与报告，无法恢复。"
        confirmLabel="删除"
        busy={deleteTarget !== null && busyId === deleteTarget.id}
        testId="session-delete-dialog"
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          const session = deleteTarget;
          if (!session) return;
          void (async () => {
            await remove(session);
            setDeleteTarget(null);
          })();
        }}
      />
    </main>
  );
}
