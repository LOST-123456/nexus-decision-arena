"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  createSession,
  deleteSession,
  listSessions,
  type CreateSessionCommand,
  type SessionRelation,
  type SessionSummary
} from "../arena/api-client";
import { SessionRelationFilter } from "../arena/session-relation-filter";
import {
  presentRelations,
  RELATION_LABELS,
  visibleRelations
} from "../arena/session-relation";
import { workflowLabel } from "./labels";
import { toLoadFailure, type LoadFailure } from "../../lib/load-failure";

const emptyProject = {
  name: "",
  summary: "",
  targetUsers: "",
  businessModel: "",
  expectedData: ""
};

/**
 * What the API is told when an optional field is left alone.
 *
 * Every project field has to be a non-empty string on the server, so dropping
 * `required` from these inputs is only honest if something non-empty goes out.
 * This states that the field was not filled in, rather than inventing a value
 * for it or letting a 400 come back as a generic failure. The repository's own
 * integration tests fill the same fields with "n/a".
 */
const UNFILLED = "（未填写）";

/**
 * The recent-research list has three genuinely different states, and merging
 * them is a lie: "we could not reach the server" must never render as "you
 * have no research yet". A dead core used to fall through to the empty state
 * because the loader swallowed every failure into `[]`.
 *
 * `ready` carries the page cursor as well as the rows, because "these are all
 * of them" and "these are the first fifty of them" are different claims and the
 * header used to make the first one for a window of either size.
 */
type SessionsState =
  | { status: "loading" }
  | {
      status: "ready";
      sessions: SessionSummary[];
      nextCursor: string | null;
      hasNextPage: boolean;
    }
  /**
   * Carries the `kind`, not just a message. This read is account-scoped, so an
   * unauthenticated visitor is answered 401 — and the old single-message form
   * told that visitor to go and check that the core was running on 4100, then
   * offered a retry button that could only fail again.
   */
  | { status: "error"; failure: LoadFailure };

