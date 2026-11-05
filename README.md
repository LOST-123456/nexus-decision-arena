# Nexus Decision Arena

## 作品简介

Nexus Decision Arena 是一个 AI 决策质询沙盘。五个角色先独立分析，再通过交叉质询暴露冲突，最后由人类完成裁决并生成可回放报告。

本仓库的固定演示项目为“高校实验室 AI 危化品库存与安全预警平台”。`/sessions/demo` 使用标记为 `DEMO FIXTURE` 的离线回放；登录 Owner 或 Reviewer 后创建的新评审使用当前配置的 OpenAI-compatible 模型（本地演示为 `qwen2.5:3b`），持久化五角色分析、Claim、Evidence、Challenge、Conflict、人工裁决与 FinalReport，并通过 SSE 推送到同一套浏览器工作区。

## 10 分钟极速复现

### 1. 环境要求

- Node.js 22
- pnpm 10.6.5（使用 `corepack enable` 后由 `packageManager` 自动选择）
- Docker Desktop
- Git

本仓库在 Windows 本地验证时使用的实际版本会记录到 `docs/ai-history/0014-demo-delivery.md`；提交材料和 CI 的目标版本以上面版本为准。

### 2. 安装依赖

```bash
corepack pnpm install
```

如果本机现有 `pnpm` 不是 10.6.5，统一使用 `corepack pnpm`。仓库锁定版本为 `pnpm@10.6.5`。

### 3. 启动数据库

```bash
docker compose up -d postgres
```

### 4. 配置环境变量

PowerShell:

```powershell
Copy-Item .env.example .env
```

macOS/Linux:

```bash
cp .env.example .env
```

`AUTH_DEFAULT_OWNER_PASSWORD` / `AUTH_DEFAULT_VIEWER_PASSWORD` 留空时，首次启动会用源码里的兜底口令创建 `owner` 与 `viewer` 两个账户。那两个常量（`services/core/src/auth-config.ts` 的 `LOCAL_DEMO_*`）刻意不抄进本文件：它们只负责「一台新机器第一次能进去」，任何跑过一次的机器上都已经不是有效口令了。

在一台已经跑起来的机器上，当前口令在这两个文件里（`.data/` 已被 git 忽略，不进仓库）：

- `.data/owner-password.txt`
- `.data/viewer-password.txt`

首次启动会创建 `.data/users.json`。**账户文件一旦存在，环境变量与兜底值都不再起作用**——之后换口令走下面的「轮换口令」；两个口令文件丢了，也用它重设一次。

#### 本地开发与公开部署是两种模式，不会互相冒充

源码内置的兜底口令只在**本地演示模式**下才会被采用：`NODE_ENV` 不是 `production`、没有设置 `NEXUS_PUBLIC_DEPLOYMENT=true`、也没有设置 `NEXUS_DEMO_MODE=false`。这种情况下启动会在标准错误里打印一条提示，说明正在使用源码内置的签名密钥。

一旦部署被判定为**公开**（上述三个开关任意一个命中），服务会**拒绝启动**，而不是带病上线。公开部署必须提供：

| 变量 | 要求 |
| --- | --- |
| `AUTH_SECRET` | 必填，至少 32 个字符，且不能是源码里公布过的值 |
| `AUTH_DEFAULT_OWNER_PASSWORD` | 必填，至少 12 个字符。首个 `owner` 只能由运维指定的口令创建，绝不会用源码内置口令 |
| `AUTH_DEFAULT_VIEWER_PASSWORD` | 选填；不填则不创建 `viewer` 账户，而不是用一个公布过的口令创建 |
| `WEB_ORIGIN` | 指向 `https://` 开头的 origin 时，会话 Cookie 自动带 `Secure`；也可用 `AUTH_COOKIE_SECURE=true/false` 显式指定 |

多个问题会一次性全部列出，不必改一条重启一次。

另外两条与登录相关的行为，公开部署下默认生效：

