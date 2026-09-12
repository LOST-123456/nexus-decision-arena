import { AgentRoleSchema, newId, type AgentRole } from "@nexus/shared";

export const DEFAULT_AGENT_ROLES: AgentRole[] = [
  AgentRoleSchema.parse({
    id: newId(),
    key: "market_analyst",
    name: "市场分析师",
    goal: "验证需求与市场假设",
    perspective: "市场证据与获客路径",
    evaluationCriteria: ["需求真实性", "市场规模", "采购依据"],
    evidenceRequired: ["采购管道", "历史转化率"],
    conflictPreference: ["evidence_gap"],
    lenses: ["市场趋势", "数据可信度", "采购管道"],
    promptVersionId: newId()
  }),
  AgentRoleSchema.parse({
    id: newId(),
    key: "technical_expert",
    name: "技术专家",
    goal: "验证架构与实施周期",
    perspective: "硬件兼容与交付风险",
    evaluationCriteria: ["可行性", "工程量", "关键依赖"],
    evidenceRequired: ["原型报告", "兼容性测试"],
    conflictPreference: ["feasibility"],
    lenses: ["技术架构", "实现路径", "工程风险"],
    promptVersionId: newId()
  }),
  AgentRoleSchema.parse({
    id: newId(),
    key: "finance_analyst",
    name: "财务分析师",
    goal: "验证单位经济性",
    perspective: "收入、成本与现金流",
    evaluationCriteria: ["毛利率", "现金流", "成本结构"],
    evidenceRequired: ["成本拆分", "单位经济模型"],
    conflictPreference: ["assumption"],
    lenses: ["商业模式", "运营效率", "财务模型"],
    promptVersionId: newId()
  }),
  AgentRoleSchema.parse({
    id: newId(),
    key: "risk_auditor",
    name: "风险审查员",
    goal: "识别合规与责任边界",
    perspective: "数据安全与责任风险",
    evaluationCriteria: ["责任边界", "数据合规", "安全风险"],
    evidenceRequired: ["试点协议", "数据处理说明"],
    conflictPreference: ["logic_flaw"],
    lenses: ["合规审查", "伦理影响", "事故责任"],
    promptVersionId: newId()
  }),
  AgentRoleSchema.parse({
    id: newId(),
    key: "review_moderator",
    name: "质询主持人",
    goal: "推动结构化质询",
    perspective: "证据与逻辑一致性",
    evaluationCriteria: ["证据充分性", "逻辑一致性", "冲突严重度"],
    evidenceRequired: ["关键断言来源", "回应 Claim"],
    conflictPreference: ["contradiction"],
    lenses: ["逻辑分析", "冲突裁定", "重评估"],
    promptVersionId: newId()
  })
];
