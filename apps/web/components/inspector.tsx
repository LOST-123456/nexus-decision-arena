import type { ClaimInspectorDTO } from "@nexus/shared";
import { claimStatusLabel } from "../features/research/labels";

/**
 * `decisionRationale.outcome` 的枚举名，是给代码看的，不是给读的人看的。
 *
 * 不直接复用 `claimStatusLabel`：那个映射的是「主张现在处于什么状态」，
 * 这个映射的是「这一轮裁决得出了什么」，两者值域也不完全相同（这里多
 * `needs_human`，那里多 `supported`）。硬套会让 `needs_human` 落到「待评估」，
 * 把「等人拍板」说成「还没评估」——两件事。
 *
 * `contested` 译作「未定论」而不是「有争议」，是为了和隔壁 `<dt>状态</dt>`
 * 的「有争议」区分开：同一个面板上出现两行一样的字，读的人会以为是重复渲染。
 */
const OUTCOME_LABELS: Record<
  ClaimInspectorDTO["decisionRationale"]["outcome"],
  string
> = {
  accepted: "已采纳",
  rejected: "已否决",
  contested: "未定论",
  needs_human: "待人工裁决"
};

export function Inspector({ data }: { data: ClaimInspectorDTO }) {
  return (
    <section className="inspector-panel" aria-label="主张检查器">
      <div className="inspector-title">
        <p className="eyebrow">INSPECTOR</p>
        <span className="count-chip">LIVE OBJECT</span>
      </div>

      <h2>{data.claim.statement}</h2>

      <div className="inspector-rationale">
        <p className="eyebrow">DECISION RATIONALE</p>
        <strong>{OUTCOME_LABELS[data.decisionRationale.outcome]}</strong>
        <p>{data.decisionRationale.summary}</p>
      </div>

      <dl className="inspector-facts">
        <div>
          <dt>证据</dt>
          <dd>{data.evidence.length}</dd>
        </div>
        <div>
          <dt>质询</dt>
          <dd>{data.challenges.length}</dd>
        </div>
        <div>
          <dt>冲突</dt>
          <dd>{data.conflicts.length}</dd>
        </div>
        <div>
          <dt>状态</dt>
          <dd>{claimStatusLabel(data.claim.status)}</dd>
        </div>
      </dl>

      <dl className="inspector-trace">
        <div>
          <dt>决定性质询</dt>
          <dd>{data.decisionRationale.decisiveChallengeIds.length}</dd>
        </div>
        <div>
          <dt>关联证据</dt>
          <dd>{data.decisionRationale.evidenceIds.length}</dd>
        </div>
      </dl>
    </section>
  );
}