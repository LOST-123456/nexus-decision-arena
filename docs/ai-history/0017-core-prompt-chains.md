# 五条核心 AI Prompt 链

> 日期：2026-09-13（链路 1–4）、2026-11-04（链路 5）  
> AI 工具：Codex Desktop（链路 1–4）、WorkBuddy（链路 5）  
> 主线程导出：`docs/ai-history/0016-codex-conversation-export.md`、
> `docs/ai-history/0028-workbuddy-2026-W45.md`  
> 结构化导出：`docs/ai-history/exports/codex-session-curated.jsonl`

本文只保留与核心功能迭代有关的内容，过滤了问候、状态确认、工具输出和重复进度消息。五条链路均包含用户 Prompt、AI 建议、人工纠偏、Bug 修复、验证结果和 Commit。

链路 1–4 的原始对话见 `0016`；链路 5 的原始对话见 `0018`–`0028`（WorkBuddy 会话导出，逐条带时间戳，按周/按天分文件）。

---

## 链路 1：Decision Graph 数据结构与 UUIDv7 约束

### 1. 用户 Prompt

用户要求补充 Claim、Evidence、Challenge、Conflict 四个核心对象，并提出：

```text
Claim ID 使用 UUID，避免冲突。
Claim 增加版本号和时间戳，保留变更历史。
Claim 增加 relatedClaimIds，表达逻辑关系。
Evidence 增加 description 和 validityPeriod。
Challenge 增加 context 和 resolutionStrategy。
Conflict 增加 resolutionSuggestion 和 impactScope。
```

### 2. AI 初始建议

AI 提出：

- 所有核心对象统一使用 UUIDv7。
- Claim 不原地修改，每次实质变化创建新版本。
- 使用 `rootClaimId`、`revisionOfClaimId` 和 `revision` 表达版本链。
- 将无类型的 `relatedClaimIds` 改为带类型的关系数组，支持 `supports`、`contradicts`、`qualifies` 和 `depends_on`。
- Evidence 使用结构化 `validityPeriod`，Challenge 使用可执行的 `resolutionStrategy`。
- Conflict 的 `resolutionSuggestion` 只提供建议，高严重度冲突必须进入人类裁决。

### 3. 人工纠偏

用户接受上述设计，并额外要求：

- `ExecutionEvent` 增加 `correlationId`。
- `ClaimInspectorDTO` 增加可追溯的决策解释。
- 报告增加 Decision Explanation。
- 多语言只预留 `locale`，首版只实现中文。

AI 将这些要求并入数据契约，没有重新扩展产品范围。

### 4. 发现并修复 Bug

代码审查发现，最初的 `IdSchema` 只使用通用 UUID 校验：

```ts
z.string().uuid()
```

它允许 UUID v1/v4 通过，无法落实“所有持久化 ID 必须是 UUIDv7”的全局约束。

AI 将校验改为严格的 UUIDv7 结构校验，要求：

- 版本位必须为 `7`。
- RFC 变体位必须为 `8`、`9`、`a` 或 `b`。
- 增加 `newId()` 通过、v4 拒绝、非法 UUID 拒绝的回归测试。

### 5. 验证结果

```text
共享包测试：9/9 通过
TypeScript 类型检查：通过
最终 Commit：901ce8c
```

最终设计规格：

```text
docs/superpowers/specs/2026-09-10-decision-arena-design.md
```

---

## 链路 2：并行 Agent 状态竞争与 Claim 不可变性

### 1. 用户 Prompt

用户要求实现 Task 6：

```text
实现多 Agent 分析和交叉质询。
使用 Promise.allSettled 隔离单个 Agent 失败。
每个 Challenge 必须有独立 try/catch，不能中断其他 Challenge。
原 Claim 不可被原地修改，回应必须形成新版本。
```

### 2. AI 初始建议

AI 设计：

- 五个 Agent 并行执行。
- 每个 AgentRun 使用独立的 `correlationId`。
- 单 Agent 失败发出 `AGENT_RUN_FAILED`，其他 Agent 继续。
- Cross Examination 每个 Challenge 独立执行，失败发出 `CHALLENGE_FAILED`。
- 回应 Claim 必须引用原 Claim，并满足：

```text
revisionOfClaimId = 原 Claim ID
revision > 原 Claim revision
respondsToChallengeId = 当前 Challenge ID
sessionId = 原 Claim sessionId
```

### 3. 真实 Bug 与人工纠偏

测试发现两个真实问题：

