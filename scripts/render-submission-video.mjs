import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const outputDirectory = path.join(repositoryRoot, "artifacts", "submission");
const buildDirectory = path.join(outputDirectory, "video-build");
const framesDirectory = path.join(buildDirectory, "frames");
const clipsDirectory = path.join(buildDirectory, "clips");
const finalVideo = path.join(outputDirectory, "Nexus-Decision-Arena-Demo.mp4");
const subtitleFile = path.join(
  outputDirectory,
  "Nexus-Decision-Arena-Demo.zh-CN.srt"
);
const posterFile = path.join(outputDirectory, "Nexus-Decision-Arena-Demo-poster.png");

const scenes = [
  {
    id: "cover",
    mode: "hero",
    duration: 12,
    kicker: "AI INNOVATION APPLICATION CHALLENGE",
    title: "Nexus Decision Arena",
    subtitle: "AI 决策评审与质询沙盘",
    notes: ["多个 AI 专家独立分析、交叉质询、暴露冲突", "由人类完成最终裁决并形成可回放报告"],
    caption: "让多个 AI 专家独立分析、相互质询，把未解决分歧交给人类完成可追溯决策。",
    accent: "#22a699"
  },
  {
    id: "problem",
    mode: "split",
    duration: 16,
    kicker: "01 · PROBLEM",
    title: "多 Agent 不等于可评审决策",
    bullets: [
      "普通系统并列展示多段回答，读者仍需自行归纳",
      "观点缺少可比较的断言、证据和定向质疑",
      "冲突没有被结构化，结论变化无法追溯",
      "模型可能直接给出高风险最终答案"
    ],
    caption: "真正困难的不是生成更多观点，而是让观点可比较、可质疑、可追责。",
    accent: "#e47c4a"
  },
  {
    id: "solution",
    mode: "flow",
    duration: 16,
    kicker: "02 · SOLUTION",
    title: "受约束的决策评审闭环",
    steps: ["独立分析", "交叉质询", "冲突检测", "人工裁决", "可回放报告"],
    bullets: ["LLM 只生成结构化领域对象", "规则负责选择、分配、状态迁移和冲突检测"],
    caption: "系统把核心流程固定为五步，LLM 不掌握无限编排权。",
    accent: "#22a699"
  },
  {
    id: "architecture",
    mode: "cards",
    duration: 18,
    kicker: "03 · ARCHITECTURE",
    title: "分层架构与清晰边界",
    cards: [
      { title: "Web", body: "Decision Map、Inspector、Timeline、Human Checkpoint、Report" },
      { title: "Core", body: "Workflow、Arena、Cross Examination、Conflict、Replay" },
      { title: "Shared", body: "Zod Schema、状态机、DTO、UUIDv7、事件视图" },
      { title: "Adapters", body: "MockLlmProvider、OpenAI-compatible、PostgreSQL、SSE" }
    ],
    caption: "Agent 业务规则不埋在 UI；前端不直接依赖数据库表或 View。",
    accent: "#4b8fd1"
  },
  {
    id: "new-review",
    mode: "split",
    duration: 18,
    kicker: "04 · PROJECT INTAKE",
    title: "新建评审必须使用真实模型",
    bullets: [
      "Owner 与 Reviewer 登录后创建，Viewer 只能查看",
      "页面读取 /api/runtime 并显示当前运行模式",
      "历史记录可继续评审、查看报告并按权限删除",
      "安全治理页说明密钥、日志、删除与模型调用边界"
    ],
    image: "artifacts/playwright/desktop-1440x900-new-review-real-model.png",
    caption: "新项目与固定 Demo 明确分离，避免把 fixture 结果误认为真实项目分析。",
    accent: "#22a699"
  },
  {
    id: "roles",
    mode: "cards",
    duration: 18,
    kicker: "05 · FIVE ROLES",
    title: "五个一级角色，内部多视角",
    cards: [
      { title: "市场分析师", body: "需求、规模、采购管道、数据可信度" },
      { title: "技术专家", body: "架构、依赖、工程量、交付风险" },
      { title: "财务分析师", body: "成本、收入、现金流、单位经济" },
      { title: "风险审查员", body: "合规、隐私、安全、伦理、责任边界" },
      { title: "质询主持人", body: "证据充分性、逻辑一致性、矛盾识别" }
    ],
    caption: "角色数量保持克制，细分能力作为 Lens 内聚，避免概念膨胀。",
    accent: "#4b8fd1"
  },
  {
    id: "initial-claims",
    mode: "split",
    duration: 20,
    kicker: "06 · INDEPENDENT ANALYSIS",
    title: "独立 Claim 暴露真实分歧",
    bullets: [
      "需求方向明确，但采购管道尚未验证",
      "包含硬件与实施成本后，65% 毛利率不成立",
      "软件原型可行，硬件适配周期仍需验证",
      "安全责任与数据边界尚未形成书面依据"
    ],
    image: "artifacts/playwright/desktop-1440x900-initial.png",
    caption: "每个结论都是带类型、立场、重要度、置信度和证据引用的 Claim。",
    accent: "#22a699"
  },
  {
    id: "evidence",
    mode: "split",
    duration: 20,
    kicker: "07 · EVIDENCE",
    title: "证据有来源、可靠性和有效期",
    bullets: [
      "Assumption 永远不能伪装成 Fact",
      "外部引用必须提供 sourceRef",
      "可靠性等级与核验状态分离",
      "关键 Claim 缺少证据时进入质询"
    ],
    image: "artifacts/playwright/desktop-1440x900-conflict.png",
    caption: "系统不把“像真的”当作“已核验”，证据不足会触发结构化质疑。",
    accent: "#e47c4a"
  },
  {
    id: "cross-examination",
    mode: "split",
    duration: 22,
    kicker: "08 · CROSS EXAMINATION",
    title: "质询针对具体 Claim，而不是自由辩论",
    bullets: [
      "一个 Challenge 只指向一个 Claim",
      "质询者不能质询自己的断言",
      "必须列出所需证据、严重度和解决策略",
      "主持人核验回应为 resolved 或 unresolved"
    ],
    image: "artifacts/playwright/desktop-1440x900-conflict.png",
    caption: "质询是可测试协议：目标、上下文、证据要求、严重度和解决策略全部结构化。",
    accent: "#22a699"
  },
  {
    id: "human-rationale",
    mode: "split",
    duration: 20,
    kicker: "09 · HUMAN DECISION",
    title: "人工理由与影响范围可追溯",
    bullets: [
      "Human Checkpoint 提供自由文本理由",
      "可多选受影响的 Agent 范围",
      "理由与影响范围写入 HumanDecision",
      "报告和 Replay 保留完整裁决依据"
    ],
    image: "artifacts/playwright/desktop-1440x900-human-rationale.png",
    caption: "人工裁决不只是点击按钮，理由和影响范围都进入可审计记录。",
    accent: "#4b8fd1"
  },
  {
    id: "conflict-map",
    mode: "split",
    duration: 20,
    kicker: "10 · CONFLICT MAP",
    title: "未解决分歧成为 Conflict",
    bullets: [
      "冲突关联 Claim 与 Challenge",
      "严重度和影响范围决定是否转人工",
      "resolutionSuggestion 只提供建议",
      "高风险 Conflict 不能自动关闭"
    ],
    image: "artifacts/playwright/desktop-1440x900-conflict.png",
    caption: "系统把分歧显式记录为 Conflict，而不是藏在多段文本之间。",
    accent: "#d55b5b"
  },
  {
    id: "report-export",
    mode: "split",
    duration: 18,
    kicker: "11 · REPORT EXPORT",
    title: "报告支持 PDF、Markdown 与 JSON",
    bullets: [
      "PDF 可直接打印或另存",
      "Markdown 便于二次编辑和归档",
      "JSON 包含完整领域对象与 ExecutionEvent",
      "审计包保留 Claim、Evidence、Challenge 与人工裁决"
    ],
    image: "artifacts/playwright/desktop-1440x900-report-export.png",
    caption: "最终结果不仅能浏览，还能作为完整审计包导出和复核。",
    accent: "#e47c4a"
  },
  {
    id: "human-checkpoint",
    mode: "cards",
    duration: 18,
    kicker: "12 · HUMAN CHECKPOINT",
    title: "人类在关键争议点做最终裁决",
    cards: [
      { title: "采纳质询", body: "接受异议，推动 Claim 修订" },
      { title: "维持判断", body: "保留结论，但必须记录理由" },
      { title: "补充分析", body: "最多执行一次受控补充轮" }
    ],
    caption: "高风险决策不会自动完成，Human Intent 是状态变化的一部分。",
    accent: "#22a699"
  },
  {
    id: "limited-pilot",
    mode: "split",
    duration: 16,
    kicker: "13 · DECISION CHANGE",
    title: "从“建议立项”改为“有限立项”",
    bullets: [
      "先在 3 间实验室验证 12 个月",
      "设置技术、采购和合规阶段门槛",
      "验证通过后再讨论规模化扩张",
      "记录前后结论与受影响 Agent"
    ],
    image: "artifacts/playwright/desktop-1440x900-final.png",
    caption: "结论变化来自公开质询和人工裁决，而不是模型随机改写。",
    accent: "#22a699"
  },
  {
    id: "replay",
    mode: "split",
    duration: 20,
    kicker: "14 · DECISION REPLAY",
    title: "时间线回放完整决策过程",
    bullets: [
      "ExecutionEvent 按 session 单调递增",
      "Last-Event-ID 断线补齐事件",
      "客户端按连续 sequence 恢复状态",
      "点击 Timeline 回到结论变化时刻"
    ],
    image: "artifacts/playwright/desktop-1440x900-final.png",
    caption: "回放的不是一张截图，而是导致最终结论的完整事件链。",
    accent: "#4b8fd1"
  },
  {
    id: "report",
    mode: "split",
    duration: 18,
    kicker: "15 · FINAL REPORT",
    title: "最终报告可直接支持下一步行动",
    bullets: [
      "Executive Summary 与关键结论",
      "支持证据、反对证据和核心冲突",
      "风险等级与待验证假设",
      "人工裁决、决策解释和下一步行动"
    ],
    image: "artifacts/playwright/desktop-1440x900-report.png",
    caption: "报告只汇总已通过 Schema 校验的领域对象、人工裁决和事件事实。",
    accent: "#22a699"
  },
  {
    id: "reproducible",
    mode: "cards",
    duration: 18,
    kicker: "16 · REPRODUCIBILITY",
    title: "复现单位是完整决策过程",
    cards: [
      { title: "固定输入", body: "fixture 与 expected report 均入库" },
      { title: "固定依赖", body: "package.json + pnpm-lock.yaml" },
      { title: "固定模式", body: "Mock Mode 无外网、无模型 API 可运行" },
      { title: "固定证据", body: "事件、测试、截图、Prompt、Commit" }
    ],
    caption: "评委可以在 10 分钟内启动并重复固定 Demo，而不是只阅读结果。",
    accent: "#4b8fd1"
  },
  {
    id: "verification",
    mode: "metrics",
    duration: 18,
    kicker: "17 · VERIFICATION",
    title: "只展示实际完成的验证",
    metrics: [
      { value: "157/157", label: "单元与集成测试" },
      { value: "4/4", label: "桌面与移动 E2E" },
      { value: "80/80", label: "重复 Playwright 用例" },
      { value: "28", label: "技术文档页数" }
    ],
    caption: "未执行的人工基线和真实模型规模化评测没有被包装成已完成结果。",
    accent: "#22a699"
  },
  {
    id: "ai-intro",
    mode: "cards",
    duration: 14,
    kicker: "18 · AI COLLABORATION",
    title: "三条可追溯的核心 Prompt 链",
    cards: [
      { title: "Decision Graph", body: "领域结构、UUIDv7、版本和关系" },
      { title: "并行状态竞争", body: "不可变对象、失败隔离、单飞锁" },
      { title: "SSE 与幂等", body: "事件丢失、乱序、恢复和 lease fencing" }
    ],
    caption: "每条链都保留用户 Prompt、AI 建议、人工纠偏、Bug、测试和 Commit。",
    accent: "#4b8fd1"
  },
  {
    id: "case-one-prompt",
    mode: "code",
    duration: 18,
    kicker: "19 · PROMPT CHAIN 1A",
    title: "Decision Graph：先约束领域模型",
    code: [
      "Claim ID 使用 UUID，避免冲突",
      "Claim 增加版本号和时间戳",
      "关联关系必须区分 supports / contradicts",
      "Evidence 增加 description 和 validityPeriod",
      "Conflict 增加 resolutionSuggestion 和 impactScope"
    ],
    bullets: ["用户不是要求“做一个 Agent 图”，而是要求可追踪的决策对象"],
    caption: "原始 Prompt 先定义领域语义，再允许 AI 进入代码实现。",
    accent: "#22a699"
  },
  {
    id: "case-one-fix",
    mode: "code",
    duration: 20,
    kicker: "20 · PROMPT CHAIN 1B",
    title: "AI 建议被收紧，并发现 UUID 校验 Bug",
    code: [
      "AI 建议：所有核心对象使用 UUIDv7",
      "AI 建议：Claim 实质变化创建新版本",
      "人工纠偏：增加 correlationId 与决策解释",
      "Bug：z.string().uuid() 仍允许 UUID v1 / v4",
      "修复：严格校验版本位和 RFC 变体位"
    ],
    bullets: ["验证：共享包测试 9/9 通过", "Commit：901ce8c"],
    caption: "Prompt 不是一次性生成代码，而是持续收敛领域约束并修复实现偏差。",
    accent: "#e47c4a"
  },
  {
    id: "case-two-problem",
    mode: "code",
    duration: 20,
    kicker: "21 · PROMPT CHAIN 2A",
    title: "并行 Agent 状态竞争：先暴露不稳定点",
    code: [
      "用户：使用 Promise.allSettled 隔离单个 Agent 失败",
      "用户：每个 Challenge 独立 try/catch",
      "用户：原 Claim 不可原地修改",
      "问题：依赖对象仍可修改原 Claim",
      "问题：回应可复用旧 revision",
      "问题：CHALLENGE_CREATED 事件后续可变"
    ],
    caption: "测试先证明系统在并发和不可变性上不可靠，再进入修复。",
    accent: "#d55b5b"
  },
  {
    id: "case-two-fix",
    mode: "code",
    duration: 20,
    kicker: "22 · PROMPT CHAIN 2B",
    title: "AI 修复竞态并补齐回归测试",
    code: [
      "修复：structuredClone 隔离交给依赖的 Claim",
      "修复：独立校验版本链、Challenge 和 session 归属",
      "修复：发布 CHALLENGE_CREATED 不可变快照",
      "修复：补充轮使用 session advisory lock",
      "回归：并发补充轮只执行一次"
    ],
    bullets: ["Commit：c7b0c8b / e47c016 / cfad589"],
    caption: "人工纠偏把“看起来能跑”提升为可并发、可修改、可回归验证的实现。",
    accent: "#22a699"
  },
  {
    id: "case-three-problem",
    mode: "code",
    duration: 20,
    kicker: "23 · PROMPT CHAIN 3A",
    title: "SSE 事件丢失、乱序与恢复",
    code: [
      "用户：支持 Last-Event-ID 重连和事件回放",
      "用户：数据库事务提交后才能发布事件",
      "问题：replay 结束到订阅开始存在丢事件窗口",
      "问题：乱序事件在 gap 补齐前被错误丢弃",
      "问题：断开时订阅与 heartbeat 未清理",
      "问题：进程崩溃留下永久 processing 记录"
    ],
    caption: "真实 Bug 不是模板文本，而是独立复审发现后写入失败测试的具体问题。",
    accent: "#d55b5b"
  },
  {
    id: "case-three-fix",
    mode: "code",
    duration: 20,
    kicker: "24 · PROMPT CHAIN 3B",
    title: "事件恢复与幂等 lease 的最终修复",
    code: [
      "先订阅并缓存实时事件，再读取 replay",
      "expectedSequence + pending map 处理乱序",
      "gap recovery 使用 25ms 到 1000ms 指数退避",
      "幂等记录增加 lease token 和过期回收",
      "旧 lease 不能覆盖或删除新 lease 结果"
    ],
    bullets: ["验证：Core、DB、TypeScript、Playwright、80/80 稳定性均通过"],
    caption: "修复必须同时保留恢复、幂等、连接清理和旧 lease fencing。",
    accent: "#22a699"
  },
  {
    id: "summary",
    mode: "hero",
    duration: 16,
    kicker: "25 · SUBMISSION",
    title: "Nexus Decision Arena",
    subtitle: "让 AI 不只给出答案，而是相互质询、暴露分歧，帮助人做决策。",
    notes: [
      "GitHub: github.com/LOST-123456/nexus-decision-arena",
      "Gitee: gitee.com/lost666666/nexus-decision-arena",
      "AI 对话、Prompt 链、账户权限、安全治理、技术 PDF 与复现指南已入库"
    ],
    caption: "独立分析、交叉质询、冲突检测、人工裁决、可回放报告。",
    accent: "#22a699"
  }
];

