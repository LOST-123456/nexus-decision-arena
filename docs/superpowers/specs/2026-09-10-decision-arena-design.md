# Nexus Decision Arena 设计冻结规格

> 状态：已确认  
> 日期：2026-09-10  
> 对应计划：`01_竞赛总计划_V3_评委程序员重审版.md`

## 1. 产品定义

Nexus Decision Arena，中文名为“Nexus 智能决策质询沙盘”，是面向真实决策评审的多 Agent 系统。

系统让五个具有明确立场、证据要求和评审标准的 AI 角色先独立分析，再针对关键 Claim 进行交叉质询，系统将未解决分歧结构化为 Conflict，并交给人类完成裁决。最终输出可追溯、可回放、可复现的决策报告。

核心价值不是让多个 Agent 各说一句话，而是保证：

1. 不同意见可以被结构化表达。
2. 每个关键断言都可以被异角色质询。
3. 结论变化可以追溯到证据、质询、重评估和人工裁决。
4. 同一输入可以在 Mock Mode 中稳定复现。

### 1.1 比赛目标

- 新用户无需培训即可完成一次完整评审。
- 完整产品演示控制在 5 分 20 秒内。
- 总演示视频控制在 8 分钟内，其中 AI 协同过程复现至少 2 分 40 秒。
- 20 次固定输入运行无崩溃。
- 无外网、无模型 API 时，Mock Mode 仍能完整运行。
- Git、Prompt、测试、事件和 Commit 形成相互映射的证据链。

### 1.2 非目标

- 不实现通用 Agent 工作流编辑器。
- 不允许用户自由拖拽任意节点构造无限状态图。
- 不把 Agent 业务规则写入 UI 组件。
- 不在首版实现多语言界面或双语报告。
- 不自动做出最终高风险决策，最终裁决必须由人类确认。
- 不依赖外部搜索或模型 API 才能完成固定 Demo。

## 2. 固定 Demo 场景

### 2.1 待评审项目

项目名称：高校实验室 AI 危化品库存与安全预警平台。

- 目标用户：高校实验室、学院资产管理部门、实验室安全负责人。
- 产品方案：二维码盘点、图像识别、补货预测、过期试剂预警和事故风险提示。
- 商业模式：每间实验室每年 8 万元，首批免费试点，后续按年续费。
- 目标数据：24 个月覆盖 200 间实验室，取得 1600 万元 ARR，毛利率 65%。
- 计划周期：6 个月完成产品 MVP。

输入中包含四个需要重点验证的假设：

1. 24 个月获得 200 间实验室。
2. 6 个月完成硬件与算法集成。
3. 毛利率达到 65%。
4. 高校采购周期不超过 90 天。

### 2.2 预期结论变化

- 初始结论：建议立项。
- 交叉质询后：暂缓规模化扩张。
- 人工裁决：采纳关键质询，进入有限立项。
- 最终结论：先在 3 间实验室验证 12 个月，设置阶段验收门槛，验证通过后再讨论扩张。

### 2.3 演示结果约束

- 初始分析至少出现 3 个方向不一致的 Claim。
- Cross Examination 至少产生 5 个结构化 Challenge。
- Conflict Detector 至少生成 3 个 Conflict。
- Human Checkpoint 必须展示“采纳质询”“维持判断”“补充分析”三种动作。
- Decision Replay 必须能够从最终结论返回到导致结论变化的质询和人工裁决。

## 3. 设计原则

1. **领域优先**：数据模型围绕 Claim、Evidence、Challenge 和 Conflict 设计，不围绕通用 Node/Edge 设计。
2. **确定性编排**：Planner、排序、角色分配、冲突规则和状态迁移由确定性代码执行。
3. **受限生成**：LLM 只生成结构化领域对象或受约束的语义判断。
4. **证据优先**：假设必须标记为 Assumption，不得伪装成 Fact。
5. **版本不可覆盖**：Claim 的实质变化产生新版本，不原地覆盖旧结论。
6. **人类最终裁决**：系统可以建议，不能自动消解高严重度 Conflict。
7. **事件是事实源**：UI 状态由持久化事件和查询结果恢复，不由临时前端状态决定。
8. **默认可复现**：固定 Fixture 与 Mock Provider 是默认开发路径，真实模型是可切换适配器。

## 4. Agent 模型

系统使用五个一级 Agent。每个 Agent 内部可以有多个分析 Lens，但运行和展示仍以五个角色为单位。

