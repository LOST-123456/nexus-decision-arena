#!/usr/bin/env node
// 校验 README 里提到的本地路径是否真实存在——防止文档先于实现"漂绿"。
//
// 起稿来自本地 qwen2.5:3b 的第 4 轮输出（round4.raw.mjs）。人工改了四处才跑得起来：
//   1. CommonJS → ESM：项目是 "type": "module"，require / __dirname 在 .mjs 里不存在；
//   2. 正则里的反引号多转义了一层（/\\`([^`\\n]+)\\`/ 在正则字面量里是非法序列）；
//   3. 过滤条件写反了：它把 .md 结尾的全丢了，恰好丢了最该查的那类；
//   4. 删掉了硬编码在实现里的"验收样例"（原文第 39 行直接写死 nonexistent-guide.md）——
//      样例属于测试，一旦写进实现，这个脚本就永远会红，或者永远假绿。
//
// 第 4 条是最危险的一处：它不是 bug，是模型把"我该怎么验证"当成了"我该怎么实现"。

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 只查文档类与配置类文件，避免把 `web/core/lib` 这种目录约定当成路径。
const FILE_LIKE = /\.(md|mdx|mjs|cjs|js|ts|tsx|json|ya?ml|html|css|pdf|png|svg|sh|ps1)$/i;

// 首次启动才生成的运行时产物，不在仓库里，也不算缺失。
// 这一条是跑出来的：第一次绿之前它先把 `.data/users.json` 报了红，
// 人工核对 README 第 76 行确认那是"首次启动会创建"的文件，才加的白名单。
const RUNTIME_ARTIFACT = /^\.data\//;

const readme = readFileSync(path.join(root, "README.md"), "utf8");
const candidates = [...readme.matchAll(/`([^`\n]+)`/g)].map((m) => m[1].trim());

const missing = [];
const seen = new Set();
for (const target of candidates) {
  if (!target || seen.has(target)) continue;
  seen.add(target);
  if (/^https?:\/\//i.test(target)) continue; // 外链不查
  if (/\s/.test(target)) continue; // 命令行片段不查
  if (!FILE_LIKE.test(target)) continue; // 变量名、目录名不查
  if (RUNTIME_ARTIFACT.test(target)) continue; // 运行时产物不查
  if (!existsSync(path.join(root, target))) missing.push(target);
}

if (missing.length > 0) {
  for (const target of missing) console.log(`缺失: ${target}`);
  process.exitCode = 1;
} else {
  console.log(`README 引用检查通过：${seen.size} 条去重候选，全部命中`);
}