function resolvePlaywrightModule() {
  const candidates = [
    process.env.PLAYWRIGHT_MODULE,
    path.join(
      os.homedir(),
      ".cache",
      "codex-runtimes",
      "codex-primary-runtime",
      "dependencies",
      "node",
      "node_modules",
      "playwright",
      "index.mjs"
    ),
    path.join(repositoryRoot, "node_modules", "playwright", "index.mjs"),
    path.join(repositoryRoot, "apps", "web", "node_modules", "playwright", "index.mjs")
  ].filter(Boolean);

  const match = candidates.find((candidate) => existsSync(candidate));
  if (!match) {
    throw new Error(
      "Playwright was not found. Install workspace dependencies or set PLAYWRIGHT_MODULE."
    );
  }
  return pathToFileURL(match).href;
}

function findFile(directory, filename) {
  if (!existsSync(directory)) {
    return null;
  }
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = findFile(fullPath, filename);
      if (nested) {
        return nested;
      }
    } else if (entry.name.toLowerCase() === filename.toLowerCase()) {
      return fullPath;
    }
  }
  return null;
}

function resolveFfmpeg() {
  const candidates = [
    process.env.FFMPEG_PATH,
    path.join(repositoryRoot, ".tools", "ffmpeg", "package", "ffmpeg.exe")
  ].filter(Boolean);

  const direct = candidates.find((candidate) => existsSync(candidate));
  if (direct) {
    return direct;
  }

  const nested = findFile(path.join(os.tmpdir(), "nexus-ffmpeg"), "ffmpeg.exe");
  if (nested) {
    return nested;
  }

  const where = spawnSync("where.exe", ["ffmpeg"], { encoding: "utf8" });
  if (where.status === 0) {
    return where.stdout.split(/\r?\n/).find(Boolean);
  }

  throw new Error("FFmpeg was not found. Set FFMPEG_PATH and rerun.");
}

