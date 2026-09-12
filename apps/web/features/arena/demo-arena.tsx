"use client";

import type { HumanDecision } from "@nexus/shared";
import Link from "next/link";
import { useState } from "react";
import { AgentPanel, type AgentPanelRole } from "../../components/agent-panel";
import { DecisionMap } from "../../components/decision-map";
import { HumanCheckpoint } from "../../components/human-checkpoint";
import { Inspector } from "../../components/inspector";
import { Timeline, type TimelineEvent } from "../../components/timeline";
import type { ReplayableSession } from "./event-reducer";
import { toPreviewInspectorDTO } from "./preview-inspector";
import { previewSession } from "./preview-session";

const fixtureTimestamp = "2026-09-10T04:00:00.000Z";
const initialConclusion = "建议立项";
const postChallengeConclusion = "暂缓规模化扩张";
const limitedPilotConclusion = "有限立项";
const decisionExplanation =
  "先在 3 间实验室验证 12 个月，设置阶段验收门槛，验证通过后再讨论扩张。";

const demoRoles: AgentPanelRole[] = [
  {
    id: "demo-market",
    key: "market_analyst",
    name: "市场分析师",
    goal: "验证需求与市场假设",
    perspective: "市场证据与获客路径",
    evaluationCriteria: ["需求真实性", "市场规模", "获客依据"],
    evidenceRequired: ["采购管道", "历史转化率"],
    conflictPreference: ["evidence_gap"],
    lenses: ["市场趋势", "数据可信度", "采购管道"],
    promptVersionId: "demo-prompt-market",
    status: "completed"
  },
  {
    id: "demo-tech",
    key: "technical_expert",
    name: "技术专家",
    goal: "验证技术可行性",
    perspective: "架构与实施周期",
    evaluationCriteria: ["可行性", "工程量", "关键依赖"],
    evidenceRequired: ["原型报告", "兼容性测试"],
    conflictPreference: ["feasibility"],
    lenses: ["技术架构", "实现路径", "工程风险"],
    promptVersionId: "demo-prompt-tech",
    status: "completed"
  },
  {
    id: "demo-finance",
    key: "finance_analyst",
    name: "财务分析师",
    goal: "验证单位经济性",
    perspective: "收入与实施成本",
    evaluationCriteria: ["毛利率", "现金流", "成本结构"],
    evidenceRequired: ["成本拆分", "单位经济模型"],
    conflictPreference: ["assumption"],
    lenses: ["财务模型", "运营效率"],
    promptVersionId: "demo-prompt-finance",
    status: "completed"
  },
  {
    id: "demo-risk",
    key: "risk_auditor",
    name: "风险审查员",
    goal: "识别合规与责任风险",
    perspective: "安全、合规与伦理",
    evaluationCriteria: ["责任边界", "数据合规", "安全风险"],
    evidenceRequired: ["试点协议", "数据处理说明"],
    conflictPreference: ["logic_flaw"],
    lenses: ["合规审查", "伦理影响", "事故责任"],
    promptVersionId: "demo-prompt-risk",
    status: "completed"
  },
  {
    id: "demo-moderator",
    key: "review_moderator",
    name: "质询主持人",
    goal: "推动结构化质询",
    perspective: "证据与逻辑一致性",
    evaluationCriteria: ["证据充分性", "逻辑一致性", "冲突严重度"],
    evidenceRequired: ["关键断言来源", "回应 Claim"],
    conflictPreference: ["contradiction"],
    lenses: ["逻辑分析", "冲突裁定", "重评估"],
    promptVersionId: "demo-prompt-moderator",
    status: "completed"
  }
];

const legacyBaseSession: ReplayableSession = {
  sessionId: "demo",
  phase: "HUMAN_REVIEW",
  operationalStatus: "PAUSED",
  agents: demoRoles,
  claims: [
    {
      id: "demo-claim-growth",
      sessionId: "demo",
      agentRunId: "demo-run-market",
      roleId: "demo-market",
      lens: "采购管道",
      statement: "24 个月覆盖 200 间实验室缺少采购管道证据。",
      type: "assumption",
      stance: "oppose",
      importance: 5,
      confidence: 0.17,
      evidenceIds: [],
      status: "contested",
      rootClaimId: "demo-claim-growth",
      revision: 1,
      relations: [],
      createdAt: fixtureTimestamp,
      updatedAt: fixtureTimestamp
    }
  ],
  evidence: [],
  challenges: [
    {
      id: "demo-challenge-growth",
      sessionId: "demo",
      targetClaimId: "demo-claim-growth",
      challengerRunId: "demo-run-moderator",
      challengerRoleId: "demo-moderator",
      type: "evidence_gap",
      question: "24 个月覆盖 200 间实验室的采购管道依据是什么？",
      context: {
        triggerClaimIds: ["demo-claim-growth"],
        explanation: "扩张目标直接决定收入和实施资源。"
      },
      requiredEvidence: ["采购名单、意向书或历史转化率"],
      severity: 5,
      resolutionStrategy: "provide_evidence",
      status: "unresolved",
      correlationId: "demo-correlation-growth",
      createdAt: fixtureTimestamp,
      updatedAt: fixtureTimestamp
    }
  ],
  conflicts: [
    {
      id: "demo-conflict-growth",
      sessionId: "demo",
      claimIds: ["demo-claim-growth"],
      challengeIds: ["demo-challenge-growth"],
      type: "assumption",
      summary: "建议立项与暂缓规模化扩张存在冲突",
      severity: 5,
      status: "human_review",
      humanDecisionRequired: true,
      resolutionSuggestion: "采纳采购管道质询并改为有限试点",
      impactScope: {
        analysisAreas: ["market", "technology", "finance", "risk"],
        stakeholders: ["学校实验室", "项目团队"]
      },
      createdAt: fixtureTimestamp,
      updatedAt: fixtureTimestamp
    }
  ],
  humanDecisions: [],
  currentConclusion: postChallengeConclusion,
  lastSequence: 20
};

