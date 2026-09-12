# Operator Guide

## 进入项目数据

固定 Demo 使用 `fixtures/lab-safety-project.json`，打开 `http://127.0.0.1:3000/sessions/demo` 即可。页面顶部显示 `DEMO FIXTURE` 时，数据来自仓库 fixture，未写入数据库。

Live session 通过 `POST /api/sessions` 提交项目对象，必须在请求头提供 `Idempotency-Key`。项目对象包含 `name`、`summary`、`targetUsers`、`businessModel` 和 `expectedData`。开始运行后再调用 `POST /api/sessions/:id/start`，并使用新的幂等键或同一业务请求的稳定键。

## 阅读 Agent 状态

左侧 Agent Panel 显示五个角色。状态含义：

- `待命`：尚未开始。
- `执行中`：当前 AgentRun 正在工作。
- `已完成`：产出已通过 schema 校验。
- `已暂停`：Human Checkpoint 或其他阻塞条件要求人工动作。
- `失败`：该 AgentRun 失败；检查运行记录，不要假定其他角色也失败。

角色名称、目标、perspective、evaluation criteria、required evidence 和 lenses 属于运行配置，不应由 UI 临时改写。

## 检查 Claim 与 Evidence

Decision Map 中的 Claim 节点显示核心断言、重要性和置信度。Inspector 显示：

- Claim 当前状态
- Evidence、Challenge、Conflict 数量
- `decisionRationale.summary`
- decisive challenge 与 linked evidence 数量
- live session 中的 AgentRun、PromptVersion 和 correlationId 来源

`contested` 表示 Claim 仍未解决；`accepted` 不代表所有附带假设都已验证。Evidence 的 `verificationStatus`、`reliability` 和 `direction` 需要一起阅读。

## 处理 Human Checkpoint

当 Conflict 的 severity/impact 达到人工门槛时，session 进入 `HUMAN_REVIEW` 且 `operationalStatus=PAUSED`。可执行三个动作：

- `采纳质询`：接受 Challenge，通常将结论收紧为有限试点或补充条件。
- `维持判断`：保留原 Claim，但仍保留后续监测要求。
- `要求补充分析`：进入 `REASSESSING`，最多补做一轮质询。

固定 Demo 的裁决只修改浏览器内存状态，按钮区域会标记 `PREVIEW / NOT PERSISTED`。Live session 的裁决必须通过 `POST /api/sessions/:id/human-decisions`，服务端在单个事务中写入 HumanDecision、session phase/conclusion 与 `SESSION_STATE_CHANGED`。

## 回放决策

底部 Timeline 以 sequence 定位状态。点击事件后，页面重建该时刻的 Claim、Challenge、Conflict、phase 和 conclusion；不得修改源事件。live 页面断线后使用 `Last-Event-ID` 或 `after` 恢复缺失事件。固定 Demo 使用相同交互和确定性快照，便于无数据库演示。

## 阅读最终报告

最终报告包含：

- 初始结论与质询后结论
- 人工 action
- 最终结论
- Decision Explanation
- required next actions

只有人工确认后才能出现最终高风险决策。报告中的未测量指标必须留空或标记为 `Not measured`。查看截图或导出材料前，确认页面显示 `有限立项`、`决策解释` 和对应 HumanDecision 事件。