- **登录限流**：按「账户」和「来源地址」分别计数，任一方达到失败上限即返回 `429` 并带 `Retry-After`。锁定期间继续尝试**不会**延长锁定时间，锁定结束后重新计数，因此既挡得住爆破，也不会把正常用户永久锁在门外。成功登录会清空该账户的失败记录。
- **登录审计**：每次登录成功、失败、被限流，以及每次新建账户，都会写一行结构化 JSON 到标准输出（含用户名、来源地址、时间、原因；**绝不含口令**），容器日志可直接收集。

`.data/users.json` 是账户的唯一存储。文件**解析失败或权限不可读时服务拒绝启动并原样保留该文件**，不会把账户清空后改用内置账户——这是为了防止一次截断写入或手改失误静默摧毁全部账号。写入采用「临时文件 + 重命名」的原子替换，避免半写文件；同一时刻的并发建号请求会被串行化，不会互相覆盖。

#### 轮换口令（对公网开放前必须做一次）

上面的默认口令是**给刚 clone 下来的本机**用的。一旦这台机器能从公网访问，第一件事就是把它们换掉：

```bash
node scripts/rotate-password.mjs owner
node scripts/rotate-password.mjs viewer
```

脚本会生成 24 位随机口令、就地更新该账户的 salt 与哈希，并把明文写进 `.data/owner-password.txt` / `.data/viewer-password.txt`（`.data/` 已被忽略）。

**改完要重启 core**：账户文件只在启动时读一次，进程里是内存副本；不重启的话旧口令照样能登进去，新口令会被拒。已登录的会话不受影响——Cookie 里是 `{sub, role, exp}` 的 HMAC 签名，不含口令哈希，所以重启前后都不用重新登录。

为什么需要脚本：`AUTH_DEFAULT_OWNER_PASSWORD` 只在账户**首次创建**时读一次，服务跑起来之后改环境变量不会再作用于已有账户。这两个明文文件同时也是 `pnpm --filter @nexus/web test:e2e` 的口令来源（见 `apps/web/e2e/support/credentials.ts`），所以 E2E 永远不会因为换口令而静默失效——找不到口令时会直接报错并说明该设什么。

### 5. 执行迁移

```bash
corepack pnpm --filter @nexus/db db:migrate
```

### 6. 启动服务

```bash
corepack pnpm dev
```

- Web: http://127.0.0.1:3000
- Core API: http://127.0.0.1:4100
- Health: http://127.0.0.1:4100/health

### 7. 运行固定 Demo

打开 http://127.0.0.1:3000/sessions/demo

页面路径：

1. 初始分析显示“建议立项”。
2. 交叉质询后显示“暂缓规模化扩张”和采购管道冲突。
3. 点击“采纳质询”。
4. 页面显示最终结论“有限立项”和“决策解释”。
5. 点击 Timeline 可回到对应回放时刻。
6. 点击“查看决策报告”打开报告页。

Offline fixture runner:

```bash
corepack pnpm demo:fixture
```

该命令读取 `fixtures/`，使用 `MockLlmProvider`，不需要数据库、外网或模型 API。

### 新建自己的评审

先登录 Owner 或 Reviewer，再打开：

```text
http://127.0.0.1:3000/sessions/new
```

登录入口为 `http://127.0.0.1:3000/login`。未登录用户和 Viewer 会被前端与服务端双重阻断，不能创建或启动评审。

填写项目名称、项目简介、目标用户、商业模式和预期数据，点击“开始评审”。前端会依次执行：

1. `POST /api/sessions` 创建项目与 DecisionSession。
2. `POST /api/sessions/:id/start` 启动五角色分析和 Cross Examination。
3. 跳转到 `/sessions/:id`，通过 SSE 查看实时状态、Conflict 和 Human Checkpoint。

Live UUID 会话（真实模型模式）：

1. 使用 `POST /api/sessions` 创建会话。
2. 使用 `POST /api/sessions/:id/start` 启动真实 orchestration 路径。
3. 打开 `/sessions/:id` 查看 SSE 更新、统一 Timeline 和 DecisionReplay。
4. 完成人工裁决后打开 `/sessions/:id/report`，报告来自持久化的 FinalReport。
5. 报告页支持导出 PDF、Markdown 和完整 JSON 审计包。

### 评审历史、账户与安全治理

