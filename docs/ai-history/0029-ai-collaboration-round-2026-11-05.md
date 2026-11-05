# 真实模型回合留档：README 链接检查器（2026-11-05）

这份目录是成片 5:26–7:54 那段「AI 协同过程复现」的原始材料。放进来是为了让评审能逐条核对，
不是为了凑材料——四轮全部不达标，一次人工接管，最后跑绿。

## 一、这是什么

| 项 | 值 |
| --- | --- |
| 模型 | 本地 `qwen2.5:3b`（Ollama，CPU 推理，无外部 API） |
| 任务 | 给 `scripts/check-readme-links.mjs` 写实现：校验 README 里提到的本地文件是否真实存在 |
| 往返 | 4 轮 |
| 耗时 | 24.6 / 23.8 / 3.4 / 45.3 秒（首块到末块），共 1400 个流式块 |
| 结果 | 四轮全部不可用；人工接管核心逻辑后通过 |
| 提交 | `5177555`，1 个文件 47 行（产生于本次回合的独立副本，见第五节） |

## 二、文件说明

| 文件 | 内容 |
| --- | --- |
| `PROMPT-4.md` | 第 4 轮的 Prompt 原文（前 3 轮的 Prompt 见会话记录，本轮只归档最终版） |
| `round1.jsonl` … `round4.jsonl` | 每轮的**逐块流式输出**，`{"t": 相对毫秒, "chunk": 文本}`，未删改 |
| `check-readme-links.mjs` | 人工定稿版（与仓库根 `scripts/check-readme-links.mjs` 同一份） |

`t` 是相对该轮第一个 token 的毫秒偏移，所以「用时」可以直接从首末行算出来，
不需要相信任何自述。

## 三、四轮为什么都不达标

| 轮次 | 模型给了什么 | 真实后果 |
| --- | --- | --- |
| 1 | 解释写在代码块外，代码里用 `__dirname` | 剥掉围栏后 `ReferenceError: __dirname is not defined in ES module scope` |
| 2 | 改用 `require`，整体仍是 CommonJS | `ReferenceError: require is not defined in ES module scope` |
| 3 | 只回 4 行 `import`，没有任何逻辑 | **退出码 0** —— 最坏的一种：假通过 |
| 4 | 结构正确，但把验收样例硬编码进实现 | 反引号多转义 → `SyntaxError`；修正后仍要人工接管 |

第 4 轮那处最值得记：它把 `docs/nonexistent-guide.md` 写死在实现里。
这不是 bug，是把「我该怎么验证」当成了「我该怎么实现」——代码会永远红，或者永远假绿。

## 四、人工接管改了什么

四处，前三处是机械错误，第四处是语义错误：

1. CommonJS → ESM（项目 `package.json` 是 `type: module`）；
2. 正则里的反引号多转义了一层（`/\\`…\\`/` 在正则字面量里是非法序列）；
3. 过滤条件写反了：它把 `.md` 结尾的全丢掉，恰好丢了最该查的那类；
4. 删掉硬编码在实现里的验收样例。

改完第一次跑**仍然是红**：它报了 `.data/users.json` 缺失。核对 README 第 76 行
（「首次启动会创建 `.data/users.json`」）后确认那是运行时产物，补白名单才转绿。
所以这个绿不是「什么都没查」。

## 五、怎么复跑

在本仓库根目录：

```bash
node scripts/check-readme-links.mjs          # 期望：退出码 0，106 条候选全部命中
```

负向验证（证明它会红）：

```bash
printf '\n参见 `docs/nonexistent-guide.md`。\n' >> README.md
node scripts/check-readme-links.mjs          # 期望：打印该路径，退出码 1
git checkout -- README.md
node scripts/check-readme-links.mjs          # 期望：恢复 0
```

**关于提交 `5177555`**：那一轮是在同一仓库的浅克隆副本里跑的（为了让「提交」这一步是真的，
又不污染主仓库历史），所以该哈希不在本仓库的提交链里。同一份文件已经放进本目录，
并作为 `scripts/check-readme-links.mjs` 提交到本仓库；上面的命令可以直接复跑。

## 六、这段材料不能证明什么

- 不能证明模型能力：`qwen2.5:3b` 是小模型，一个任务、一次采样，不构成任何评测；
- 不能证明我们的 Prompt 写法最优：第 4 轮仍然要求人改四处；
- 不替代产品主线：这条回合是**工程协作**的证据，产品侧的意图控制、质询协议、
  人工裁决另有各自的测试与文档。

说清楚这些，比让视频「看起来一切顺利」更有用。
