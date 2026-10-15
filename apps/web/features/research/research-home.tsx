"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
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

export function ResearchHome() {
  const [project, setProject] = useState(emptyProject);
  const [researchQuestion, setResearchQuestion] = useState("");
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);

  const reload = () =>
    listSessions()
      .then(setSessions)
      .catch(() => setSessions([]));

  useEffect(() => {
    reload();
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const command: CreateSessionCommand = {
        project,
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
                研究名称
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
            </div>
            <div className="research-field">
              <label className="research-label" htmlFor="research-question">
                研究问题（这项研究要回答什么）
              </label>
              <textarea
                id="research-question"
                className="research-textarea"
                value={researchQuestion}
                onChange={(event) => setResearchQuestion(event.target.value)}
                placeholder="例如：该公司上一季度出货量是否同比增长？"
              />
            </div>
            <div className="research-field">
              <label className="research-label" htmlFor="project-summary">
                背景摘要
              </label>
              <textarea
                id="project-summary"
                className="research-textarea"
                value={project.summary}
                onChange={(event) =>
                  setProject({ ...project, summary: event.target.value })
                }
                required
              />
            </div>
            {(
              [
                ["targetUsers", "涉及对象"],
                ["businessModel", "业务模式"],
                ["expectedData", "已有资料"]
              ] as const
            ).map(([field, label]) => (
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
                  required
                />
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
            <span className="research-muted">
              {sessions ? `${sessions.length} 项` : "载入中"}
            </span>
          </div>
          {sessions === null ? (
            <div className="research-empty">正在载入…</div>
          ) : sessions.length === 0 ? (
            <div className="research-empty">还没有研究任务。</div>
          ) : (
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
                {sessions.map((session) => (
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
                        <button
                          type="button"
                          className="research-button research-button-secondary"
                          onClick={async () => {
                            await deleteSession(session.id).catch(() => undefined);
                            await reload();
                          }}
                        >
                          删除
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  );
}