- 历史记录：`http://127.0.0.1:3000/history`，显示项目名称、阶段、当前结论、冲突数量、最近更新，并可继续评审和查看报告。
- 账户与团队：`http://127.0.0.1:3000/login`。Owner 可新增团队成员；密码使用 scrypt 加盐哈希，浏览器只保存 HMAC 签名的 HttpOnly 会话 Cookie。
- 安全与数据治理：`http://127.0.0.1:3000/security`，说明数据存储、API Key 边界、日志脱敏、会话删除、模型调用边界和人工最终裁决。

角色权限：

| 角色 | 查看历史与报告 | 创建/启动评审 | 人工裁决 | 删除会话 | 管理成员 |
|---|---:|---:|---:|---:|---:|
| Owner | 是 | 是 | 是 | 是 | 是 |
| Reviewer | 是 | 是 | 是 | 否 | 否 |
| Viewer | 是 | 否 | 否 | 否 | 否 |

### 8. 运行测试

```bash
corepack pnpm typecheck
corepack pnpm test
corepack pnpm --filter @nexus/web build
corepack pnpm --filter @nexus/web test:e2e
```

Playwright 覆盖 `1440x900` 与 `390x844`，并检查固定 Demo 至少 3 个反方 Claim、5 个结构化 Challenge、3 个 Conflict，人工采纳、最终“有限立项”、Timeline 回放不丢失最终裁决、live SSE 会话、持久化报告、水平溢出和关键区域几何重叠。截图输出到 `artifacts/playwright/`。

20 次稳定性检查：

```bash
corepack pnpm test:stability
```

该命令执行 20 次 Playwright，默认输出记录到 `docs/experiments/stability-output.txt`。未实际完成 20/20 之前，不得在投稿材料中填写通过率或耗时结论。

## 关于 Git 提交历史

大赛要求细粒度提交历史、「每次提交对应一次 AI 核心对话或一个功能模块」，禁止 initial commit
就包含全部功能。这一节把实际情况、核对方法和偏大部分的成因一起写清，不留给评审去猜。

**形态**（可用 `git log --stat` 逐条核对）：

- 第一条提交 `3b9be9a` 只有 **2 个文件、879 行**，是一份设计冻结文档，不含任何功能实现——
  不存在「一次提交塞进全部功能」。
- 仓库共 **131 个提交**，单个提交改动文件数的**中位数是 8**。
- 有 **12 个提交超过 30 个文件**，最大三个是 98、71、65。

**偏大的都是哪些、为什么**：

- 早期把设计落地成可运行骨架的两步（`ff9793a` 36 个文件、`c3d4dcc` 65 个文件），
  以及治理与角色的一次性接入（`6eb0d25` 44 个文件）、研究工作台的第一个纵向切片
  （`b21bbb8` 71 个文件）；
- 按 Prompt 编号推进的功能提交多在 30–50 之间，**这类提交的标题本身标明了它对应哪一次
  AI 对话**：`613c3f4` 38 个文件（提示词 1）、`d35b149` 35 个文件（提示词 2）、
  `0dd2df4` 31 个文件（提示词 11）、`3652b19` 46 个文件（提示词 12）等；
- 界面层这一批（`d355ce6` 98 个文件）——原因见下一段。

**P23–P28 那批为什么按三层落地、界面层为什么拆不动**：这批功能在本地连续完成、期间未推送
到远程，补齐时按数据层 / 接口层 / 界面层分别提交。数据层与接口层已经按功能拆细了：
原来 39 个文件的数据层拆成 9 个提交（消息中心、治理口径、游标分页、问题编辑、补充轮数、
来源库可见范围、协作、报告与快照），前面另有一个铺垫共享类型的提交；59 个文件的接口层拆成
3 个（访问控制、其余端点与运行器、集成测试）。

界面层拆不动，原因具体：会话列表的取数形状从「数组」改成「带游标的窗口」之后，工作台、
快速切换、报告页与首页会同时跟着变；而报告页引用的导出按钮组件又要求把整份报告传进去。
任何按页面切开的中间态都编译不过。试过两轮按组件层 / 页面层分，都撞在同一处，所以保留
为一段整体提交，而不是留一串编译不过的历史。

**没有回头改写更早的提交**：`b21bbb8` 之前那些提交之上的历史都已通过类型检查、单元测试与
端到端验收，重写只会打散已验证的历史，收益不抵代价，所以如实标注而不是改写。

