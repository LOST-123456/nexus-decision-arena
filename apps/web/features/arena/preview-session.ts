import type { AgentRole } from "@nexus/shared";
import type { AgentPanelRole } from "../../components/agent-panel";
import type { ReplayableSession } from "./event-reducer";

export type PreviewSession = Omit<ReplayableSession, "agents"> & {
  agents: Array<AgentRole & { status: AgentPanelRole["status"] }>;
};

const timestamp = "2026-09-10T04:00:00.000Z";
const sessionId = "preview";

const agents: PreviewSession["agents"] = [
  {
    id: "agent-market",
    key: "market_analyst",
    name: "市场分析师",
    goal: "验证需求与采购管道",
    perspective: "政策需求与获客路径",
    evaluationCriteria: ["需求真实性", "市场规模", "采购依据"],
    evidenceRequired: ["采购意向", "历史转化率"],
    conflictPreference: ["evidence_gap"],
    lenses: ["市场趋势", "数据可信度", "采购管道"],
    promptVersionId: "prompt-market",
    status: "paused"
  },
  {
    id: "agent-tech",
    key: "technical_expert",
    name: "技术专家",
    goal: "验证架构与实施周期",
    perspective: "硬件兼容与交付风险",
    evaluationCriteria: ["可行性", "工程量", "关键依赖"],
    evidenceRequired: ["原型报告", "兼容性测试"],
    conflictPreference: ["feasibility"],
    lenses: ["技术架构", "实现路径", "工程风险"],
    promptVersionId: "prompt-tech",
    status: "paused"
  },
  {
    id: "agent-finance",
    key: "finance_analyst",
    name: "财务分析师",
    goal: "验证单位经济性",
    perspective: "收入、成本与现金流",
    evaluationCriteria: ["毛利率", "现金流", "成本结构"],
    evidenceRequired: ["成本拆分", "单位经济模型"],
    conflictPreference: ["assumption"],
    lenses: ["商业模式", "运营效率", "财务模型"],
    promptVersionId: "prompt-finance",
    status: "paused"
  },
  {
    id: "agent-risk",
    key: "risk_auditor",
    name: "风险审查员",
    goal: "识别合规与责任边界",
    perspective: "数据安全与责任风险",
    evaluationCriteria: ["责任边界", "数据合规", "安全风险"],
    evidenceRequired: ["试点协议", "数据处理说明"],
    conflictPreference: ["logic_flaw"],
    lenses: ["合规审查", "伦理影响", "事故责任"],
    promptVersionId: "prompt-risk",
    status: "paused"
  },
  {
    id: "agent-moderator",
    key: "review_moderator",
    name: "质询主持人",
    goal: "推动结构化质询",
    perspective: "证据与逻辑一致性",
    evaluationCriteria: ["证据充分性", "逻辑一致性", "冲突严重度"],
    evidenceRequired: ["关键断言来源", "回应 Claim"],
    conflictPreference: ["contradiction"],
    lenses: ["逻辑分析", "冲突裁定", "重评估"],
    promptVersionId: "prompt-moderator",
    status: "paused"
  }
];