function imageDataUri(relativePath) {
  if (!relativePath) {
    return null;
  }
  const imagePath = path.join(repositoryRoot, relativePath);
  const extension = path.extname(imagePath).toLowerCase();
  const mime = extension === ".jpg" || extension === ".jpeg" ? "image/jpeg" : "image/png";
  return `data:${mime};base64,${readFileSync(imagePath).toString("base64")}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderList(items, className = "bullet-list") {
  if (!items?.length) {
    return "";
  }
  return `<ul class="${className}">${items
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("")}</ul>`;
}

function renderCards(cards) {
  return `<div class="card-grid">${cards
    .map(
      (card) =>
        `<div class="info-card"><b>${escapeHtml(card.title)}</b><span>${escapeHtml(
          card.body
        )}</span></div>`
    )
    .join("")}</div>`;
}

function renderMetrics(metrics) {
  return `<div class="metrics-grid">${metrics
    .map(
      (metric) =>
        `<div class="metric-card"><b>${escapeHtml(metric.value)}</b><span>${escapeHtml(
          metric.label
        )}</span></div>`
    )
    .join("")}</div>`;
}

function renderFlow(steps) {
  return `<div class="flow">${steps
    .map((step, index) => {
      const arrow = index === steps.length - 1 ? "" : '<span class="arrow">→</span>';
      return `<div class="flow-node">${escapeHtml(step)}</div>${arrow}`;
    })
    .join("")}</div>`;
}

function renderCode(lines) {
  return `<pre class="code-panel">${lines.map(escapeHtml).join("\n")}</pre>`;
}

function sceneHtml(scene, index, startSeconds) {
  const current = formatClock(startSeconds);
  const total = formatClock(totalDurationSeconds());
  const imageSource = imageDataUri(scene.image);
  const content = [];

  if (scene.mode === "hero") {
    content.push(`<div class="hero-copy">`);
    content.push(`<h1>${escapeHtml(scene.title)}</h1>`);
    if (scene.subtitle) {
      content.push(`<h2>${escapeHtml(scene.subtitle)}</h2>`);
    }
    content.push(renderList(scene.notes, "hero-list"));
    content.push(`</div>`);
  }

  if (scene.mode === "split") {
    content.push(`<div class="split-grid">`);
    content.push(`<div class="copy-column">${renderList(scene.bullets)}</div>`);
    content.push(
      `<div class="image-column">${
        imageSource
          ? `<img src="${imageSource}" alt="${escapeHtml(scene.title)}" />`
          : ""
      }</div>`
    );
    content.push(`</div>`);
  }

  if (scene.mode === "cards") {
    content.push(renderCards(scene.cards));
  }

  if (scene.mode === "metrics") {
    content.push(renderMetrics(scene.metrics));
  }

  if (scene.mode === "flow") {
    content.push(renderFlow(scene.steps));
    content.push(`<div class="flow-notes">${renderList(scene.bullets)}</div>`);
  }

  if (scene.mode === "code") {
    content.push(`<div class="code-grid">`);
    content.push(renderCode(scene.code));
    content.push(
      `<div class="code-side">${renderList(scene.bullets, "bullet-list compact")}</div>`
    );
    content.push(`</div>`);
  }

  return `
    <section class="scene scene-${index + 1}" data-scene="${scene.id}">
      <div class="grid-overlay"></div>
      <header class="scene-header">
        <div class="kicker">${escapeHtml(scene.kicker)}</div>
        <div class="clock">${current} / ${total}</div>
      </header>
      <main class="scene-main">
        ${scene.mode === "hero" ? "" : `<h1>${escapeHtml(scene.title)}</h1>`}
        ${content.join("")}
      </main>
      <footer class="caption-bar">
        <span>${escapeHtml(scene.caption)}</span>
      </footer>
      <div class="accent-line" style="background:${scene.accent}"></div>
    </section>
  `;
}

function totalDurationSeconds() {
  return scenes.reduce((sum, scene) => sum + scene.duration, 0);
}

function formatClock(secondsValue) {
  const seconds = Math.round(secondsValue);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatSrtTime(secondsValue) {
  const totalMilliseconds = Math.round(secondsValue * 1000);
  const hours = Math.floor(totalMilliseconds / 3_600_000);
  const minutes = Math.floor((totalMilliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMilliseconds % 60_000) / 1000);
  const milliseconds = totalMilliseconds % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(
    2,
    "0"
  )}:${String(seconds).padStart(2, "0")},${String(milliseconds).padStart(3, "0")}`;
}

