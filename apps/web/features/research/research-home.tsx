"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  createSession,
  deleteSession,
  listSessions,
  type CreateSessionCommand,
  type SessionSummary
} from "../arena/api-client";
import { workflowLabel } from "./labels";

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
 */
type SessionsState =
  | { status: "loading" }
  | { status: "ready"; sessions: SessionSummary[] }
  | { status: "error"; message: string };

export function ResearchHome() {
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

  const reload = useCallback(async () => {
    setSessions({ status: "loading" });
    try {
      const loaded = await listSessions();
      setSessions({ status: "ready", sessions: loaded });
    } catch (cause) {
      setSessions({
        status: "error",
        message: cause instanceof Error ? cause.message : "无法读取研究列表"
      });
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

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
      await reload();
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
      await reload();
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
              <Link href={`/research/${createdId}`}> 打开 Research Workspace →</Link>
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
                ? `${sessions.sessions.length} 项`
                : sessions.status === "loading"
                  ? "载入中"
                  : "读取失败"}
            </span>
          </div>

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
              <p className="research-empty-title">无法读取研究列表</p>
              <p>{sessions.message}</p>
              <p className="research-muted">
                请确认核心 API 正在运行（默认 4100 端口），然后重试。
              </p>
              <button
                type="button"
                className="research-button"
                onClick={() => void reload()}
              >
                重新加载
              </button>
            </div>
          ) : sessions.sessions.length === 0 ? (
            <div className="research-empty" data-testid="research-list-empty">
              还没有研究任务。
            </div>
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
                        </td>
                        <td>{workflowLabel(session.phase)}</td>
                        <td>{session.conflictCount}</td>
                        <td>
                          <div className="research-actions">
                            <Link
                              className="research-button research-button-secondary"
                              href={`/research/${session.id}/evidence`}
                            >
                              证据
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
        </section>
      </div>
    </div>
  );
}