export const previewSession: PreviewSession = {
  sessionId,
  phase: "HUMAN_REVIEW",
  operationalStatus: "PAUSED",
  agents,
  claims: [
    {
      id: "claim-demand",
      sessionId,
      agentRunId: "run-market",
      roleId: "agent-market",
      lens: "市场趋势",
      statement: "高校实验室安全数字化需求明确，但采购管道尚未验证。",
      type: "assumption",
      stance: "neutral",
      importance: 5,
      confidence: 0.64,
      evidenceIds: ["evidence-policy"],
      status: "contested",
      rootClaimId: "claim-demand",
      revision: 1,
      relations: [],
      createdAt: timestamp,
      updatedAt: timestamp
    },
    {
      id: "claim-scope",
      sessionId,
      agentRunId: "run-market",
      roleId: "agent-market",
      lens: "采购管道",
      statement: "24 个月覆盖 200 间实验室的扩张目标缺少依据。",
      type: "assumption",
      stance: "oppose",
      importance: 5,
      confidence: 0.18,
      evidenceIds: [],
      status: "contested",
      rootClaimId: "claim-scope",
      revision: 1,
      relations: [],
      createdAt: timestamp,
      updatedAt: timestamp
    },
    {
      id: "claim-feasibility",
      sessionId,
      agentRunId: "run-tech",
      roleId: "agent-tech",
      lens: "实现路径",
      statement: "软件盘点原型可行，但硬件适配周期仍需验证。",
      type: "prediction",
      stance: "neutral",
      importance: 4,
      confidence: 0.61,
      evidenceIds: ["evidence-prototype"],
      status: "supported",
      rootClaimId: "claim-feasibility",
      revision: 1,
      relations: [],
      createdAt: timestamp,
      updatedAt: timestamp
    },
    {
      id: "claim-margin",
      sessionId,
      agentRunId: "run-finance",
      roleId: "agent-finance",
      lens: "财务模型",
      statement: "包含硬件与实施成本后，65% 毛利率假设不成立。",
      type: "prediction",
      stance: "oppose",
      importance: 5,
      confidence: 0.79,
      evidenceIds: [],
      status: "contested",
      rootClaimId: "claim-margin",
      revision: 1,
      relations: [],
      createdAt: timestamp,
      updatedAt: timestamp
    },
    {
      id: "claim-pilot",
      sessionId,
      agentRunId: "run-moderator",
      roleId: "agent-moderator",
      lens: "重评估",
      statement: "先完成 3 间实验室的有限试点，再决定是否扩张。",
      type: "recommendation",
      stance: "support",
      importance: 5,
      confidence: 0.88,
      evidenceIds: ["evidence-pilot-threshold"],
      status: "accepted",
      rootClaimId: "claim-pilot",
      revision: 1,
      relations: [],
      createdAt: timestamp,
      updatedAt: timestamp
    }
  ],
  evidence: [
    {
      id: "evidence-policy",
      sessionId,
      claimId: "claim-demand",
      kind: "project_input",
      title: "政策需求",
      content: "实验室安全管理数字化受政策推动。",
      description: "来自项目输入。",
      direction: "supports",
      reliability: 0.7,
      verificationStatus: "verified",
      retrievedAt: timestamp,
      createdBy: "system"
    },
    {
      id: "evidence-prototype",
      sessionId,
      claimId: "claim-feasibility",
      kind: "assumption",
      title: "软件原型判断",
      content: "现有二维码与视觉方案可作为软件原型基础。",
      description: "仍待硬件兼容性验证。",
      direction: "supports",
      reliability: 0.55,
      verificationStatus: "unverified",
      retrievedAt: timestamp,
      createdBy: "agent"
    },
    {
      id: "evidence-pilot-threshold",
      sessionId,
      claimId: "claim-pilot",
      kind: "calculation",
      title: "试点门槛",
      content: "以 3 间实验室和 12 个月作为阶段验收周期。",
      description: "用于控制采购、技术和合规风险。",
      direction: "supports",
      reliability: 0.82,
      verificationStatus: "verified",
      retrievedAt: timestamp,
      createdBy: "agent"
    }
  ],
  challenges: [
    {
      id: "challenge-scope",
      sessionId,
      targetClaimId: "claim-scope",
      challengerRunId: "run-moderator",
      challengerRoleId: "agent-moderator",
      type: "evidence_gap",
      question: "24 个月覆盖 200 间实验室的采购管道依据是什么？",
      context: {
        triggerClaimIds: ["claim-scope"],
        explanation: "扩张目标直接决定收入和实施资源。"
      },
      requiredEvidence: ["采购名单或历史转化率"],
      severity: 5,
      resolutionStrategy: "provide_evidence",
      status: "unresolved",
      correlationId: "correlation-scope",
      createdAt: timestamp,
      updatedAt: timestamp
    },
    {
      id: "challenge-pilot",
      sessionId,
      targetClaimId: "claim-pilot",
      challengerRunId: "run-tech",
      challengerRoleId: "agent-tech",
      type: "priority",
      question: "有限试点是否可以先降低技术集成风险？",
      context: {
        triggerClaimIds: ["claim-pilot"],
        explanation: "阶段验收可以减少一次性基础设施投入。"
      },
      requiredEvidence: ["试点成功指标"],
      severity: 4,
      resolutionStrategy: "revise_claim",
      status: "resolved",
      responseClaimId: "claim-pilot",
      correlationId: "correlation-pilot",
      createdAt: timestamp,
      updatedAt: timestamp
    }
  ],
  conflicts: [
    {
      id: "conflict-scale",
      sessionId,
      claimIds: ["claim-scope", "claim-margin"],
      challengeIds: ["challenge-scope"],
      type: "evidence",
      summary: "规模化目标与采购、成本证据发生冲突。",
      severity: 5,
      status: "human_review",
      humanDecisionRequired: true,
      resolutionSuggestion: "采纳质询，将规模化改为有限试点。",
      impactScope: {
        analysisAreas: ["market", "finance", "operations"],
        stakeholders: ["项目团队", "高校实验室"]
      },
      createdAt: timestamp,
      updatedAt: timestamp
    },
    {
      id: "conflict-tech",
      sessionId,
      claimIds: ["claim-feasibility"],
      challengeIds: ["challenge-pilot"],
      type: "logic",
      summary: "技术可行性依赖尚未量化的交付约束。",
      severity: 3,
      status: "resolved",
      humanDecisionRequired: false,
      resolutionSuggestion: "将硬件兼容性报告设为试点前置条件。",
      impactScope: {
        analysisAreas: ["technology", "risk"],
        stakeholders: ["技术团队"]
      },
      createdAt: timestamp,
      updatedAt: timestamp
    }
  ],
  humanDecisions: [],
  currentConclusion: "暂缓规模化，转入有限试点",
  lastSequence: 42
};

export const previewTimeline = [
  { id: "timeline-01", sequence: 1, type: "SESSION_STATE_CHANGED", label: "Planner" },
  { id: "timeline-08", sequence: 8, type: "AGENT_RUN_STARTED", label: "并行分析" },
  { id: "timeline-16", sequence: 16, type: "CLAIM_CREATED", label: "Claim 入库" },
  { id: "timeline-24", sequence: 24, type: "CHALLENGE_CREATED", label: "交叉质询" },
  { id: "timeline-33", sequence: 33, type: "CONFLICT_DETECTED", label: "冲突发现" },
  { id: "timeline-42", sequence: 42, type: "HUMAN_REVIEW_REQUIRED", label: "人工检查点" }
] as const;