1. Challenge 依赖收到的是原 Claim 引用，依赖可以原地修改原 Claim。
2. 回应 Claim 可以复用原 Claim revision，系统仍会接受。

人工纠偏后，AI 按下面原则修复：

- 所有交给依赖的原 Claim 使用 `structuredClone`。
- 回应 Claim 必须通过独立校验函数验证版本链、Challenge 关联和 session 归属。
- 校验失败只影响当前 Challenge，不中断其他 Challenge。

随后独立复审又发现 `CHALLENGE_CREATED` 发出了后续仍会变化的同一对象。修复为发射不可变快照：

```ts
structuredClone(challenge)
```

最终并发复审还发现，`request_more_analysis` 的补充轮如果没有单飞锁，并发调用可能重复执行。最终增加：

- PostgreSQL session 级 advisory lock。
- 内存测试环境的等价串行锁。
- 并发双调用只允许补充轮执行一次。

### 4. 回归测试

新增并保持绿灯的测试包括：

```text
原 Claim 不可变
无效 revision 被拒绝
Challenge 失败不阻断其他 Challenge
CHALLENGE_CREATED 事件在后续状态变化后保持 open 快照
并发补充轮只执行一次
补充轮不重复运行 Agent 分析
```

### 5. 验证结果

```text
Core 测试：通过
TypeScript 类型检查：通过
相关 Commit：
c7b0c8b
e47c016
cfad589
```

---

## 链路 3：SSE 事件丢失、乱序与幂等租约

### 1. 用户 Prompt

用户要求 Task 9：

```text
使用 SSE 将 ExecutionEvent 推送给前端。
支持 Last-Event-ID 重连和事件回放。
后端事务提交后才能发布事件。
客户端必须能恢复关键状态。
持久化幂等请求不能重复执行。
```

### 2. AI 初始建议

AI 提出：

- REST 负责写命令，SSE 负责单向事件流。
- `ExecutionEvent.sequence` 按 session 单调递增。
- `EventBus` 只在数据库 append 成功后发布。
- 客户端使用事件 ID 幂等更新状态。
- 数据库使用 `nextEventSequence` 原子分配序号。

### 3. 人工纠偏与真实 Bug

独立审查连续发现四个问题：

1. 重放结束到开始订阅之间存在丢失事件窗口。
2. 重放和实时事件合并时，低序号事件可能在 gap 填上之前被错误丢弃。
3. 慢速重放期间客户端断开，订阅和 heartbeat 可能未清理。
4. 幂等处理中的进程崩溃可能留下永久 `processing` 记录。

AI 的修复路线：

- 先订阅并缓存实时事件，再读取并写入 replay。
- 使用 `expectedSequence` 和 pending map 保证只按连续序号推进状态。
- gap 未补齐时保留后续事件，不丢弃。
- 对 gap recovery 增加 25ms 到 1000ms 的指数退避，防止高频 DB 轮询。
- 在 replay 之前注册 close/error 清理。
- 幂等记录增加 lease token 和过期回收。
- 旧 lease 不得覆盖或删除新 lease。
- 增加并发单飞测试、退避测试和过期 lease fencing 测试。

### 4. 回归测试

```text
SSE 重放期间发布的事件不丢失
2/3 先到、1 后到时保持缓存并最终输出 1/2/3
慢速重放断开后订阅和 heartbeat 被释放
gap recovery 有上限退避且无重入
同 key 并发请求只执行一次
过期 lease 可以被安全回收
旧 lease 无法覆盖新 lease
```

### 5. 验证结果

```text
Core 测试：通过
DB 测试：通过
TypeScript 类型检查：通过
Playwright：4/4 通过
稳定性：桌面 20/20、移动 20/20
相关 Commit：
ac90dbe
39f8ce7
c77551a
79f7e25
```

---

## 链路 4：真实模型、人工理由与报告导出

### 1. 用户 Prompt

用户要求继续增加可提交能力，最初列出六项，随后明确删减：公网在线演示、历史记录和单/五 Agent 对照实验不保留，最终只实现三项：

```text
真实模型模式。
人工裁决理由与影响范围。
报告 PDF / Markdown / JSON 导出。
```

### 2. AI 建议

- 新项目页面先读取运行模式；Mock Mode 只允许固定 Demo。
- 使用本机 Ollama 的 OpenAI-compatible 接口，模型存放在 E 盘 `.models/ollama`。
- Human Checkpoint 增加理由文本框和受影响 Agent 多选。
- 报告页提供 PDF 打印、Markdown 和完整 JSON 审计包。
- 真实模型的跨质询允许规则回退，避免小模型漏字段导致流程中断。