| Agent | 内部 Lens | 主要职责 |
|---|---|---|
| 市场分析师 | 市场趋势、用户需求、规模测算；数据清洗、可信度、统计口径 | 判断需求真实性、市场规模、获客路径和竞争差异 |
| 技术专家 | 技术架构与可行性；实现路径、工程量、工程风险 | 判断技术可行性、关键依赖、数据条件和实施周期 |
| 财务分析师 | 商业模式与财务模型；运营成本、效率、资源消耗 | 判断成本、收入、现金流、单位经济和运营可行性 |
| 风险审查员 | 合规、隐私、安全；社会、环境和伦理影响 | 检查法律、合规、责任边界、安全和关键假设失效风险 |
| 质询主持人 | 证据充分性；逻辑一致性；矛盾识别与重新评估 | 选择质询目标、核验回应、推动重新评估和生成决策解释 |

每个 AgentRole 包含：

```ts
AgentRole {
  id: string;
  name: string;
  role: string;
  goal: string;
  perspective: string;
  evaluationCriteria: string[];
  evidenceRequired: string[];
  conflictPreference: string[];
  lenses: string[];
  promptVersionId: string;
}
```

Planner、冲突检测器、报告生成器是确定性组件，不占用 Agent 名额：

- Planner 选择角色、生成评审任务并建立运行顺序。
- 冲突检测器根据 Claim、Challenge 和版本关系生成 Conflict。
- 报告生成器只汇总已通过 Schema 校验的领域对象、人工裁决和指标。

## 5. 核心领域对象

### 5.1 通用规则

- 所有持久化对象使用 UUIDv7。
- 所有对象包含 `createdAt`、`updatedAt` 和可适用的 `sessionId`。
- 所有模型生成对象包含 `agentRunId`、`promptVersionId` 和 `correlationId`。
- 引用必须通过 Schema 校验，禁止悬空引用。
- 所有变更必须以 `ExecutionEvent` 记录。

### 5.2 Claim

Claim 是可质询的原子断言。

```ts
Claim {
  id: string;
  sessionId: string;
  agentRunId: string;
  roleId: string;
  lens: string;
  statement: string;
  type: "fact" | "assumption" | "prediction" | "recommendation";
  stance: "support" | "oppose" | "neutral";
  importance: 1 | 2 | 3 | 4 | 5;
  confidence: number; // 0..1
  evidenceIds: string[];
  status: "proposed" | "supported" | "contested" | "accepted" | "rejected";
  rootClaimId: string;
  revisionOfClaimId?: string;
  revision: number;
  relations: Array<{
    targetClaimId: string;
    type: "supports" | "contradicts" | "qualifies" | "depends_on";
  }>;
  respondsToChallengeId?: string;
  disposition?: "accept" | "reject" | "qualify" | "insufficient_evidence";
  createdAt: string;
  updatedAt: string;
}
```

Claim 约束：

- 根版本的 `rootClaimId` 等于自身 ID，`revision` 从 1 开始。
- 任意实质修改创建新 Claim，并引用被修订版本。
- `accepted` 且重要性大于等于 4 的 Claim 必须至少关联一条已核验 Evidence。
- 高严重度 Challenge 未解决时，目标 Claim 不能进入 `accepted`。

### 5.3 Evidence

Evidence 是 Claim 的支撑或反证材料。

```ts
Evidence {
  id: string;
  sessionId: string;
  claimId: string;
  kind: "project_input" | "calculation" | "external_reference" | "assumption";
  title: string;
  content: string;
  description: string;
  sourceRef?: string;
  direction: "supports" | "opposes";
  reliability: number; // 0..1
  verificationStatus: "unverified" | "verified" | "rejected";
  validityPeriod?: {
    from?: string;
    to?: string;
  };
  retrievedAt: string;
  createdBy: "system" | "agent" | "human";
  agentRunId?: string;
}
```

Evidence 约束：

- `external_reference` 必须提供 `sourceRef`。
- `assumption` 永远不能转为 `verified`，只能被新 Evidence 支持或否定。
- 当前时间超出 `validityPeriod` 时，Evidence 标记为过期，不能支撑最终接受状态。
- 系统输入中的数字必须记录计算口径或来源。

### 5.4 Challenge

Challenge 是一个 Agent 对具体 Claim 的定向质疑。

