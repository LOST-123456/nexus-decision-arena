# Nexus Decision Arena 演示视频录制包

> 导出目标：MP4、1920×1080、30fps、5–8 分钟  
> 建议成片：7 分 55 秒  
> AI 协同复现：至少 2 分 40 秒  
> 证据基线：`2f91a71`

本录制包只使用仓库中已经存在的界面、AI 对话导出、代码、测试输出和 Commit。不要重新扮演原始 Prompt，
也不要把 Mock fixture 描述为真实模型调用。

## 一、录制前准备

### 1. 环境

```powershell
corepack pnpm install
docker compose up -d postgres
Copy-Item .env.example .env
corepack pnpm --filter @nexus/db db:migrate
corepack pnpm dev
```

浏览器打开：

```text
http://127.0.0.1:3000/sessions/demo
```

### 2. 录制设置

- 分辨率：1920×1080
- 帧率：30fps
- 浏览器缩放：100%
- 隐藏书签栏、无关标签页和桌面通知
- 鼠标移动保持平稳，避免快速甩动
- 终端字号建议 15–18pt，代码编辑器字号建议 16–18pt
- 录制素材、配音和字幕均保留原始工程文件，不只保留最终 MP4

### 3. 录屏前检查

- [ ] 固定 Demo 明确显示 `DEMO FIXTURE`
- [ ] Core `/health` 返回 `{"status":"ok"}`
- [ ] 页面缩放和关键文字在 1080p 下清晰
- [ ] `docs/ai-history/0017-core-prompt-chains.md` 可打开
- [ ] `docs/experiments/stability-output.txt` 可打开
- [ ] 本地 Git 仓库没有未提交的演示代码改动
- [ ] 声音输入无底噪，录制一段 10 秒测试音

## 二、成片时间图

### 0:00–0:20 开场：结论变化

画面：

1. 打开固定 Demo。
2. 快速展示初始“建议立项”。
3. 切到“暂缓规模化扩张”。
4. 停在最终“有限立项”。

建议旁白：

> 这是 Nexus Decision Arena。它不让多个 AI 各说一句，而是让五个具有不同立场的 AI 专家独立分析、
> 相互质询，并把未解决冲突交给人类裁决。

### 0:20–0:50 项目输入与五角色

画面：

1. 展示高校实验室 AI 危化品安全平台输入。
2. 指向四个高风险假设。
3. 展示市场、技术、财务、风险和质询主持人五个角色。
4. 强调 Planner、冲突检测器和报告生成器是确定性组件。

### 0:50–1:40 独立分析

画面：

1. 展示五个 Agent 的运行状态。
2. 展开至少三个方向的 Claim。
3. 点击一个 Claim，展示 Evidence、可靠性和核验状态。
4. 说明 Assumption 不会被伪装成 Fact。

### 1:40–2:50 Cross Examination

画面：

1. 点击一个高重要度 Claim。
2. 展示针对它的 Challenge。
3. 展示 requiredEvidence、severity 和 resolutionStrategy。
4. 展示目标 Agent 产生新版 Claim 回应。
5. 展示主持人核验结果和 unresolved 状态。

建议旁白：

> 质疑不是一段新的自由文本，而是带目标、证据要求、严重度和解决策略的结构化对象。回应也不会覆盖原
> Claim，而是形成可追溯的新版本。

### 2:50–3:40 Conflict Map

画面：

1. 展示四个高风险假设与对应 Conflict。
2. 展开 severity 和 impactScope。
3. 说明高严重度或跨域影响必须进入 Human Checkpoint。

### 3:40–4:30 人工裁决

画面：

1. 展示 `accept_challenge`、`uphold_claim`、`request_more_analysis` 三种动作。
2. 选择“采纳质询”。
3. 填写简短理由。
4. 展示前后结论与受影响 Claim。
5. 强调高风险冲突不能自动关闭。

### 4:30–5:20 Replay 与报告

画面：

1. 点击 Timeline 中导致结论变化的事件。
2. 展示 Decision Map 恢复到对应时刻。
3. 展示 decision rationale。
4. 打开最终报告，展示 Executive Summary、关键冲突、人工裁决和建议下一步。

## 三、AI 协同复现

这一部分不得少于 2 分钟，并必须直接使用已导出的真实对话或代码证据。

