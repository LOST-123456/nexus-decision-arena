// 从 WorkBuddy 会话 jsonl 导出可读的对话记录（docs/ai-history/0018–0028 由此生成）。
//
// 用法（在仓库根执行）：
//   node scripts/export-workbuddy-history.mjs <会话.jsonl> --stats-only
//   node scripts/export-workbuddy-history.mjs <会话.jsonl> --split-by week
//
// 做什么：逐行读 JSONL，只取 type=message 的 user/assistant 消息，剥离每轮自动注入的
// 工作区上下文、记忆块、任务通知与压缩摘要，丢弃机器生成的续接语和过短的过渡回复，
// 其余逐字保留；按周切分，单周超过 800 KB 时再按天切，保证每份都能在网页端渲染。
//
// 编号连续（默认从 0018 起），便于跨文件引用。
import { createReadStream, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [input, ...flags] = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = flags.indexOf(name);
  return i >= 0 && flags[i + 1] ? flags[i + 1] : fallback;
};
const outPath = arg("--out", null);
const minAssistant = Number(arg("--min-assistant", "60"));
const maxAssistant = Number(arg("--max-assistant", "6000"));
const statsOnly = flags.includes("--stats-only");

const BLOCK_TAGS = [
  "system-reminder",
  "user-context",
  "team-project-context",
  "project-file-rules",
  "additional-data",
  "current_time",
  "memory",
  "identity_context",
  "available_deferred_tools",
  "wecom_routing",
  "user_info",
  "workspace_memory",
  "project_context",
  // 后台任务完成通知与压缩摘要都是机器注入，不是人说的话。
  "task-notification",
  "conversation_history_summary",
  "compact-summary"
];

/** 只去掉包装、保留内容的标签。 */
const UNWRAP_TAGS = ["long_text_quote", "user_query"];

/**
 * 机器生成的「用户轮」：工具轮询提示、压缩后的自动续接指令。它们占据 user 角色，
 * 但一个字都不是人写的，留在导出里会把真实提问冲淡。
 */
const NOISE_PATTERNS = [
  /^Use the TaskOutput tool with task_id=/,
  /^Please continue with the conversation based on the summarized context above/,
  /^This session is being continued from a previous conversation/,
  /^请基于上面总结的上下文继续/,
  /^Continue from where you left off\.?$/i
];

function isNoise(text) {
  const head = text.slice(0, 200).trim();
  return NOISE_PATTERNS.some((re) => re.test(head));
}

function stripBlocks(text) {
  let out = text;
  for (let round = 0; round < 6; round += 1) {
    const before = out;
    for (const tag of BLOCK_TAGS) {
      out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "gi"), "");
      out = out.replace(new RegExp(`<${tag}\\b[^>]*/>`, "gi"), "");
    }
    if (out === before) break;
  }
  return out;
}

function clean(text) {
  let body = stripBlocks(text);
  for (const tag of UNWRAP_TAGS) {
    body = body.replace(new RegExp(`</?${tag}\\b[^>]*>`, "gi"), "");
  }
  return body.replace(/\r/g, "").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}

function parts(record) {
  const content = record.content;
  if (Array.isArray(content)) return content;
  if (typeof content === "string") return [{ type: "input_text", text: content }];
  return [];
}

const rl = createInterface({
  input: createReadStream(input, { encoding: "utf8" }),
  crlfDelay: Infinity
});

const messages = [];
let rawUser = 0;
let rawAssistant = 0;
let droppedUser = 0;
let droppedAssistant = 0;

for await (const line of rl) {
  if (!line.includes('"type":"message"')) continue;
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    continue;
  }
  if (record.type !== "message") continue;
  const text = parts(record)
    .filter((p) => p.type === "input_text" || p.type === "output_text" || p.type === "text")
    .map((p) => p.text ?? "")
    .join("\n");
  if (!text) continue;

  if (record.role === "user") {
    rawUser += 1;
    const body = clean(text);
    if (!body || isNoise(body)) {
      droppedUser += 1;
      continue;
    }
    messages.push({ role: "USER", at: record.timestamp, text: body });
  } else if (record.role === "assistant") {
    rawAssistant += 1;
    const body = clean(text);
    if (body.length < minAssistant) {
      droppedAssistant += 1;
      continue;
    }
    messages.push({ role: "AI", at: record.timestamp, text: body });
  }
}

