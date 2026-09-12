import Link from "next/link";
import { AgentPanel } from "../../../components/agent-panel";
import { DecisionMap } from "../../../components/decision-map";
import {
  previewSession,
  previewTimeline,
  type PreviewSession
} from "../../../features/arena/preview-session";

export default async function SessionPage({
  params
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  const session: PreviewSession = { ...previewSession, sessionId };
  const primaryConflict = session.conflicts[0];
  const checkpointActive =
    session.phase === "HUMAN_REVIEW" ||
    session.conflicts.some(
      (conflict) => conflict.humanDecisionRequired
    );

  return (
    <main className="workspace-shell">
      <header className="workspace-header">
        <Link className="brand-lockup brand-lockup-compact" href="/">
          <span className="brand-mark" aria-hidden="true">
            N
          </span>
          <span>
            <strong>Nexus Decision Arena</strong>
            <small>SESSION / {sessionId}</small>
          </span>
        </Link>

        <div className="workspace-vitals">
          <span>
            <small>当前结论</small>
            <strong>{session.currentConclusion}</strong>
          </span>
          <span>
            <small>运行阶段</small>
            <strong>{session.phase.replaceAll("_", " ")}</strong>
          </span>
          <span className={checkpointActive ? "vital-alert" : ""}>
            <small>人工介入</small>
            <strong>{checkpointActive ? "REQUIRED" : "NOT REQUIRED"}</strong>
          </span>
        </div>
      </header>

      <div className="workspace-main">
        <AgentPanel roles={session.agents} />

        <section className="decision-column" aria-label="Decision workspace">
          <DecisionMap session={session} />
        </section>

        <aside className="inspector-column" aria-label="Inspector">
          <div className="panel-heading inspector-heading">
            <div>
              <p className="eyebrow">INSPECTOR</p>
              <h2>决策证据</h2>
            </div>
            <span className="count-chip">LIVE OBJECT</span>
          </div>

          {checkpointActive ? (
            <section className="inspector-checkpoint">
              <p className="eyebrow">HUMAN CHECKPOINT</p>
              <h3>{primaryConflict?.summary ?? "等待人工裁决"}</h3>
              <p>
                {primaryConflict?.resolutionSuggestion ??
                  "需要人工确认后继续执行。"}
              </p>
              <div className="decision-actions" aria-label="待审批动作">
                <span>采纳质询</span>
                <span>维持判断</span>
                <span>补充分析</span>
              </div>
            </section>
          ) : null}

          <dl className="inspector-facts">
            <div>
              <dt>Claims</dt>
              <dd>{session.claims.length}</dd>
            </div>
            <div>
              <dt>Evidence</dt>
              <dd>{session.evidence.length}</dd>
            </div>
            <div>
              <dt>Challenges</dt>
              <dd>{session.challenges.length}</dd>
            </div>
            <div>
              <dt>Conflicts</dt>
              <dd>{session.conflicts.length}</dd>
            </div>
          </dl>

          <section className="inspector-trace">
            <p className="eyebrow">ACTIVE TRACE</p>
            <div>
              <span>Severity</span>
              <strong>{primaryConflict?.severity ?? "—"} / 5</strong>
            </div>
            <div>
              <span>Status</span>
              <strong>{primaryConflict?.status ?? "—"}</strong>
            </div>
            <div>
              <span>Impact</span>
              <strong>
                {primaryConflict?.impactScope.analysisAreas.join(" · ") ?? "—"}
              </strong>
            </div>
          </section>
        </aside>
      </div>

      <footer className="timeline" aria-label="Decision Timeline">
        <div className="timeline-title">
          <p className="eyebrow">DECISION TIMELINE</p>
          <span>SEQUENCE / 42</span>
        </div>
        <ol>
          {previewTimeline.map((event) => (
            <li key={event.id} data-sequence={event.sequence}>
              <span>#{String(event.sequence).padStart(2, "0")}</span>
              <strong>{event.label}</strong>
              <small>{event.type}</small>
            </li>
          ))}
        </ol>
      </footer>
    </main>
  );
}
