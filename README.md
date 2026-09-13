# Nexus Decision Arena

## 作品简介

Nexus Decision Arena 是一个 AI 决策质询沙盘。五个角色先独立分析，再通过交叉质询暴露冲突，最后由人类完成裁决并生成可回放报告。

本仓库的固定演示项目为“高校实验室 AI 危化品库存与安全预警平台”。`/sessions/demo` 继续使用标记为 `DEMO FIXTURE` 的离线回放；通过 REST API 创建的 UUID 会话则运行完整 Mock Mode orchestration，持久化五角色分析、Claim、Evidence、Challenge、Conflict、人工裁决与 FinalReport，并通过 SSE 推送到同一套浏览器工作区。

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

Live Mock Mode：

1. 使用 `POST /api/sessions` 创建会话。
2. 使用 `POST /api/sessions/:id/start` 启动真实 orchestration 路径。
3. 打开 `/sessions/:id` 查看 SSE 更新、统一 Timeline 和 DecisionReplay。
4. 完成人工裁决后打开 `/sessions/:id/report`，报告来自持久化的 FinalReport。

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

## Mock Mode

`LLM_MODE=mock` 是默认模式。Live UUID 会话使用确定性的 fixture/provider 路径完成五角色分析、Cross Examination、Conflict Detection、Human Review 和最终报告持久化，不发送外部网络请求。固定 Demo 页面仍单独标记为 `DEMO FIXTURE`，避免把离线回放误认为真实模型运行结果。

## 真实模型模式

将 `LLM_MODE` 改为 `openai-compatible`，并填写：

```dotenv
LLM_MODE=openai-compatible
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=your-api-key
LLM_MODEL=your-model
```

Live UUID 会话会在 `LLM_MODE=openai-compatible` 时使用环境变量配置的模型 Provider。固定浏览器 Demo 不因切换环境变量而自动改为实时运行；不要用真实模型模式描述 fixture 截图或 Mock Mode 证据。

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

当前为 28 页 A4，正文覆盖意图控制策略、架构设计、错误处理、可复现性论证、实际测试结果、三条核心
AI 协作链和投稿索引。

在 Windows 上安装 Chrome 或 Edge 后，可由 HTML 源文件重复渲染：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/render-technical-pdf.ps1
```

HTML 源文件为 `docs/submission/technical-document.html`。重新渲染前应确认页面没有溢出，并保持正文
不超过 30 页。

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