const totalChars = messages.reduce((sum, m) => sum + m.text.length, 0);
const fmt = (ts) => new Date(ts).toISOString().replace("T", " ").slice(0, 19);

console.log(`用户消息: ${rawUser} 条（清洗后为空 ${droppedUser} 条，保留 ${messages.filter((m) => m.role === "USER").length}）`);
console.log(`AI 消息: ${rawAssistant} 条（短于 ${minAssistant} 字丢弃 ${droppedAssistant} 条，保留 ${messages.filter((m) => m.role === "AI").length}）`);
console.log(`合计保留 ${messages.length} 条，${totalChars} 字（约 ${(totalChars / 1024 / 1024).toFixed(2)} MB）`);
if (messages.length) {
  console.log(`时间范围: ${fmt(messages[0].at)} → ${fmt(messages[messages.length - 1].at)}`);
}

function render(chunk, heading, startIndex) {
  const lines = [
    `# WorkBuddy 会话导出 · ${heading}`,
    "",
    "> 来源：本机 WorkBuddy 会话记录 `688cb247-1034-4c70-92f7-c4dce1737480.jsonl`",
    `> 时间范围：${fmt(chunk[0].at)} → ${fmt(chunk[chunk.length - 1].at)}（UTC）`,
    `> 条目：USER ${chunk.filter((m) => m.role === "USER").length} 条，AI ${chunk.filter((m) => m.role === "AI").length} 条`,
    ">",
    "> 本文件由 `scripts/export-workbuddy-history.mjs` 从原始 JSONL 逐行解析生成：剥离每轮自动注入的",
    "> 工作区上下文、记忆块与系统提醒，丢弃纯过渡语（短于阈值的 AI 回复），其余逐字保留。",
    "> 编号在整段会话内连续，便于跨文件引用。",
    "",
    "---",
    ""
  ];
  let index = startIndex;
  for (const m of chunk) {
    index += 1;
    const body =
      m.text.length > maxAssistant
        ? `${m.text.slice(0, maxAssistant)}\n\n……（本条过长，此处截断，原文 ${m.text.length} 字）`
        : m.text;
    lines.push(`## ${index}. ${m.role} — ${fmt(m.at)}`, "", body, "");
  }
  return lines.join("\n");
}

if (!statsOnly) {
  const splitBy = arg("--split-by", null);
  const isoWeek = (ts) => {
    const d = new Date(ts);
    const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const dayNum = day.getUTCDay() || 7;
    day.setUTCDate(day.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((day - yearStart) / 86400000 + 1) / 7);
    return `${day.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
  };
  const keyOf = splitBy === "month"
    ? (ts) => new Date(ts).toISOString().slice(0, 7)
    : (ts) => isoWeek(ts);

  if (splitBy === "month" || splitBy === "week") {
    const groups = new Map();
    for (const m of messages) {
      const key = keyOf(m.at);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(m);
    }
    const sizeOf = (chunk) => chunk.reduce((s, m) => s + m.text.length, 0);
    const LIMIT = 800 * 1024;
    let seq = Number(arg("--start-index", "18"));
    let running = 0;
    const emit = (chunk, key) => {
      const file = `docs/ai-history/${String(seq).padStart(4, "0")}-workbuddy-${key}.md`;
      writeFileSync(file, render(chunk, key, running), "utf8");
      running += chunk.length;
      seq += 1;
      console.log(`写出 ${file}（${chunk.length} 条，${(sizeOf(chunk) / 1024).toFixed(0)} KB 正文）`);
    };
    for (const [key, chunk] of groups) {
      if (sizeOf(chunk) <= LIMIT) {
        emit(chunk, key);
        continue;
      }
      // 单周仍然过大：按天再切一层，保证每份都能在网页端渲染。
      const byDay = new Map();
      for (const m of chunk) {
        const day = new Date(m.at).toISOString().slice(0, 10);
        if (!byDay.has(day)) byDay.set(day, []);
        byDay.get(day).push(m);
      }
      for (const [day, sub] of byDay) emit(sub, day);
    }
  } else if (outPath) {
    writeFileSync(outPath, render(messages, "全段", 0), "utf8");
    console.log(`已写出 ${outPath}`);
  }
}
