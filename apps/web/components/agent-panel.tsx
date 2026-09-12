import type { AgentRole } from "@nexus/shared";

type AgentStatus =
  | "idle"
  | "running"
  | "completed"
  | "paused"
  | "failed";

export type AgentPanelRole = AgentRole & { status?: AgentStatus };

const statusLabel: Record<AgentStatus, string> = {
  idle: "\u5f85\u547d",
  running: "\u6267\u884c\u4e2d",
  completed: "\u5df2\u5b8c\u6210",
  paused: "\u5df2\u6682\u505c",
  failed: "\u5931\u8d25"
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
          <h2>{"\u5ba1\u8bae\u89d2\u8272"}</h2>
        </div>
        <span className="count-chip">{roles.length} AGENTS</span>
      </div>

      <ul className="agent-list">
        {roles.length === 0 ? (
          <li className="empty-copy">
            {"\u5c1a\u65e0 Agent \u89d2\u8272\u3002"}
          </li>
        ) : (
          roles.map((role) => {
            const status = role.status ?? "idle";
            return (
              <li
                key={role.id}
                className="agent-row"
                aria-label={`${role.name}, ${statusLabel[status]}`}
              >
                <span
                  className={`status-marker status-${status}`}
                  aria-hidden="true"
                />
                <span className="agent-copy">
                  <span className="agent-name-line">
                    <strong>{role.name}</strong>
                    <span className={`status-label status-${status}`}>
                      {statusLabel[status]}
                    </span>
                  </span>
                  <span>{role.perspective}</span>
                  <span className="agent-lenses">
                    {role.lenses.slice(0, 3).join(" \u00b7 ")}
                  </span>
                </span>
              </li>
            );
          })
        )}
      </ul>

      <div className="panel-footnote">
        <span>{"\u72ec\u7acb\u5ba1\u8bae"}</span>
        <span>{"\u8bc1\u636e\u7ea6\u675f"}</span>
        <span>{"\u4ea4\u53c9\u8d28\u8be2"}</span>
      </div>
    </aside>
  );
}