### 5:20–6:15 案例一：Decision Graph 与 UUIDv7

素材：

- `docs/ai-history/0017-core-prompt-chains.md` 的链路 1
- `docs/ai-history/0016-codex-conversation-export.md`
- `packages/shared/src/ids.ts`
- Commit `901ce8c`

画面顺序：

1. 展示用户原始 Prompt：UUID、版本、关联关系、description、validityPeriod、context 和 resolutionStrategy。
2. 展示 AI 建议：UUIDv7、新版本 Claim、结构化关系、高风险转人工。
3. 展示人工纠偏：增加 correlationId、决策解释和 locale 预留。
4. 展示 Bug：通用 UUID 校验允许 v1/v4。
5. 展示修复 Diff 和 9/9 测试输出。
6. 显示 Commit `901ce8c`。

### 6:15–7:10 案例二：并行状态竞争

素材：

- `docs/ai-history/0017-core-prompt-chains.md` 的链路 2
- `services/core/src/arena/cross-examination.ts`
- Commit `c7b0c8b`、`e47c016`、`cfad589`

画面顺序：

1. 展示用户 Prompt：Promise.allSettled、独立 try/catch、Claim 不可变。
2. 展示问题：原 Claim 可被修改、响应可复用旧 revision。
3. 展示修复：`structuredClone`、版本链校验、Challenge 关联校验。
4. 展示 `CHALLENGE_CREATED` 不可变快照。
5. 展示并发补充轮单飞锁和回归测试。
6. 显示三个 Commit Hash。

### 7:10–8:00 案例三：SSE 丢失、乱序与幂等 lease

素材：

- `docs/ai-history/0017-core-prompt-chains.md` 的链路 3
- `services/core/src/execution/event-bus.ts`
- `services/core/src/api/routes/events.ts`
- `services/core/src/api/plugins/idempotency.ts`
- `docs/experiments/stability-output.txt`
- Commit `ac90dbe`、`39f8ce7`、`c77551a`、`79f7e25`

画面顺序：

1. 展示用户 Prompt：Last-Event-ID、事务后发布、客户端恢复、幂等。
2. 展示四个真实问题：replay 窗口、乱序误丢、连接泄漏、processing 卡死。
3. 展示 pending map、指数退避、lease token 和 fencing。
4. 展示 SSE 与幂等回归测试从失败到通过。
5. 打开 `stability-output.txt`，停在 `80 passed`。
6. 显示四个 Commit Hash。

## 四、导出与后期

### 1. 视频编码

最终文件使用：

- 容器：MP4
- 视频：H.264 / AVC
- 分辨率：1920×1080
- 帧率：30fps
- 码率：8–12 Mbps
- 音频：AAC，48kHz，立体声，建议 192 kbps
- 响度：约 -16 LUFS

如果在剪辑软件中导出，请关闭自动分辨率，手动确认输出为 1920×1080。

### 2. 字幕

- 中文旁白建议提供硬字幕或平台可接受的独立字幕。
- 代码、Commit Hash、命令和文件名不要仅靠语音表达，必须同时出现在画面中。
- AI 协同部分建议固定显示当前案例标题，避免观众迷失。

### 3. 成片检查

- [ ] 总时长位于 5–8 分钟
- [ ] AI 协同复现不少于 2 分钟
- [ ] 功能覆盖分析、质询、冲突、裁决、Replay、报告
- [ ] AI 片段同时出现原始 Prompt、AI 建议、人工纠偏、Diff、测试和 Commit
- [ ] 固定 Demo 明确标注 `DEMO FIXTURE`
- [ ] 没有把 Mock Mode 或 fixture 描述为真实模型输出
- [ ] 终端和代码文字在 1080p 下可读
- [ ] 音频无削波、爆音和长时间静音
- [ ] 最终文件可在一台未安装开发环境的电脑上正常播放
- [ ] 按赛事命名规则重命名最终 MP4

## 五、建议文件组织

```text
artifacts/submission/video/
  raw/
    demo-screen-recording.mp4
    ai-history-screen-recording.mp4
    voiceover.wav
  edit/
    video-project-file
  Nexus-Decision-Arena-Demo.mp4
```

原始素材与最终成片分别保留，便于评委要求补充证明时继续追溯。
