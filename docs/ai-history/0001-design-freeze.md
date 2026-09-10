# AI 对话快照 0001：产品与架构设计冻结

> 日期：2026-09-10  
> AI 工具：Codex  
> 关联规格：`docs/superpowers/specs/2026-09-10-decision-arena-design.md`

## 1. 本阶段目标

以《全国高校 Vibe Coding 开发挑战赛参赛总计划 V3.0》为产品计划，并结合大赛对 Git 历史、Prompt 链、复现指南、演示视频和技术 PDF 的提交要求，完成正式编码前的五项设计冻结。

本快照保存原始用户 Prompt 的核心内容、AI 建议、人工纠偏和最终决策。后续实现 Commit 将继续引用本文件及后续 AI 对话快照。

## 2. Prompt 链

### Prompt 1：指定总计划与提交要求

用户提供了《01_竞赛总计划_V3_评委程序员重审版.md》，并要求严格按该文件执行。用户同时明确大赛要求：

- 使用 Public GitHub 或 Gitee 仓库。
- 保留完整、细粒度的 Git 提交历史，禁止一次性提交全部功能。
- 每次提交对应一次 AI 核心对话或一个功能模块。
- 至少提供 3 个核心功能迭代的完整 Prompt 链。
- 如果不能导出 AI 对话，则使用截图或录屏。
- README 必须包含 10 分钟复现指南、依赖和环境变量模板。
- 演示视频为 MP4 1080p，总长 5 至 8 分钟。
- 视频必须包含至少 2 分钟的 AI 协同过程复现。
- 技术文档为 PDF，不超过 30 页，须解释意图控制、架构约束和可复现性。

### AI 建议

将任务归类为架构型新项目。在编码前完成总计划第 25 节要求的五项设计冻结，并把提交合规要求纳入开发流程。

### 人工决策

确认以当前 Codex 对话作为官方 AI 协同主线。每个核心迭代保存原始 Prompt、AI 建议、人工纠偏、代码 Diff、测试结果和 Commit Hash。

### Prompt 2：确认 Agent 角色

用户建议细化市场、技术、财务、风险和质询主持人角色，并增加数据分析师、开发工程师、运营分析师、合规审查员、伦理审查员和逻辑分析师。

### AI 建议

不扩成十个一级 Agent，避免职责重叠和 Decision Map 复杂化。保留五个一级 Agent，并将其余职责定义为每个角色内部的 Lens。

### 人工纠偏

用户确认采用“5 个一级 Agent + 内部多视角”的方案。

### Prompt 3：定义核心对象

用户要求补充 Claim、Evidence、Challenge 和 Conflict 对象，建议加入 UUID、版本、关联关系、证据有效期、质询上下文、解决策略、冲突建议和影响范围。

### AI 建议

- 所有对象使用 UUIDv7。
- Claim 实质变化生成新版本，使用 `rootClaimId`、`revisionOfClaimId` 和 `revision`。
- `relatedClaimIds` 改为带关系类型的 `relations`。
- Evidence 增加 `description`、`validityPeriod` 和 `retrievedAt`。
- Challenge 增加结构化 `context` 和可执行的 `resolutionStrategy`。
- Conflict 增加 `resolutionSuggestion` 和结构化 `impactScope`。
- Conflict 不得自动关闭，高严重度冲突必须进入人工裁决。

### 人工决策

确认上述对象契约。

### Prompt 4：冻结 Cross Examination

用户要求在实现阶段进行模块化设计、自动化测试、Decision Map 可视化和用户文档建设。

### AI 建议

将协议拆成六个模块：

```text
claim-selector
challenger-assigner
challenge-generator
response-handler
verdict-evaluator
conflict-detector
```

单元测试、Schema 测试、集成测试、并发测试和端到端测试均纳入验收。Decision Map 由 XYFlow 实现，协议图和架构图使用可版本化的 Mermaid 文档。

### 人工决策

确认协议和测试约束。

### Prompt 5：冻结实时同步与 Inspector

用户建议 Decision Map 使用 WebSocket，并让 Inspector 通过聚合 API 或 SQL View 一次返回 Claim、Evidence、Challenge 和 Conflict。

### AI 建议

采用 SSE 而非 WebSocket。REST 写命令配合 ExecutionEvent SSE，服务端在数据库事务提交后推送事件，客户端使用 `Last-Event-ID` 补发和幂等恢复。

Inspector 使用单个聚合 API，SQL View 只作为查询实现，不直接暴露给前端。

### 人工纠偏

用户进一步建议增加 `correlationId`、`decisionRationale`、报告决策解释和多语言预留。最终接受 `correlationId`、结构化决策解释和 `locale` 预留；首版只实现 `zh-CN`。

### Prompt 6：冻结 Decision Map 与 Demo

用户确认 Decision Map，并补充 SSE 和聚合查询建议。随后确认使用“高校实验室 AI 危化品库存与安全预警平台”作为固定 Demo 输入，以及 8 分钟视频脚本。

### AI 建议

- 初始结论为建议立项。
- 通过扩张速度、技术周期、毛利率和采购周期四类质询产生冲突。
- 人工采纳关键质询后改为有限立项。
- 最终结论为三间实验室、十二个月、阶段验收后再讨论扩张。
- 产品流程控制在前 5 分 20 秒。
- 后 2 分 40 秒展示三个 AI 协同案例。

### 人工决策

确认最终 Demo 输入、结论文本和视频时间分配。

## 3. 本阶段最终产出

1. 五个一级 Agent 与内部 Lens。
2. Claim、Evidence、Challenge、Conflict 数据契约。
3. Cross Examination 协议。
4. Decision Map 和交互规则。
5. 固定 Demo 输入与 8 分钟脚本。
6. SSE、聚合 Inspector、关联 ID 和决策解释设计。
7. 工程质量、测试、复现和比赛交付门槛。

## 4. 对应 Git 提交

本文件与设计规格在同一提交中保存。

提交标题：

```text
docs: freeze Nexus Decision Arena design and AI review trail
```
