# 投稿材料清单

## 公开仓库

当前 worktree 执行：

```bash
git remote get-url origin
```

实际输出：

```text
error: No such remote 'origin'
```

由于本仓库当前没有 `origin`，不能在清单中伪造公开仓库链接。创建公开 GitHub/Gitee 仓库并执行下面命令后，再补充真实 URL：

```bash
git remote add origin <PUBLIC_REPOSITORY_URL>
git push -u origin feature/decision-arena
```

公开仓库链接：`PENDING_REMOTE_CONFIGURATION`

## AI 对话快照

- [设计冻结与 AI 审查](../ai-history/0001-design-freeze.md)
- [工作区初始化](../ai-history/0003-workspace-bootstrap.md)
- [决策状态机](../ai-history/0005-state-machine.md)
- [人工检查点、回放与报告](../ai-history/0013-human-checkpoint.md)
- [固定 Demo 交付记录](../ai-history/0014-demo-delivery.md)

## Prompt-to-Commit 映射

| ai_history_file | user_prompt_summary | ai_recommendation | human_correction | test_evidence | commit_hash |
|---|---|---|---|---|---|
| `docs/ai-history/0001-design-freeze.md` | 冻结五 Agent 决策竞技场设计与赛事边界 | 用领域对象、状态机和确定性规则约束 LLM | 保留人类最终裁决，不自动关闭高风险冲突 | 设计审查记录 | `3b9be9a` |
| `docs/ai-history/0003-workspace-bootstrap.md` | 初始化 TypeScript/pnpm 工作区与测试基线 | 使用 strict TypeScript、Vitest、Playwright 和独立 shared 包 | 固定 pnpm 10.6.5 与 Node 22 | workspace bootstrap tests | `b6a0673` |
| `docs/ai-history/0005-state-machine.md` | 将质询流程转换成可验证状态机 | 分离领域 phase 与 operational status | 允许 HUMAN_REVIEW 直接进入 DECIDED | `packages/shared` workflow tests | `c05304f` |
| `docs/ai-history/0013-human-checkpoint.md` | 增加 Inspector、Timeline、Human Checkpoint、Replay 和 Report | 用单事务持久化 HumanDecision 和 SESSION_STATE_CHANGED | 增加 compare-and-set 与 eligible conflict 约束 | DB/Core/Web tests | `70545c7` |
| `docs/ai-history/0014-demo-delivery.md` | 固定 fixture、E2E、20 次稳定性和投稿材料 | 浏览器 fixture 模式与 offline Mock Provider 分离 | 明确标注未接入 live orchestration，不宣称未测量指标 | unit/integration/typecheck/build/E2E 输出 | `ff9793a` |
| `docs/ai-history/0015-final-fix-wave.md` | 修复最终评审的 live orchestration、SSE、FinalReport、Claim 不变量和 Next 安全版本 | 以确定性 Mock AgentRunner 和持久化运行时连接浏览器与 Core | 每个会话创建独立 Cross Examination 依赖，并标准化数据库行 | 146 tests、Next build、4 E2E、80/80 stability、live smoke | `c3d4dcc` |
| `docs/ai-history/0017-core-prompt-chains.md` | 汇总 Decision Graph、并行 Agent 竞态、SSE 事件丢失三条核心 Prompt 链 | 用结构化契约、不可变对象、单飞锁和连续序号恢复约束实现 | 接受独立复审发现的 UUIDv7、事件快照、lease fencing 和可重入问题 | 152+ tests、4 E2E、80/80 stability、正式对话导出 | `edd873a` |

## 复现路径

- [README 10 分钟复现](../../README.md)
- fixture: `fixtures/lab-safety-project.json`
- expected report: `fixtures/expected-final-report.json`
- offline runner: `corepack pnpm demo:fixture`
- E2E: `corepack pnpm --filter @nexus/web test:e2e`

## 截图索引

- `artifacts/playwright/desktop-1440x900-initial.png`
- `artifacts/playwright/desktop-1440x900-conflict.png`
- `artifacts/playwright/desktop-1440x900-final.png`
- `artifacts/playwright/desktop-1440x900-report.png`
- `artifacts/playwright/mobile-390x844-initial.png`
- `artifacts/playwright/mobile-390x844-conflict.png`
- `artifacts/playwright/mobile-390x844-final.png`
- `artifacts/playwright/mobile-390x844-report.png`

两个 viewport 均检查初始结论、冲突、人工采纳、最终有限立项、决策解释、水平溢出和关键区域几何重叠。

## 20 次稳定性输出

- 命令：`corepack pnpm test:stability`
- 原始记录：`docs/experiments/stability-output.txt`
- 未完成 20/20 前不得填写通过率、平均耗时或稳定性百分比。

## 8 分钟视频时间图

| 时间 | 内容 |
|---|---|
| 0:00-0:20 | 固定 Demo 初始结论、关键冲突和最终结论 |
| 0:20-0:50 | 固定项目材料、五角色与 Planner 配置 |
| 0:50-1:40 | 五角色独立 Claim 与 Evidence |
| 1:40-2:50 | Challenge、回应、主持评估与 unresolved |
| 2:50-3:40 | Conflict Map 和四项高风险假设 |
| 3:40-4:30 | Human Checkpoint 三种裁决动作 |
| 4:30-5:20 | Decision Replay、决策解释和最终报告 |
| 5:20-6:15 | AI 协同案例 1：Decision Graph 数据结构 |
| 6:15-7:10 | AI 协同案例 2：并行状态竞态 Bug |
| 7:10-8:00 | AI 协同案例 3：Cross Examination 协议 |

## PDF 章节图

| 章节 | 标题 | 主要证据 |
|---|---|---|
| 1 | 问题与作品定义 | 固定输入、目标用户、业务边界 |
| 2 | 五角色决策模型 | AgentRole、Claim、Evidence |
| 3 | Cross Examination 协议 | Challenge、回应、主持裁定 |
| 4 | 系统架构与状态机 | 组件图、序列图、数据库关系 |
| 5 | 可回放与降级设计 | SSE recovery、Mock Mode、失败隔离 |
| 6 | 实验与结论 | CSV、20 次输出和截图 |
| 7 | AI 协同开发证据 | Prompt、Diff、测试、Commit |
| 8 | 复现与投稿附件 | README、视频、截图、仓库 URL |

## 提交前检查

- [x] `origin` 已配置且公开可访问
- [x] 三条以上 AI 对话快照已包含原始 Prompt、建议、纠偏和测试证据
- [x] Prompt-to-Commit 表已补齐 Task 12 最终 hash
- [x] `stability-output.txt` 已记录实际 80/80 输出（桌面 20 + 移动 20）
- [ ] 截图已生成；演示视频待录制
- [ ] PDF 未包含未测量指标
- [x] 固定 Demo 仍明确标记为 fixture，live UUID 会话已走真实持久化 orchestration