function buildDocument() {
  let cursor = 0;
  const sceneMarkup = scenes
    .map((scene, index) => {
      const markup = sceneHtml(scene, index, cursor);
      cursor += scene.duration;
      return markup;
    })
    .join("");

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #081924; }
  body {
    font-family: "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif;
    color: #f4fafb;
  }
  .scene {
    position: relative;
    width: 1920px;
    height: 1080px;
    overflow: hidden;
    background: #0b2230;
  }
  .grid-overlay {
    position: absolute;
    inset: 0;
    opacity: 0.34;
    background-image:
      linear-gradient(rgba(96, 153, 163, 0.13) 1px, transparent 1px),
      linear-gradient(90deg, rgba(96, 153, 163, 0.13) 1px, transparent 1px);
    background-size: 72px 72px;
    mask-image: linear-gradient(to bottom, black, transparent 84%);
  }
  .scene-header {
    position: absolute;
    top: 58px;
    left: 96px;
    right: 96px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    z-index: 3;
  }
  .kicker {
    color: #7de2d7;
    font-size: 24px;
    font-weight: 800;
    letter-spacing: 0.14em;
  }
  .clock {
    color: #c4d4d8;
    font-family: Consolas, monospace;
    font-size: 23px;
  }
  .scene-main {
    position: absolute;
    top: 132px;
    left: 96px;
    right: 96px;
    bottom: 188px;
    z-index: 2;
  }
  h1 {
    max-width: 1680px;
    margin: 0 0 38px;
    color: #ffffff;
    font-size: 68px;
    line-height: 1.14;
    letter-spacing: 0;
  }
  h2 {
    margin: 0 0 44px;
    color: #9ddbd4;
    font-size: 42px;
    font-weight: 500;
    line-height: 1.35;
  }
  .hero-copy {
    display: flex;
    flex-direction: column;
    justify-content: center;
    min-height: 610px;
    max-width: 1500px;
  }
  .hero-copy h1 {
    margin-bottom: 20px;
    font-size: 112px;
  }
  .hero-copy h2 {
    margin-bottom: 48px;
    font-size: 54px;
  }
  .hero-list {
    margin: 0;
    padding-left: 42px;
    color: #d5e6e7;
    font-size: 34px;
    line-height: 1.75;
  }
  .split-grid {
    display: grid;
    grid-template-columns: 680px 1fr;
    gap: 54px;
    height: 100%;
  }
  .copy-column {
    display: flex;
    align-items: center;
  }
  .image-column {
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 0;
  }
  .image-column img {
    width: 100%;
    max-height: 660px;
    object-fit: contain;
    border: 2px solid #476674;
    border-radius: 18px;
    box-shadow: 0 24px 70px rgba(0, 0, 0, 0.34);
    background: #122c3a;
  }
  .bullet-list {
    margin: 0;
    padding-left: 38px;
    color: #e2eff0;
    font-size: 34px;
    line-height: 1.62;
  }
  .bullet-list li {
    margin-bottom: 19px;
  }
  .bullet-list li::marker {
    color: #57d6c6;
  }
  .bullet-list.compact {
    font-size: 28px;
    line-height: 1.55;
  }
  .card-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 26px;
    align-content: center;
    height: 100%;
  }
  .card-grid:has(.info-card:nth-child(5):last-child) {
    grid-template-columns: repeat(5, minmax(0, 1fr));
  }
  .info-card {
    min-height: 300px;
    padding: 34px;
    border: 2px solid #426273;
    border-top: 9px solid #31b8a8;
    border-radius: 18px;
    background: rgba(20, 52, 68, 0.96);
    box-shadow: 0 18px 50px rgba(0, 0, 0, 0.24);
  }
  .info-card b {
    display: block;
    margin-bottom: 22px;
    color: #ffffff;
    font-size: 34px;
    line-height: 1.3;
  }
  .info-card span {
    color: #c7dcdf;
    font-size: 27px;
    line-height: 1.55;
  }
  .metrics-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 34px;
    align-content: center;
    height: 100%;
  }
  .metric-card {
    padding: 48px 38px;
    border: 2px solid #426273;
    border-left: 12px solid #31b8a8;
    border-radius: 18px;
    background: rgba(20, 52, 68, 0.96);
    text-align: center;
  }
  .metric-card b {
    display: block;
    margin-bottom: 18px;
    color: #ffffff;
    font-size: 74px;
    line-height: 1;
  }
  .metric-card span {
    color: #bfd5d8;
    font-size: 27px;
  }
  .flow {
    display: flex;
    align-items: center;
    justify-content: center;
    margin-top: 90px;
    gap: 18px;
  }
  .flow-node {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 270px;
    height: 150px;
    padding: 20px;
    border: 2px solid #4b7c86;
    border-radius: 18px;
    background: rgba(23, 66, 78, 0.96);
    color: #f6ffff;
    font-size: 32px;
    font-weight: 700;
    text-align: center;
  }
  .flow .arrow {
    color: #72d9ce;
    font-size: 54px;
  }
  .flow-notes {
    max-width: 1120px;
    margin: 80px auto 0;
  }
  .code-grid {
    display: grid;
    grid-template-columns: 1fr 590px;
    gap: 48px;
    align-items: center;
    height: 100%;
  }
  .code-panel {
    min-height: 430px;
    margin: 0;
    padding: 44px 48px;
    border: 2px solid #426273;
    border-left: 10px solid #31b8a8;
    border-radius: 18px;
    background: rgba(7, 27, 39, 0.96);
    color: #d8f2ef;
    font-family: Consolas, "Cascadia Mono", monospace;
    font-size: 31px;
    line-height: 1.58;
    white-space: pre-wrap;
    box-shadow: 0 20px 62px rgba(0, 0, 0, 0.3);
  }
  .caption-bar {
    position: absolute;
    left: 96px;
    right: 96px;
    bottom: 48px;
    z-index: 5;
    min-height: 104px;
    padding: 21px 34px;
    border: 2px solid rgba(116, 179, 189, 0.46);
    border-radius: 14px;
    background: rgba(5, 19, 28, 0.94);
    color: #ffffff;
    font-size: 34px;
    font-weight: 650;
    line-height: 1.35;
    text-align: center;
    box-shadow: 0 16px 42px rgba(0, 0, 0, 0.22);
  }
  .accent-line {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 12px;
  }