```ts
Challenge {
  id: string;
  sessionId: string;
  targetClaimId: string;
  challengerRunId: string;
  challengerRoleId: string;
  type:
    | "evidence_gap"
    | "logic_flaw"
    | "contradiction"
    | "feasibility"
    | "priority";
  question: string;
  context: {
    triggerClaimIds: string[];
    explanation: string;
  };
  requiredEvidence: string[];
  severity: 1 | 2 | 3 | 4 | 5;
  resolutionStrategy:
    | "provide_evidence"
    | "revise_claim"
    | "withdraw_claim"
    | "human_decision";
  status: "open" | "answered" | "validating" | "resolved" | "unresolved";
  responseClaimId?: string;
  correlationId: string;
  createdAt: string;
  updatedAt: string;
}
```

### 5.5 Conflict

Conflict 是系统检测出的结构化决策分歧。

```ts
Conflict {
  id: string;
  sessionId: string;
  claimIds: string[];
  challengeIds: string[];
  type: "evidence" | "logic" | "assumption" | "priority";
  summary: string;
  severity: 1 | 2 | 3 | 4 | 5;
  status: "detected" | "human_review" | "resolved";
  humanDecisionRequired: boolean;
  resolutionSuggestion: string;
  impactScope: {
    analysisAreas: Array<
      "market" | "technology" | "finance" | "risk" | "operations"
    >;
    stakeholders: string[];
  };
  createdAt: string;
  updatedAt: string;
}
```

Conflict 约束：

- 至少关联两个 Claim，或一个 Claim 加一个未解决的高严重度 Challenge。
- `resolutionSuggestion` 只代表建议，不能自动关闭 Conflict。
- 严重度大于等于 4，或 `impactScope.analysisAreas.length >= 3` 时，`humanDecisionRequired` 必须为 true。
- 人工裁决前，Conflict 状态不得直接进入 `resolved`。

## 6. DecisionSession 状态机

领域阶段使用固定状态机：

```text
CREATED
  -> PLANNING
  -> ANALYZING
  -> CHALLENGING
  -> CONFLICT_DETECTED
  -> HUMAN_REVIEW
  -> REASSESSING
  -> DECIDED
  -> REPORT_READY
```

允许的补充迁移：

- `CHALLENGING -> DECIDED`：没有需要人工裁决的 Conflict。
- `CONFLICT_DETECTED -> DECIDED`：冲突已由确定性规则解决，且不需要人工裁决。
- `REASSESSING -> CHALLENGING`：人工要求补充分析，最多进行一轮补充质询。

运行健康状态与领域阶段分离：

```ts
operationalStatus: "ACTIVE" | "PAUSED" | "FAILED" | "COMPLETED";
```

- 单个 AgentRun 失败不会改变整个会话的 `operationalStatus`，除非所有关键 AgentRun 均失败。
- `PAUSED` 必须记录暂停原因和恢复阶段。
- 刷新页面后，通过 `DecisionSession.phase`、`operationalStatus` 和事件序列恢复状态。

## 7. Cross Examination 协议

### 7.1 执行顺序

```text
五角色独立分析
  -> Schema 校验与 Claim 去重
  -> 选择最多 5 个高优先级 Claim
  -> 为每个 Claim 分配 1 至 2 个异角色质询者
  -> 生成结构化 Challenge
  -> 目标 Agent 以新版 Claim 回应
  -> 质询主持人核验回应
  -> 标记 resolved 或 unresolved
  -> 冲突检测器生成 Conflict
  -> 高严重度 Conflict 进入 Human Checkpoint
```

### 7.2 核心规则

1. 初次分析期间，Agent 不得读取其他 Agent 的输出。
2. 一个 Challenge 只能指向一个 Claim。
3. 质询者不得质询自己创建的 Claim。
4. 每个 Challenge 必须包含问题、上下文、所需证据、严重度和解决策略。
5. 目标 Agent 必须创建新版 Claim 回应，不能覆盖原 Claim。
6. 质询主持人只能核验回应是否满足协议，不能擅自修改其他 Agent 的立场。
7. 未解决的高严重度 Conflict 必须进入 Human Checkpoint。

### 7.3 Claim 选择

选择顺序是确定性的，依次比较：

1. `importance` 降序。
2. 证据覆盖率升序。
3. `confidence` 升序。
4. 类型优先级：`assumption > prediction > recommendation > fact`。
5. UUIDv7 稳定排序。