const baseSession: ReplayableSession = {
  ...structuredClone(previewSession),
  sessionId: "demo",
  claims: previewSession.claims.map((claim) => ({
    ...claim,
    sessionId: "demo"
  })),
  evidence: previewSession.evidence.map((item) => ({
    ...item,
    sessionId: "demo"
  })),
  challenges: previewSession.challenges.map((challenge) => ({
    ...challenge,
    sessionId: "demo"
  })),
  conflicts: previewSession.conflicts.map((conflict) => ({
    ...conflict,
    sessionId: "demo"
  })),
  humanDecisions: [],
  lastSequence: 20
};

const initialEvents: TimelineEvent[] = [
  {
    id: "demo-event-1",
    sequence: 1,
    type: "SESSION_STATE_CHANGED",
    label: "Planner"
  },
  {
    id: "demo-event-8",
    sequence: 8,
    type: "AGENT_RUN_STARTED",
    label: "五角色并行分析"
  },
  {
    id: "demo-event-20",
    sequence: 20,
    type: "HUMAN_REVIEW_REQUIRED",
    label: "人工检查点"
  }
];

type DecisionOutcome = {
  conclusion: string;
  challengeStatus: string;
  explanation: string | null;
};

function outcomeFor(action: HumanDecision["action"]): DecisionOutcome {
  if (action === "accept_challenge") {
    return {
      conclusion: limitedPilotConclusion,
      challengeStatus: "已采纳",
      explanation: decisionExplanation
    };
  }
  if (action === "uphold_claim") {
    return {
      conclusion: "维持建议立项",
      challengeStatus: "维持原判",
      explanation: "人工复核后维持原结论，并保留关键假设的持续监测要求。"
    };
  }
  return {
    conclusion: "要求补充分析",
    challengeStatus: "待补充",
    explanation: null
  };
}