export function ResearchHome() {
  const router = useRouter();
  const [project, setProject] = useState(emptyProject);
  const [researchQuestion, setResearchQuestion] = useState("");
  const [sessions, setSessions] = useState<SessionsState>({ status: "loading" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);
  /** Row awaiting a second click before the destructive call goes out. */
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  /** Failure of the last delete attempt, shown instead of being swallowed. */
  const [listError, setListError] = useState<string | null>(null);
  /** A `loadMore` request is in flight; the button says so rather than repeating. */
  const [loadingMore, setLoadingMore] = useState(false);
  /**
   * Which reason is selected, and which ones this list has seen.
   *
   * Narrowed on the server: two people's researches interleave by `updated_at`,
   * so filtering the loaded window in the browser would report "none shared
   * with you" whenever the shared ones happen to sit beyond the first page.
   */
  const [relation, setRelation] = useState<SessionRelation | null>(null);
  const [relations, setRelations] = useState<SessionRelation[]>([]);

  const reload = useCallback(async (filter: SessionRelation | null) => {
    setSessions({ status: "loading" });
    try {
      const page = await listSessions(
        filter === null ? {} : { relation: filter }
      );
      setSessions({
        status: "ready",
        sessions: page.sessions,
        nextCursor: page.nextCursor,
        hasNextPage: page.hasNextPage
      });
      // Accumulated, never rebuilt from the filtered page: that page holds one
      // relation only, so rebuilding would erase the tabs needed to switch
      // back. `visibleRelations` re-sorts from the canonical order.
      setRelations((current) => {
        const merged = new Set<SessionRelation>(current);
        for (const item of presentRelations(page.sessions)) merged.add(item);
        return [...merged];
      });
    } catch (cause) {
      setSessions({
        status: "error",
        failure: toLoadFailure(cause, "研究列表不存在", "无法读取研究列表")
      });
    }
  }, []);

  useEffect(() => {
    void reload(relation);
  }, [reload, relation]);

  /**
   * The next window, appended.
   *
   * Appended and not replaced: the rows already on screen are pages the user
   * has already read, and swapping them out would make "load more" scroll the
   * list back to the top. No de-duplication is done here because the cursor is
   * a strict `(updated_at, id) <` comparison — pages cannot overlap. A session
   * edited between two requests moves ahead of the cursor and is therefore
   * missed, not repeated, which is the failure mode a cursor list is supposed
   * to have.
   */
  const loadMore = useCallback(async () => {
    if (sessions.status !== "ready") return;
    const { nextCursor, hasNextPage } = sessions;
    if (!hasNextPage || nextCursor === null) return;
    setLoadingMore(true);
    setListError(null);
    try {
      // Same filter as the first page: a cursor followed under a different
      // filter cuts page two out of another set, so rows repeat and others are
      // never reached.
      const page = await listSessions(
        relation === null ? { after: nextCursor } : { after: nextCursor, relation }
      );
      setSessions((current) =>
        current.status === "ready"
          ? {
              status: "ready",
              sessions: [...current.sessions, ...page.sessions],
              nextCursor: page.nextCursor,
              hasNextPage: page.hasNextPage
            }
          : current
      );
    } catch (cause) {
      setListError(
        cause instanceof Error ? cause.message : "加载更多失败，请重试。"
      );
    } finally {
      setLoadingMore(false);
    }
  }, [sessions, relation]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    // `required` rejects an empty box, not one holding only spaces — and the
    // API rejects an empty name outright. Saying it here keeps a whitespace-only
    // name from coming back as a generic 400.
    const name = project.name.trim();
    if (name === "") {
      setError("请填写研究名称。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const command: CreateSessionCommand = {
        project: {
          name,
          summary: project.summary.trim() || UNFILLED,
          targetUsers: project.targetUsers.trim() || UNFILLED,
          businessModel: project.businessModel.trim() || UNFILLED,
          expectedData: project.expectedData.trim() || UNFILLED
        },
        locale: "zh-CN",
        ...(researchQuestion.trim() ? { researchQuestion: researchQuestion.trim() } : {})
      };
      const key =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : String(Date.now());
      const created = await createSession(command, key);
      setCreatedId(created.id);
      setProject(emptyProject);
      setResearchQuestion("");
      // The button is labelled 创建并进入工作台, so it has to actually enter.
      // It used to only set `createdId` and render a small "已创建研究" link,
      // which left the page looking unchanged after a successful 201.
      router.push(`/research/${created.id}`);
      await reload(relation);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "创建研究失败");
    } finally {
      setBusy(false);
    }
  };

  /**
   * Deletes only after the operator has confirmed, and reports a failure
   * instead of swallowing it — a delete that silently did nothing is worse
   * than a visible error, because the row would look gone while still there.
   */
  const confirmDelete = async (sessionId: string) => {
    setDeletingId(sessionId);
    setListError(null);
    try {
      await deleteSession(sessionId);
      setPendingDeleteId(null);
      await reload(relation);
    } catch (cause) {
      setListError(cause instanceof Error ? cause.message : "删除失败，请重试。");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="research-body" data-mode="create">
      <div className="research-column">
        <section className="research-panel">
          <div className="research-panel-head">
            <span className="research-panel-title">新建研究</span>
          </div>
          <form className="research-form" onSubmit={submit}>
            <div className="research-field">
              <label className="research-label" htmlFor="project-name">
                研究名称（必填）
              </label>
              <input
                id="project-name"
                className="research-input"
                value={project.name}
                onChange={(event) =>
                  setProject({ ...project, name: event.target.value })
                }
                required
              />
              <p className="research-muted">
                取一个以后能一眼认出的名字，例如「危化品安全平台可行性」。
              </p>
            </div>
            <div className="research-field">
              <label className="research-label" htmlFor="research-question">
                研究问题（可选）
              </label>
              <textarea
                id="research-question"
                className="research-textarea"
                value={researchQuestion}
                onChange={(event) => setResearchQuestion(event.target.value)}
                placeholder="例如：该公司上一季度出货量是否同比增长？"
              />
              <p className="research-muted">
                这项研究要回答的那一个问题。先创建、之后在工作台补写也可以。
              </p>
            </div>
            <div className="research-field">
              <label className="research-label" htmlFor="project-summary">
                背景摘要（可选）
              </label>
              <textarea
                id="project-summary"
                className="research-textarea"
                value={project.summary}
                onChange={(event) =>
                  setProject({ ...project, summary: event.target.value })
                }
              />
              <p className="research-muted">
                为什么做这项研究、结论要支撑什么决策。留空将记为「未填写」。
              </p>
            </div>
            {(
              [
                [
                  "targetUsers",
                  "涉及对象（可选）",
                  "结论会影响或服务于谁，例如「采购委员会」。"
                ],
                [
                  "businessModel",
                  "业务模式（可选）",
                  "这项工作所在业务的收入或成本方式；不适用就留空。"
                ],
                [
                  "expectedData",
                  "已有资料（可选）",
                  "手上已经有哪些数据、报告或文档。"
                ]
              ] as const
            ).map(([field, label, hint]) => (
              <div className="research-field" key={field}>
                <label className="research-label" htmlFor={`project-${field}`}>
                  {label}
                </label>
                <input
                  id={`project-${field}`}
                  className="research-input"
                  value={project[field]}
                  onChange={(event) =>
                    setProject({ ...project, [field]: event.target.value })
                  }
                />
                <p className="research-muted">{hint}</p>
              </div>
            ))}
            {error ? (
              <p className="research-error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="research-actions">
              <button type="submit" className="research-button" disabled={busy}>
                创建并进入工作台
              </button>
            </div>
            <p className="research-muted">
              只有研究名称是必填。其余字段可以留空：留空的项目会记为「未填写」，之后在工作台里随时补充。
            </p>
          </form>
        </section>

        {createdId ? (
          <section className="research-panel">
            <p className="research-muted">
              已创建研究。
              <Link href={`/research/${createdId}`}> 进入研究工作台 →</Link>
            </p>
          </section>
        ) : null}
      </div>

      <div className="research-column">
        <section className="research-panel">
          <div className="research-panel-head">
            <span className="research-panel-title">最近研究</span>
            <span className="research-muted" data-testid="research-list-count">
              {sessions.status === "ready"
                ? sessions.hasNextPage
                  ? `已加载 ${sessions.sessions.length} 项`
                  : `共 ${sessions.sessions.length} 项`
                : sessions.status === "loading"
                  ? "载入中"
                  : "读取失败"}
            </span>
          </div>

          {/*
            Why a research is on this list. Every row says it in a badge too;
            this is the same fact made actionable, because "which of these did
            I make" is a question about the whole list rather than one row.
          */}
          {sessions.status === "error" ? null : (
            <SessionRelationFilter
              relations={visibleRelations(relations, relation)}
              value={relation}
              onChange={setRelation}
            />
          )}

          {listError ? (
            <p
              className="research-error"
              role="alert"
              data-testid="research-list-action-error"
            >
              {listError}
            </p>
          ) : null}

          {sessions.status === "loading" ? (
            <div className="research-empty" data-testid="research-list-loading">
              正在读取研究列表…
            </div>
          ) : sessions.status === "error" ? (
            <div
              className="research-empty research-empty-error"
              role="alert"
              data-testid="research-list-error"
            >
              <p className="research-empty-title">
                {sessions.failure.kind === "sign-in"
                  ? "需要登录"
                  : "无法读取研究列表"}
              </p>
              <p>
                {sessions.failure.kind === "sign-in"
                  ? "研究按账户隔离，登录后只能看到你有权查看的那些。"
                  : sessions.failure.message}
              </p>
              <p className="research-muted">
                {sessions.failure.kind === "sign-in"
                  ? "登录后回到这里，列表会自己加载。"
                  : "如果是刚启动，等几秒再试一次。"}
              </p>
              {sessions.failure.kind === "sign-in" ? (
                <Link className="research-button" href="/login">
                  去登录
                </Link>
              ) : (
                <button
                  type="button"
                  className="research-button"
                  onClick={() => void reload(relation)}
                >
                  重新加载
                </button>
              )}
            </div>
          ) : sessions.sessions.length === 0 ? (
            relation === null ? (
              <div className="research-empty" data-testid="research-list-empty">
                <p className="research-empty-title">还没有研究任务</p>
                <p className="research-muted">
                  在左边写下第一个研究问题，创建后会出现在这里。
                </p>
              </div>
            ) : (
              /*
               * A filtered list that came back empty is not an empty
               * workspace. Saying「还没有研究任务」here would contradict the
               * rows the user was reading one click earlier.
               */
              <div className="research-empty" data-testid="research-list-filter-empty">
                <p className="research-empty-title">
                  没有「{RELATION_LABELS[relation]}」的研究
                </p>
                <p className="research-muted">换一个来源看看，或者清除筛选。</p>
                <button
                  type="button"
                  className="research-button"
                  onClick={() => setRelation(null)}
                >
                  清除筛选
                </button>
              </div>
            )
          ) : (
            <div className="research-table-scroll">
              <table className="research-table">
                <thead>
                  <tr>
                    <th scope="col">研究</th>
                    <th scope="col">流程状态</th>
                    <th scope="col">分歧</th>
                    <th scope="col">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.sessions.map((session) => {
                    const confirming = pendingDeleteId === session.id;
                    const deleting = deletingId === session.id;
                    return (
                      <tr key={session.id}>
                        <td>
                          <Link href={`/research/${session.id}`}>
                            {session.projectName}
                          </Link>
                          <div className="research-muted">{session.id}</div>
                          {/*
                            On the row, not only in the filter: a single row
                            must still answer "is this mine?". Absent when the
                            deployment has no identities, where there is nobody
                            to attribute a research to.
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
                        </td>
                        <td>{workflowLabel(session.phase)}</td>
                        <td>{session.conflictCount}</td>
                        <td>
                          <div className="research-actions">
                            <Link
                              className="research-button research-button-secondary"
                              href={`/research/${session.id}/evidence`}
                            >
                              证据清单
                            </Link>
                            {confirming ? (
                              <>
                                <button
                                  type="button"
                                  className="research-button research-button-danger"
                                  data-testid="research-delete-confirm"
                                  disabled={deleting}
                                  aria-label={`确认删除研究 ${session.projectName}`}
                                  onClick={() => void confirmDelete(session.id)}
                                >
                                  {deleting ? "删除中…" : "确认删除"}
                                </button>
                                <button
                                  type="button"
                                  className="research-button research-button-secondary"
                                  data-testid="research-delete-cancel"
                                  disabled={deleting}
                                  onClick={() => setPendingDeleteId(null)}
                                >
                                  取消
                                </button>
                              </>
                            ) : (
                              <button
                                type="button"
                                className="research-button research-button-secondary"
                                data-testid="research-delete"
                                aria-label={`删除研究 ${session.projectName}`}
                                onClick={() => {
                                  setListError(null);
                                  setPendingDeleteId(session.id);
                                }}
                              >
                                删除
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/*
            Only while there is genuinely another page. The label does not say
            "加载更多" alone on purpose: the list is newest-first, so this
            fetches older researches, and a user who reads it as "more recent
            ones" would conclude the button did nothing.
          */}
          {sessions.status === "ready" && sessions.hasNextPage ? (
            <div className="research-actions" data-testid="research-list-more-row">
              <button
                type="button"
                className="research-button research-button-secondary"
                data-testid="research-list-more"
                disabled={loadingMore}
                onClick={() => void loadMore()}
              >
                {loadingMore ? "载入中…" : "加载更早的研究"}
              </button>
              <span className="research-muted">
                列表按最近更新排序，继续加载更早的记录。
              </span>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