### 7.4 质询者分配

- 市场分析师优先质询市场假设和证据缺口。
- 技术专家优先质询技术可行性和实现风险。
- 财务分析师优先质询成本、收入和单位经济假设。
- 风险审查员优先质询合规、伦理和关键假设失效风险。
- 质询主持人负责逻辑矛盾和跨角色冲突。

### 7.5 Challenge 状态流

```text
open -> answered -> validating -> resolved
                              \-> unresolved
```

### 7.6 运行限制

- 每轮最多选择 5 个 Claim。
- 每个 Claim 最多分配 2 个质询者。
- 最多执行一次人工触发的补充质询。
- 单次模型调用超时 45 秒。
- 结构错误最多执行一次 Repair Prompt。
- 失败隔离在当前 AgentRun 或 Challenge，不阻断其他分支。
- 所有写操作使用 `Idempotency-Key`，重复请求返回相同结果。

## 8. 冲突检测与人工裁决

Conflict 由以下规则产生：

1. 两个 Claim 对同一议题持相反立场。
2. 高重要度 Claim 缺少已验证 Evidence。
3. 高严重度 Challenge 未解决。
4. 新版本 Claim 与旧版本或相关 Claim 逻辑冲突。
5. 不同角色对同一核心假设给出显著不同的置信度。

人工裁决选项：

```ts
HumanDecision {
  id: string;
  sessionId: string;
  conflictId: string;
  action: "accept_challenge" | "uphold_claim" | "request_more_analysis";
  rationale: string;
  affectedClaimIds: string[];
  affectedAgentRoleIds: string[];
  previousConclusion: string;
  newConclusion: string;
  operatorId: string;
  createdAt: string;
}
```

人工裁决必须触发事件、进入 Decision Replay，并影响最终报告中的决策解释。

## 9. Decision Map 与 UX

### 9.1 页面布局

- 左侧：五个 Agent 的状态、Lens、当前任务和运行健康状态。
- 中央：Decision Map，展示 Agent、Claim、Challenge、Conflict 和当前结论。
- 右侧：Inspector，展示选中对象的证据、版本、Prompt、Trace 和决策解释。
- 底部：Decision Timeline，支持状态回放和关键时刻跳转。

移动端将中央 Decision Map 作为主线纵向展示，Agent 和 Inspector 使用底部抽屉打开。

### 9.2 节点状态

```text
idle -> running -> completed
                   |-> challenged
                   |-> conflict
                   |-> paused
                   |-> failed
```

### 9.3 连线语义

- 实线：正常数据流。
- 流动虚线：正在执行。
- 红色连线：未解决质询。
- 橙色连线：已检测到 Conflict。
- 绿色连线：已解决并被接受。

### 9.4 交互要求

- 点击 Agent：查看职责、Lens、状态和调用记录。
- 点击 Claim：查看 Evidence、置信度、版本和关联 Claim。
- 点击 Challenge：查看问题、目标、回应和主持人判定。
- 点击 Conflict：查看严重度、影响范围和待裁决事项。
- 点击 Timeline：恢复对应时刻的完整地图状态。
- 顶部始终展示当前决策、当前冲突和是否需要人工介入。

### 9.5 必备状态

Loading、Empty、Success、Failed、Paused、No Evidence、API Unavailable 必须在产品内可见，且不依赖口头解释。

## 10. 技术架构

### 10.1 技术栈

- Node.js 22 和 pnpm workspace。
- Web：Next.js App Router、React、TypeScript strict、Tailwind CSS、XYFlow。
- Core Service：Fastify、TypeScript strict、Zod。
- Database：PostgreSQL 16、Drizzle ORM。
- Eventing：REST 命令接口配合 SSE 单向事件流。
- Observability：Pino 结构化日志和 OpenTelemetry 兼容字段。
- Tests：Vitest、Testing Library、Playwright。
- Local Runtime：Docker Compose 启动 PostgreSQL；固定 Fixture 和 Mock Provider 默认启用。

具体依赖版本由首个实现计划锁定，并在 `pnpm-lock.yaml` 中固定。

### 10.2 目录结构

```text
apps/web
  app/
  components/
  features/

services/core
  workflow/
  arena/
  agents/
  execution/
  checkpoints/
  replay/

packages/shared
  schemas/
  types/
  prompts/

lib/llm
lib/db
lib/observability

docs/
  ai-history/
  architecture/
  decisions/
  experiments/
```

