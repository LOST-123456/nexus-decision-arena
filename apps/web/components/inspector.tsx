import type { ClaimInspectorDTO } from "@nexus/shared";

export function Inspector({ data }: { data: ClaimInspectorDTO }) {
  return (
    <section className="inspector-panel" aria-label="Claim Inspector">
      <div className="inspector-title">
        <p className="eyebrow">INSPECTOR</p>
        <span className="count-chip">LIVE OBJECT</span>
      </div>

      <h2>{data.claim.statement}</h2>

      <div className="inspector-rationale">
        <p className="eyebrow">DECISION RATIONALE</p>
        <strong>{data.decisionRationale.outcome}</strong>
        <p>{data.decisionRationale.summary}</p>
      </div>

      <dl className="inspector-facts">
        <div>
          <dt>Evidence</dt>
          <dd>{data.evidence.length}</dd>
        </div>
        <div>
          <dt>Challenges</dt>
          <dd>{data.challenges.length}</dd>
        </div>
        <div>
          <dt>Conflicts</dt>
          <dd>{data.conflicts.length}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{data.claim.status}</dd>
        </div>
      </dl>

      <dl className="inspector-trace">
        <div>
          <dt>Decisive challenges</dt>
          <dd>{data.decisionRationale.decisiveChallengeIds.length}</dd>
        </div>
        <div>
          <dt>Linked evidence</dt>
          <dd>{data.decisionRationale.evidenceIds.length}</dd>
        </div>
      </dl>
    </section>
  );
}