逐功能的真实记录在 `docs/ai-history/`，分四类：

- `0001`–`0015`：分阶段对话快照，18 份（`0015` 有两份），写的是目标、Prompt、AI 建议与纠偏；
- `0016`：Codex 会话的**原始导出**，带 session id、SHA-256 与 142 条逐字消息（2026-09-10 ~ 09-13）；
- `0018`–`0028`：WorkBuddy 会话的**原始导出**，覆盖 2026-10-08 ~ 11-04，3400 余条消息，
  逐条带时间戳。按周切分、过大的一周再按天切，每份都在 1 MB 以内，网页端可以直接渲染。
  导出脚本剥离了每轮自动注入的工作区上下文、记忆块、任务通知与压缩摘要，其余逐字保留。
  `0028` 有两处各一段（合计 347 字，占全文 0.4%）因托管平台文本审核要求未公开展示，
  文件内以「［编者注］」标出略去的行数与字数，原文仍在本仓库 Git 历史与原始 JSONL 中；
- `0017`：5 条核心 Prompt 链，每条五段（用户 Prompt / AI 建议 / 人工纠偏 / Bug 修复 / 验证结果）。
  第 5 条记录的是这次把三个「整层打包」提交拆细的过程——包括第一版「按层拆」为什么是错的。

根目录的分阶段交付报告可按功能追溯。

## Mock Mode

`LLM_MODE=mock` 用于固定 Demo 和自动化回归测试。`/sessions/new` 在任何新项目启动前会检查运行模式；Mock Mode 下禁止把固定 fixture 结果冒充为新项目分析结果。固定 Demo 页面始终标记为 `DEMO FIXTURE`。

## 真实模型模式

将 `LLM_MODE` 改为 `openai-compatible`，并填写：

```dotenv
LLM_MODE=openai-compatible
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=your-api-key
LLM_MODEL=your-model
```

Live UUID 会话会在 `LLM_MODE=openai-compatible` 时使用环境变量配置的模型 Provider。固定浏览器 Demo 不因切换环境变量而自动改为实时运行；不要用真实模型模式描述 fixture 截图或 Mock Mode 证据。

## 本地真实模型（Ollama）

本项目可以直接连接本机 Ollama 的 OpenAI-compatible 接口。模型建议存放在 E 盘：

```powershell
$env:OLLAMA_MODELS = "E:\AI创新应用挑战赛\.models\ollama"
ollama pull qwen2.5:3b
```

`.env` 配置示例：

```dotenv
LLM_MODE=openai-compatible
LLM_BASE_URL=http://127.0.0.1:11434/v1
LLM_API_KEY=ollama
LLM_MODEL=qwen2.5:3b
LLM_TIMEOUT_MS=300000
LLM_MAX_TOKENS=1200
CROSS_EXAMINATION_MAX_CLAIMS=2
CROSS_EXAMINATION_MAX_CHALLENGERS=1
```

可用下面的命令验证真实模型是否能够返回结构化 Claim：

```powershell
corepack pnpm smoke:provider
```

## 常见问题

### PostgreSQL 端口被占用

停止本机占用 5432 端口的服务，或同时修改 `docker-compose.yml` 和 `DATABASE_URL` 中的端口。

### Playwright 浏览器缺失

```bash
corepack pnpm --filter @nexus/web exec playwright install chromium
```

### 页面没有事件更新

确认 `http://127.0.0.1:4100/health` 返回 `{"status":"ok"}`，并检查浏览器 Network 中的 SSE 连接。固定 Demo 不依赖 SSE；live UUID session 才使用事件流。

### pnpm 版本不一致

```bash
corepack pnpm --version
```

应输出 `10.6.5`。如果输出其他版本，改用 `corepack pnpm`，不要用全局 `pnpm` 更新 lockfile。

## AI 协同证据索引

