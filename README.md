# Nexus Decision Arena

## 作品简介

Nexus Decision Arena 是一个 AI 决策质询沙盘。五个角色先独立分析，再通过交叉质询暴露冲突，最后由人类完成裁决并生成可回放报告。

本仓库的固定演示项目为“高校实验室 AI 危化品库存与安全预警平台”。为控制离线环境的不确定性，页面在 `DEMO FIXTURE` 模式下读取固定输入、固定角色分析、固定质询和预期有限立项报告；页面不调用真实模型。完整 live orchestration 尚未接入浏览器演示路径，因此不能将 fixture 回放描述为真实模型运行结果。

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

### 8. 运行测试

```bash
corepack pnpm typecheck
corepack pnpm test
corepack pnpm --filter @nexus/web build
corepack pnpm --filter @nexus/web test:e2e
```

Playwright 覆盖 `1440x900` 与 `390x844`，并检查初始结论、冲突、人工采纳、最终“有限立项”、决策解释、水平溢出和关键区域几何重叠。截图输出到 `artifacts/playwright/`。

20 次稳定性检查：

```bash
corepack pnpm test:stability
```

该命令执行 20 次 Playwright，默认输出记录到 `docs/experiments/stability-output.txt`。未实际完成 20/20 之前，不得在投稿材料中填写通过率或耗时结论。

## Mock Mode

`LLM_MODE=mock` 时应用使用确定性的 fixture/provider 路径，不发送外部网络请求。固定 Demo 页面始终标记为 `DEMO FIXTURE`，避免把离线回放误认为实时模型或持久化会话。Mock Mode 可用于无网络、无 API Key、无外部搜索服务的复现。

## 真实模型模式

将 `LLM_MODE` 改为 `openai-compatible`，并填写：

```dotenv
LLM_MODE=openai-compatible
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=your-api-key
LLM_MODEL=your-model
```

真实模型模式需要 Core Service 中的 live orchestration 已接入。当前固定浏览器 Demo 不因切换环境变量而自动改为实时运行；不要用真实模型模式描述 fixture 截图。

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

## 架构与协议文档

- `docs/superpowers/specs/2026-09-10-decision-arena-design.md`
- `docs/architecture/system-overview.md`
- `docs/user-guide/operator-guide.md`
- `docs/experiments/evaluation-plan.md`
- `docs/experiments/submission-checklist.md`

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