### 10.3 Core Service 模块

```text
claim-selector
challenger-assigner
challenge-generator
response-handler
verdict-evaluator
conflict-detector
```

纯规则负责选择、分配、状态迁移和冲突检测。LLM 通过接口适配器负责生成 Challenge、回应 Claim 和语义核验。

### 10.4 LLM 适配

```ts
interface LlmProvider {
  generateStructured<T>(
    input: LlmRequest,
    schema: ZodSchema<T>,
    signal: AbortSignal
  ): Promise<LlmResult<T>>;
}
```

必须提供两个实现：

- `MockLlmProvider`：根据 Fixture 返回确定性结构化结果。
- `OpenAiCompatibleProvider`：通过环境变量连接真实模型。

真实模型返回结果依次经过 JSON 解析、Schema 校验和一次 Repair Prompt。仍失败时记录明确错误并隔离当前任务。

## 11. 数据持久化与聚合

核心表：

```text
Project
DecisionSession
AgentRole
AgentRun
Claim
Evidence
Challenge
Conflict
HumanDecision
PromptVersion
ExecutionEvent
FinalReport
```

Inspector 使用单个聚合 API：

```text
GET /api/sessions/:sessionId/claims/:claimId/inspector
```

返回：

```ts
ClaimInspectorDTO {
  claim: Claim;
  evidence: Evidence[];
  challenges: Array<{
    challenge: Challenge;
    responseClaim?: Claim;
  }>;
  conflicts: Conflict[];
  provenance: {
    agentRun: AgentRun;
    promptVersion: PromptVersion;
  };
  decisionRationale: {
    outcome: "accepted" | "rejected" | "contested" | "needs_human";
    summary: string;
    decisiveChallengeIds: string[];
    evidenceIds: string[];
    humanDecisionId?: string;
  };
}
```

SQL View 可以承担基础 Join 和排序，Repository 负责映射为稳定 DTO。前端不得直接依赖数据库表或 View 结构。

## 12. API 与事件模型

### 12.1 REST 接口

```text
POST /api/projects
POST /api/sessions
POST /api/sessions/:id/start
GET  /api/sessions/:id
GET  /api/sessions/:id/report
POST /api/sessions/:id/human-decisions
GET  /api/sessions/:sessionId/claims/:claimId/inspector
```

写接口必须支持 `Idempotency-Key`。

### 12.2 SSE

```text
GET /api/sessions/:id/events/stream
```

客户端断线后通过 `Last-Event-ID` 补发缺失事件。事件在数据库事务提交后推送。

### 12.3 ExecutionEvent

```ts
ExecutionEvent {
  id: string;
  sessionId: string;
  sequence: number;
  correlationId: string;
  traceId?: string;
  type:
    | "SESSION_STATE_CHANGED"
    | "AGENT_RUN_STARTED"
    | "AGENT_RUN_COMPLETED"
    | "CLAIM_CREATED"
    | "CHALLENGE_CREATED"
    | "CHALLENGE_RESOLVED"
    | "CONFLICT_DETECTED"
    | "HUMAN_REVIEW_REQUIRED"
    | "SESSION_COMPLETED";
  payload: unknown;
  occurredAt: string;
  promptVersionId?: string;
}
```

`correlationId` 表示一次完整业务工作单元，例如一次 AgentRun、一次 Claim 生成或一次人工裁决。它必须在事件、日志、LLM 调用和结果对象之间传播。

前端使用事件 ID 幂等更新状态，不能将 SSE 临时状态作为唯一事实源。

## 13. 错误处理与安全

- API 请求使用 Zod 校验。
- 模型输出使用 JSON Schema/Zod 校验。
- 所有 LLM 调用有超时、取消和一次结构化修复。
- 可重试错误使用指数退避，业务校验失败不盲目重试。
- 每个 AgentRun 独立失败，单点失败不阻塞其他分支。
- 所有写命令幂等，重复请求不能创建重复 Claim、Challenge 或 HumanDecision。
- 项目输入作为不可信数据处理，放入明确的数据边界，不允许它覆盖系统指令。
- API Key 只存在服务端环境变量中，日志不得输出密钥或完整敏感输入。
- 报告导出前检查 Claim 引用、Evidence 引用和 Conflict 状态完整性。

## 14. 可观测性与可复现证据

每个关键对象记录：