- `docs/ai-history/0001-design-freeze.md`
- `docs/ai-history/0003-workspace-bootstrap.md`
- `docs/ai-history/0005-state-machine.md`
- `docs/ai-history/0013-human-checkpoint.md`
- `docs/ai-history/0014-demo-delivery.md`
- `docs/ai-history/0015-final-fix-wave.md`
- `docs/ai-history/0016-codex-conversation-export.md`
- `docs/ai-history/0017-core-prompt-chains.md`
- `docs/ai-history/exports/codex-session-curated.jsonl`
- `scripts/export-codex-history.ps1`

## 架构与协议文档

- `docs/superpowers/specs/2026-09-10-decision-arena-design.md`
- `docs/architecture/system-overview.md`
- `docs/user-guide/operator-guide.md`
- `docs/experiments/evaluation-plan.md`
- `docs/experiments/submission-checklist.md`
- `docs/submission/technical-document.html`
- `docs/submission/video-production-kit.md`

## 技术文档 PDF

技术文档 PDF 位于：

```text
artifacts/submission/Nexus-Decision-Arena-Technical-Document.pdf
```

当前为 29 页 A4（门槛是不超过 30 页），正文覆盖意图控制策略、架构设计、错误处理、可复现性论证、
实际测试结果、三条核心 AI 协作链和投稿索引。

在 Windows 上安装 Chrome 或 Edge 后，可由 HTML 源文件重复渲染：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/render-technical-pdf.ps1
```

HTML 源文件为 `docs/submission/technical-document.html`。重新渲染前应确认页面没有溢出，并保持正文
不超过 30 页。

## 演示视频

自动生成的证据成片位于：

```text
artifacts/submission/Nexus-Decision-Arena-Demo.mp4
```

- 时长：7 分 54 秒
- 分辨率：1920×1080
- 编码：H.264 / MP4
- 字幕：视频底部烧录中文字幕
- 独立字幕：`artifacts/submission/Nexus-Decision-Arena-Demo.zh-CN.srt`
- 封面：`artifacts/submission/Nexus-Decision-Arena-Demo-poster.png`

视频由 `scripts/render-submission-video.mjs` 从产品截图、真实对话导出、测试输出和 Commit 证据生成。
如果赛事明确要求“参赛者实时输入 Prompt”的原始屏幕录制，只需替换 5:20–8:00 的 AI 协同片段，其余结构
无需重做。

## 8 分钟视频时间图

| 时间 | 画面与证据 |
|---|---|
| 0:00-0:20 | 固定 Demo 初始结论、冲突和最终结论概览 |
| 0:20-0:50 | 展示固定项目输入和五角色配置 |
| 0:50-1:40 | 展示独立 Claim、Evidence 和 Agent 状态 |
| 1:40-2:50 | 展示 Challenge、回应和主持人裁定 |
| 2:50-3:40 | 展示 Conflict Map 与四项关键假设 |
| 3:40-4:30 | 展示 Human Checkpoint 三种动作 |
| 4:30-5:20 | 展示 Decision Replay、决策解释和最终报告 |
| 5:20-6:15 | AI 协同案例 1：Decision Graph 数据结构 |
| 6:15-7:10 | AI 协同案例 2：并行状态竞态修复 |
| 7:10-8:00 | AI 协同案例 3：Cross Examination 协议与测试证据 |

AI 协同片段必须同时出现原始 Prompt、AI 建议、人的纠偏、代码 Diff、测试输出和 Commit Hash。
完整录屏顺序、素材位置和导出参数见 `docs/submission/video-production-kit.md`。

## PDF 章节图

| 顺序 | 章节 | 目标 |
|---|---|---|
| 1 | 问题与作品定义 | 说明待评估决策和产品边界 |
| 2 | 五角色决策模型 | 说明角色、lens、Claim 与 Evidence |
| 3 | Cross Examination 协议 | 说明质询、回应、裁定和 Conflict |
| 4 | 系统架构与状态机 | 说明组件、事件、数据库和人工检查点 |
| 5 | 可回放与降级设计 | 说明 Mock Mode、SSE 恢复和失败隔离 |
| 6 | 实验与结论 | 只引用已记录 CSV 或稳定性输出 |
| 7 | AI 协同开发证据 | 引用 Prompt、Diff、测试和 Commit 映射 |
| 8 | 复现与投稿附件 | 引用 README、截图、视频和提交清单 |

PDF 正文目标不超过 30 页。未测量指标不得写入正文。
