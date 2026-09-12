# 决策竞技场评估计划

## 记录格式

每个可比较实验只能追加到下面的固定 CSV 表头；表头不得更改。

```text
experiment_id,project_fixture,mode,started_at,completed_at,duration_seconds,initial_risk_count,challenge_risk_count,conflict_count,human_action,final_conclusion,run_consistent
```

在实验完成并保存原始输出之前，`duration_seconds`、风险计数、`run_consistent` 等字段保持空白。不得根据猜测、演示目标或单次观感填写数值。固定项目使用 `fixtures/lab-safety-project.json`，固定预期报告使用 `fixtures/expected-final-report.json`。

## 指标 1：人工单角色审阅基线

- 目的：建立同一项目在无多 Agent 交叉质询时的审阅结果。
- 步骤：一名人工审阅者只读取固定项目输入，在开始前不查看 Nexus 输出；记录开始、结束、初始识别的关键风险、是否要求补充证据和最终结论。
- 记录：`mode=manual_single_role`，`initial_risk_count` 为人工识别数量，`challenge_risk_count` 留空，`human_action=manual_review`。
- 反偏差：同一审阅者完成 Nexus run 前不得回看自己的基线结果。

## 指标 2：Nexus 五 Agent 完成时间

- 目的：记录从固定输入提交到出现可审阅结论的实际时间，而不是产品宣称时间。
- 步骤：运行固定 Demo 或 live session，记录开始和结束 ISO 时间，以 `duration_seconds` 保存。
- 记录：`mode=mock` 或 `mode=openai-compatible` 必须明确区分；不同模式不得合并。
- 边界：页面加载等待、重试、人工思考时间和网络停顿均计入总完成时间。

## 指标 3：初始风险与质询发现风险

- 目的：比较首轮 Claim 与 Cross Examination 后 Risk/Conflict 数量变化。
- 步骤：首轮完成后记录 `initial_risk_count`；质询、回应和 Conflict Detector 完成后记录 `challenge_risk_count` 与 `conflict_count`。
- 去重：同一根风险被多个 Agent 重复提出时只计一次，并在原始日志中保留映射。
- 记录：必须保存 Claim id、Challenge id 和 Conflict id，避免只保存汇总数。

## 指标 4：重复运行结论一致性

- 目的：验证固定输入在 20 次运行中保持结论与状态恢复一致。
- 命令：

```bash
corepack pnpm test:stability
```

- 原始输出：`docs/experiments/stability-output.txt`。
- 记录：每次 run 追加一行，`run_consistent` 只在同一模式、同一 fixture 和完整流程完成后填写 `true` 或 `false`。失败 run 不得从分母中删除。

## 指标 5：无人工裁决与有人工裁决对比

- 目的：展示 Human Checkpoint 对最终结论的实际影响。
- 无人工路径：在 `HUMAN_REVIEW` 快照停止，记录系统当前结论和未解决 Conflict；`human_action=none`。
- 有人工路径：执行 `accept_challenge`、`uphold_claim` 或 `request_more_analysis` 后记录新结论；`human_action` 使用实际 action。
- 记录：两条路径必须是同一固定 fixture，并保留对应 sequence 与 HumanDecision id。
- 禁止：不得把“无人工自动高风险管理”当作产品能力；高风险冲突必须停在人工检查点。

## 原始证据要求

每次实验至少保存：

- fixture 版本或 Git hash
- mode 与 provider 标识
- started_at / completed_at
- 原始命令
- 标准输出与错误输出
- 截图路径
- 最终结论和报告文件 hash
- 判断一致性所依据的 event sequence