- `correlationId`
- `traceId`
- `promptVersionId`
- `agentRunId`
- 输入 Fixture 版本
- 模型名称和参数摘要
- 结构化输出校验结果
- 测试结果
- Git Commit Hash

固定 Demo 的 Fixture、Prompt、输出和人工裁决必须版本化。开启 Mock Mode 时，不依赖外部网络即可重放完整流程。

`docs/ai-history/` 至少保存三个核心案例：

1. AI 设计 Decision Graph 数据结构，并通过约束防止不可维护的嵌套 JSON。
2. AI 定位并修复并行 Agent 状态竞争 Bug。
3. AI 将自然语言质询意图转化为状态机、Schema 和可测试协议。

每条记录包含原始 Prompt、AI 建议、人的纠偏、最终实现、测试结果和 Commit Hash。

## 15. 测试策略

### 15.1 单元测试

- Claim 排序规则。
- 异角色质询者分配。
- Challenge 状态迁移。
- Claim 版本和关系约束。
- Conflict 生成规则。
- 人工裁决对结论的影响。

### 15.2 Schema 与契约测试

- 非法枚举、缺失字段和错误引用。
- Evidence 来源和有效期。
- SSE 事件序列和 `correlationId`。
- `ClaimInspectorDTO` 聚合结果。

### 15.3 集成测试

- 固定输入完整运行。
- 超时、重试、Repair Prompt 和错误隔离。
- SSE 断线补齐事件。
- 刷新后恢复 DecisionSession。
- Idempotency-Key 重复提交。

### 15.4 并发与端到端测试

- 多个 Agent 同时完成时状态不丢失、不覆盖。
- Playwright 覆盖从 Create Session 到 Report 的完整流程。
- 连续 20 次固定输入运行无崩溃。

## 16. 8 分钟演示脚本

| 时间 | 内容 |
|---|---|
| 0:00–0:20 | 展示初始结论、关键冲突和最终结论 |
| 0:20–0:50 | 录入项目材料，展示 Planner 生成 Arena 配置 |
| 0:50–1:40 | 五个 Agent 并行分析，展示独立 Claim 与 Evidence |
| 1:40–2:50 | Cross Examination，展示质询、回应和主持人判定 |
| 2:50–3:40 | Conflict Map，追溯四个高风险假设 |
| 3:40–4:30 | Human Checkpoint，展示三种裁决动作 |
| 4:30–5:20 | Decision Replay 与最终报告 |
| 5:20–6:15 | AI 协同案例 1：Decision Graph 数据结构 |
| 6:15–7:10 | AI 协同案例 2：并行状态竞争 Bug |
| 7:10–8:00 | AI 协同案例 3：Cross Examination 协议 |

AI 协同片段必须同时出现原始 Prompt、AI 建议、人的纠偏、代码 Diff、测试结果和对应 Commit Hash，总时长不得低于 2 分钟。

## 17. 比赛交付与验收

### 17.1 Git 与 AI 历史

- 使用 Public GitHub 或 Gitee 仓库。
- 禁止将所有功能一次性提交。
- 每次核心提交对应一次 AI 对话或一个功能模块。
- 至少保留三条完整 Prompt 链。
- Prompt、Commit、测试和视频时间点必须可以相互映射。

### 17.2 README 与复现

- 提供 10 分钟极速复现指南。
- 列出运行环境、依赖、Docker 服务和命令。
- 提供 `.env.example`。
- 说明 Mock Mode、真实模型模式和固定 Fixture。
- 说明常见故障、数据库初始化、日志和测试命令。

### 17.3 视频与 PDF

- 演示视频为 MP4 1080p，总长 5 至 8 分钟。
- AI 协同过程复现不少于 2 分钟。
- 技术文档为 PDF，不超过 30 页。
- 技术文档必须包含意图控制策略、架构设计、错误处理、复现性论证和指标设计。

### 17.4 最终产品验收

- 新用户无需培训即可完成一次评审。
- 评审过程清晰展示“分析 -> 质询 -> 冲突 -> 裁决 -> 报告”。
- 单 Agent 失败不会导致整个会话无响应。
- 模型结构错误可以自动修复或明确失败。
- 刷新后关键状态可恢复。
- Mock Mode 在无外网、无模型 API 时可完整运行。
- Loading、Empty、Error、Paused、Success、No Evidence、API Unavailable 状态完整。