### 3. 人工纠偏

用户先要求六项，再明确删掉公网在线演示、历史记录和对照实验，要求清理无用代码。最终提交只保留真实模型、人工裁决理由和报告导出。

### 4. 真实 Bug 与修复

1. 任意项目在 Mock Mode 下仍会读取固定实验室 fixture，容易造成真实性误导。现在新项目页面在 Mock Mode 禁止启动，并明确显示模式。
2. 小模型会把枚举示例中的 `fact|assumption|prediction|recommendation` 原样返回，Schema 校验失败。现在 prompt 改为单一合法示例并明确禁止 pipe-delimited 值。
3. Challenge 使用了不存在的 `challengerRunId`，触发外键失败。现在真实模型模式复用有效 AgentRun 生成 CrossExaminationPlan。
4. 模型没有返回完整 Challenge 字段时流程会中断。现在保留模型生成，同时增加确定性回退。
5. 所有 Agent 失败时系统曾进入 DECIDED。现在改为 `ANALYZING + FAILED`，不再生成虚假完成结论。

### 5. 验证结果

```text
TypeScript 全项目：通过
测试：157/157 通过
Next.js 15.5.25 构建：通过
真实模型：qwen2.5:1.5b
真实模型端到端：7 Claims / 2 Challenges / 2 Conflicts
人工理由：写入 HumanDecision
报告导出：PDF / Markdown / JSON 可用
提交：e9822d2
```


## 链路 5：把三个「整层打包」的提交拆细——策略反转与拆分撞墙

> 原始对话：`0028-workbuddy-2026-W45.md`，2026-11-04 10:29–11:37（编号 3364–3390）

### 1. 用户 Prompt

用户第三次贴出大赛 2.1 原文，只问一句：

```text
2.1代码仓库与演进记录 托管平台:GitHub/ Gitee (须设为Public或提供评审访问权限)。
Git提交日志(关键):必须保留完整的、细粒度的Git提交历史。禁止一次性提交
(”initialcommit"即包含全部功能)。每次提交应对应一次与AI的核心对话或一个功能
模块的落地。……你直接告诉我，你什么没完成
```

AI 列出缺口后，用户只回了三个字，依次是：

```text
改啊
干
干
```

**这里没有给出任何技术方案。** 用户给的是授权，方向是被编译器和测试逼出来的。

### 2. AI 初始建议（以及它错在哪）

AI 的第一版计划是「按层拆」：先拆数据层 39 个文件，再拆接口层 59 个，最后界面层 103 个。理由是三层各自内聚。

这个判断是错的，两个反例立刻出现：

```text
src/research/report-snapshot-service.ts(175,5): error TS2740:
  Type 'CursorPage<{...}>' is missing the following properties from type '{...}[]':
  length, pop, push, concat, and 29 more.

src/api/routes/sessions.test.ts: expected 403 to be 404
```

第一处：数据库层把 `listSnapshots` 的返回改成游标分页后，接口层两个服务仍按数组用，**任何中间提交都编译不过**。
第二处：给 `/api/sessions/` 装一个全局 `preHandler` 之后，所有会话作用域路由的旧测试期望 403、新规则返回 404，**一整批测试同时变红**。

### 3. 人工纠偏

用户没有参与方案调整，也没有必要——纠偏来自验证反馈。AI 在原始对话里写下结论：

```text
这说明「按层拆」本身是错的：db 改了类型，core 必须同一提交跟上，否则任何中间
提交都编译不过。真正能过的是按功能纵向拆——一个功能把 db、core、web 三层一起提交。
```

后续又修正了一次：真正卡人的不是「层」，而是**跨文件的类型契约半径**。

### 4. 发现并修复的 Bug

拆分过程本身暴露了五个问题，都不是产品代码的缺陷，但每一个都会让拆分「看起来成功、实际不可用」：

1. **hunk 级切分不可靠**：`app.ts` 的一个 import 块同时带进了 5 个新路由，按 hunk 挑会把后续功能的依赖一起提交。改为**手工增量编辑**——每一刀只加该功能需要的 import、依赖字段和注册调用。
2. **补丁格式错误**：`patch fragment without header`——拼 hunk 时在片段之间插了空行。去掉分隔行后应用成功。
3. **放错目录**：`e2e-manual/` 的手动脚本被放进 `e2e/` 下，导致仓库里多出一份、正确位置少一份。单独一个提交修正。
4. **`tsc` 被旧构建产物污染**：`apps/web/.next/types` 里残留着引用未生成页面的类型，报一堆 `Cannot find module '../../app/healthz/route.js'`。移走 `.next` 后才能看到真实错误。
5. **`next dev` 覆盖生产构建**：端到端套件起的是 dev server，跑完后 `.next` 里没有 `BUILD_ID`，`next start` 直接拒绝启动。必须重新 `next build`（首次 EPERM 是已知现象，重试一次即过）。