</style>
</head>
<body>${sceneMarkup}</body>
</html>`;
}

function buildSrt() {
  let cursor = 0;
  const blocks = [];
  scenes.forEach((scene, index) => {
    const start = cursor;
    const end = cursor + scene.duration;
    blocks.push(
      `${index + 1}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${scene.caption}\n`
    );
    cursor = end;
  });
  return `${blocks.join("\n")}\n`;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      stdio: ["ignore", "pipe", "pipe"],
      ...options
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(
          new Error(
            `${path.basename(command)} failed with exit code ${code}\n${stderr.slice(
              -4000
            )}`
          )
        );
      }
    });
  });
}

async function renderFrames() {
  const { chromium } = await import(resolvePlaywrightModule());
  const browser = await chromium.launch({
    headless: true,
    executablePath: findChrome()
  });
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1
  });
  await page.setContent(buildDocument(), { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);

  for (let index = 0; index < scenes.length; index += 1) {
    const target = path.join(
      framesDirectory,
      `scene-${String(index + 1).padStart(3, "0")}.png`
    );
    await page.locator(".scene").nth(index).screenshot({ path: target });
  }

  await browser.close();
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(
      os.homedir(),
      "AppData",
      "Local",
      "ms-playwright",
      "chromium-1217",
      "chrome-win64",
      "chrome.exe"
    ),
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
  ].filter(Boolean);
  const match = candidates.find((candidate) => existsSync(candidate));
  if (!match) {
    throw new Error("Chrome or Edge was not found. Set CHROME_PATH and rerun.");
  }
  return match;
}

async function encodeVideo(ffmpeg) {
  const concatEntries = [];
  for (let index = 0; index < scenes.length; index += 1) {
    const scene = scenes[index];
    const frame = path.join(
      framesDirectory,
      `scene-${String(index + 1).padStart(3, "0")}.png`
    );
    const clip = path.join(
      clipsDirectory,
      `clip-${String(index + 1).padStart(3, "0")}.mp4`
    );
    const fade = Math.min(0.4, scene.duration / 4);
    const filter = [
      `fade=t=in:st=0:d=${fade}`,
      `fade=t=out:st=${scene.duration - fade}:d=${fade}`,
      "format=yuv420p"
    ].join(",");

    await run(ffmpeg, [
      "-y",
      "-loop",
      "1",
      "-framerate",
      "30",
      "-i",
      frame,
      "-t",
      String(scene.duration),
      "-vf",
      filter,
      "-r",
      "30",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "-an",
      clip
    ]);
    concatEntries.push(`file '${clip.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`);
  }

  const concatFile = path.join(buildDirectory, "concat.txt");
  writeFileSync(concatFile, `${concatEntries.join("\n")}\n`, "utf8");

  await run(ffmpeg, [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    concatFile,
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    finalVideo
  ]);
}

async function main() {
  const playwrightModule = resolvePlaywrightModule();
  const ffmpeg = resolveFfmpeg();
  rmSync(buildDirectory, { recursive: true, force: true });
  mkdirSync(framesDirectory, { recursive: true });
  mkdirSync(clipsDirectory, { recursive: true });

  console.log(`Playwright: ${playwrightModule}`);
  console.log(`FFmpeg: ${ffmpeg}`);
  console.log(`Scenes: ${scenes.length}`);
  console.log(`Duration: ${formatSrtTime(totalDurationSeconds())}`);

  await renderFrames();
  writeFileSync(subtitleFile, buildSrt(), "utf8");
  await encodeVideo(ffmpeg);

  const posterSource = path.join(framesDirectory, "scene-001.png");
  const poster = readFileSync(posterSource);
  writeFileSync(posterFile, poster);

  console.log(`Video: ${finalVideo}`);
  console.log(`Subtitles: ${subtitleFile}`);
  console.log(`Poster: ${posterFile}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