export function DemoArena() {
  const [session, setSession] = useState<ReplayableSession>(baseSession);
  const [selectedSequence, setSelectedSequence] = useState(20);
  const [events, setEvents] = useState<TimelineEvent[]>(initialEvents);
  const [outcome, setOutcome] = useState<DecisionOutcome | null>(null);
  const [decidedSession, setDecidedSession] =
    useState<ReplayableSession | null>(null);

  const inspectorData = toPreviewInspectorDTO(session);
  const primaryConflict = session.conflicts[0];
  const primaryClaim = session.claims[0];
  const finalVisible = session.phase === "DECIDED" && outcome !== null;
  const opposingClaimCount = session.claims.filter(
    (claim) => claim.stance === "oppose"
  ).length;
  const challengeCount = session.challenges.length;
  const conflictCount = session.conflicts.length;

  function handleDecision(action: HumanDecision["action"], rationale: string) {
    if (!primaryConflict) {
      return;
    }

    const nextOutcome = outcomeFor(action);
    const decision: HumanDecision = {
      id: `demo-human-decision-${action}`,
      sessionId: "demo",
      conflictId: primaryConflict.id,
      action,
      rationale,
      affectedClaimIds: primaryClaim ? [primaryClaim.id] : [],
      affectedAgentRoleIds: [],
      previousConclusion: session.currentConclusion ?? initialConclusion,
      newConclusion: nextOutcome.conclusion,
      operatorId: "demo-operator",
      createdAt: fixtureTimestamp
    };

    setOutcome(nextOutcome);
    setSelectedSequence(21);
    setEvents((current) => [
      ...current.filter((event) => event.sequence !== 21),
      {
        id: "demo-event-21",
        sequence: 21,
        type: "SESSION_STATE_CHANGED",
        label: "人工裁决"
      }
    ]);
    const nextSession: ReplayableSession = {
      ...session,
      phase: action === "request_more_analysis" ? "REASSESSING" : "DECIDED",
      operationalStatus:
        action === "request_more_analysis" ? "ACTIVE" : "COMPLETED",
      currentConclusion: nextOutcome.conclusion,
      claims: session.claims.map((claim, index) =>
        index === 0 ? { ...claim, status: "accepted" } : claim
      ),
      challenges: session.challenges.map((challenge, index) =>
        index === 0
          ? {
              ...challenge,
              status:
                action === "request_more_analysis" ? "validating" : "resolved"
            }
          : challenge
      ),
      conflicts: session.conflicts.map((conflict, index) =>
        index === 0
          ? {
              ...conflict,
              status:
                action === "request_more_analysis" ? "detected" : "resolved",
              humanDecisionRequired: action === "request_more_analysis"
            }
          : conflict
      ),
      humanDecisions: [...session.humanDecisions, decision],
      lastSequence: 21
    };
    setSession(nextSession);
    setDecidedSession(nextSession);
  }

  function handleReplay(sequence: number) {
    setSelectedSequence(sequence);
    if (sequence >= 21 && decidedSession) {
      setSession(decidedSession);
      return;
    }
    if (sequence <= 8) {
      setSession({
        ...baseSession,
        phase: "ANALYZING",
        operationalStatus: "ACTIVE",
        agents: demoRoles.map((agent) => ({ ...agent, status: "running" })),
        claims: [],
        challenges: [],
        conflicts: [],
        currentConclusion: initialConclusion,
        lastSequence: sequence
      });
      return;
    }
    setSession({ ...baseSession, lastSequence: sequence });
  }

  return (
    <main
      className="demo-shell"
      data-demo-fixture="true"
      data-testid="demo-fixture"
      data-opposing-claim-count={opposingClaimCount}
      data-challenge-count={challengeCount}
      data-conflict-count={conflictCount}
    >
      <header className="demo-header" data-testid="workspace-header">
        <div className="demo-header-brand">
          <Link className="brand-lockup brand-lockup-compact" href="/">
            <span className="brand-mark" aria-hidden="true">
              N
            </span>
            <span>
              <strong>Nexus Decision Arena</strong>
              <small>FIXED DEMO / OFFLINE SAFE</small>
            </span>
          </Link>
          <span className="demo-fixture-badge">DEMO FIXTURE</span>
        </div>

        <dl className="demo-vitals">
          <div>
            <dt>{finalVisible ? "最终结论" : "初始结论"}</dt>
            <dd
              data-testid={
                finalVisible ? "final-conclusion" : "initial-conclusion"
              }
            >
              {finalVisible ? outcome.conclusion : initialConclusion}
            </dd>
          </div>
          <div>
            <dt>质询后结论</dt>
            <dd>{postChallengeConclusion}</dd>
          </div>
          <div>
            <dt>人工裁决</dt>
            <dd data-testid="challenge-status">
              {outcome?.challengeStatus ?? "待人工裁决"}
            </dd>
          </div>
          <div>
            <dt>反方 Claim</dt>
            <dd data-testid="opposing-claim-count">{opposingClaimCount}</dd>
          </div>
          <div>
            <dt>结构化质询</dt>
            <dd data-testid="challenge-count">{challengeCount}</dd>
          </div>
          <div>
            <dt>冲突</dt>
            <dd data-testid="conflict-count">{conflictCount}</dd>
          </div>
        </dl>
      </header>

      <div className="demo-main">
        <AgentPanel roles={session.agents} />

        <section
          className="demo-decision-column"
          aria-label="Decision workspace"
          data-testid="decision-region"
        >
          <DecisionMap session={session} />
        </section>

        <div className="demo-inspector-column" data-testid="inspector-column">
          {inspectorData ? (
            <Inspector data={inspectorData} />
          ) : (
            <section className="inspector-panel" aria-label="Claim Inspector">
              <p className="eyebrow">INSPECTOR</p>
              <p className="empty-copy">当前回放时刻没有 Claim。</p>
            </section>
          )}

          {session.phase === "HUMAN_REVIEW" ? (
            <HumanCheckpoint
              conflictSummary={primaryConflict?.summary ?? ""}
              onDecision={handleDecision}
              previewOnly
            />
          ) : finalVisible && outcome.explanation ? (
            <section
              className="decision-complete decision-explanation"
              data-testid="decision-explanation"
            >
              <p className="eyebrow">DECISION EXPLANATION</p>
              <h2>决策解释</h2>
              <p>{outcome.explanation}</p>
              <Link
                className="primary-link"
                href="/sessions/demo/report"
              >
                查看决策报告
                <span aria-hidden="true">→</span>
              </Link>
            </section>
          ) : null}
        </div>
      </div>

      <Timeline
        events={events}
        selectedSequence={selectedSequence}
        onSelect={handleReplay}
      />
    </main>
  );
}
