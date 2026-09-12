import type { AgentRole } from "@nexus/shared";

type AgentStatus =
  | "idle"
  | "running"
  | "completed"
  | "paused"
  | "failed";

export type AgentPanelRole = AgentRole & { status: AgentStatus };

const statusLabel: Record<AgentStatus, string> = {
  idle: "待命",
  running: "执行中",
  completed: "已完成",
  paused: "已暂停",
  failed: "失败"
};

export function AgentPanel({ roles }: { roles: AgentPanelRole[] }) {
  return (
    <aside
      className="agent-panel"
      aria-label="Agent Panel"
      data-testid="agent-panel"
    >
      <div className="panel-heading">
        <div>
          <p className="eyebrow">AGENT PANEL</p>
          <h2>审议角色</h2>
        </div>
        <span className="count-chip">{roles.length} AGENTS</span>
      </div>

      <ul className="agent-list">
        {roles.length === 0 ? (
          <li className="empty-copy">尚无 Agent 角色。</li>
        ) : (
          roles.map((role) => (
            <li
              key={role.id}
              className="agent-row"
              aria-label={`${role.name}：${statusLabel[role.status]}`}
            >
              <span
                className={`status-marker status-${role.status}`}
                aria-hidden="true"
              />
              <span className="agent-copy">
                <span className="agent-name-line">
                  <strong>{role.name}</strong>
                  <span className={`status-label status-${role.status}`}>
                    {statusLabel[role.status]}
                  </span>
                </span>
                <span>{role.perspective}</span>
                <span className="agent-lenses">
                  {role.lenses.slice(0, 3).join(" · ")}
                </span>
              </span>
            </li>
          ))
        )}
      </ul>

      <div className="panel-footnote">
        <span>独立审议</span>
        <span>证据约束</span>
        <span>交叉质询</span>
      </div>
    </aside>
  );
}