### 5. 验证结果

```text
代码树：与拆分前的 d4defec 逐字节一致（git diff --stat 为 0 行）
类型检查：shared / db / llm / core / web 五包 tsc --noEmit 全部通过
单元测试：core 56 文件、web 62 文件、shared 256 例、db 52 例、llm 7 例，全绿
提交规模：截至 2026-11-05 共 134 个提交，单次改动文件数中位数 8，超过 30 个文件的 12 个
对比拆分前：数据层 39 文件 → 9 个提交；接口层 59 文件 → 3 个提交
```

界面层的 103 个文件最终收成 98 个，**没有再往下切**，原因是实测的：会话列表的取数形状一改，工作台、快速切换、报告页与首页同时跟着变；报告页引用的导出按钮又要求传整份报告。任何按页面的切法都留下编译不过的中间态。这一条在 README 里也写了。

### 6. Commit

```text
9686d1e  fix(core): type the thrown-error helper so tsc accepts it
ef32b6a  feat(shared): research materials, evidence coverage and the state machine
a06ba41  feat(db): keep only read markers for the notification centre
cf72e50  feat(db): count what people decided, never score it
ee34d49  feat(db): page the session list by cursor, and restrict it to what the caller may read
68b7e78  feat(db): let a research question be corrected without touching the conclusion
c5b63cb  feat(db): allow three supplement rounds, configurable, instead of exactly one
eb3aeec  feat(db): resolve a library session's visibility once, and label it by project
c11acba  feat(db): find the researches a member was invited to, and page the comments
f0811aa  test(db): cover the round cap, the unknown role key and the question edit
81c6f85  feat(db): assemble the report a person would read, and freeze the snapshot it came from
3558b39  feat(core): one guard decides who may read which research
3df23c6  feat(core): wire the remaining research endpoints, and the runners they call
ac19b64  test(core): exercise the new surfaces against a real database
d25dba4  feat(web): read the new event kinds, and keep the stream un-compressed
d355ce6  feat(web): the research workspace, the notification centre and the model settings page
4b36231  test(e2e): start the site from the suite instead of assuming it is up
37f5a76  feat(ops): 双击就能开、就能关，开机也不用再记命令
1ee9aa0  docs: 提交历史说明改准，并把成片基线与文档口径分开写
4af99f4  chore: 忽略本机公网地址快捷方式
```


## 证据映射

| 核心链路 | 对话导出 | 详细快照 | 验证 | Commit |
|---|---|---|---|---|
| Decision Graph 数据结构 | `0016-codex-conversation-export.md` | `0004-decision-schema.md` | `901ce8c` 前复审 | `901ce8c` |
| 并行 Agent 状态竞争 | `0016-codex-conversation-export.md` | `0008-cross-examination.md` | Core 回归测试 | `c7b0c8b`、`e47c016`、`cfad589` |
| SSE 事件丢失与幂等 | `0016-codex-conversation-export.md` | `0011-sse-events.md` | Core、DB、Playwright | `ac90dbe`、`39f8ce7`、`c77551a`、`79f7e25` |
| 真实模型、人工理由与导出 | `0016-codex-conversation-export.md` | 本文链路 4 | 157 tests、真实模型 E2E、Next build | `e9822d2` |
| 提交历史拆分与策略反转 | `0028-workbuddy-2026-W45.md`（2026-11-04 10:29–11:37） | 本文链路 5 | 五包 typecheck、单测全绿、代码树 diff 0 行 | `9686d1e`…`4af99f4` |

所有 Commit 均可在公开仓库中查询，两个平台是同一份历史：

```text
https://gitee.com/lost666666/nexus-decision-arena
https://github.com/LOST-123456/nexus-decision-arena
```

两个仓库的 `main` 指向同一个提交，可以任选一个核对。
需要核对最新提交历史时，两边都可以。本机到 `github.com` 的链路时通时不通，推送曾因此中断过
几次，所以如果某一次只在一个仓库里看到新提交，那是推送还没跟上的原因，不是历史不一致。
