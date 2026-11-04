"use client";

import { useEffect, useRef, useState } from "react";

/**
 * 五个字段里，只有"项目名称"是人人都会填的；后面四栏是评审能不能问出东西
 * 的前提。新用户卡在这里不是不会打字，是不知道该写到什么颗粒度。
 *
 * 所以这里给的不是"请详细描述"这种废话，而是可以整段复制、再改几个词的骨架：
 * 照抄能提交，改两处就变成自己的项目。提示只在项目名称有内容后出现——还没想好
 * 做什么项目的人，先看到的应该是名称那一栏。
 */

type HintField = {
  key: "summary" | "targetUsers" | "businessModel" | "expectedData";
  label: string;
  /** 这一栏为什么存在——评审会拿它做什么，而不是"请详细填写"。 */
  why: string;
  template(projectName: string): string;
};

const HINTS: readonly HintField[] = [
  {
    key: "summary",
    label: "项目简介",
    why: "说清三件事：谁的问题、你的做法、凭什么比现有做法好。两到四句，写具体场景，不写愿景口号。",
    template: (name) =>
      `${name || "这个项目"}面向<谁>，解决<什么具体问题>。做法是<怎么做>，与现有做法相比<差异点>。`
  },
  {
    key: "targetUsers",
    label: "目标用户",
    why: "使用者和付费者分开写。评审一定会追问：谁掏钱、谁签字、谁会反对。",
    template: () =>
      "使用者：<每天用它的人>；付费方：<真正出钱的人或单位>；决策方：<最后签字的人>。"
  },
  {
    key: "businessModel",
    label: "商业模式",
    why: "收入从哪来、按什么计价、多久收一次。只写「抽佣」不够，要写比例和基数。",
    template: () =>
      "收入来源：<抽佣 / 订阅 / 服务费>；计价方式：<按成交额 X% / 每班每年 X 元>；结算周期：<月结 / 季结>。"
  },
  {
    key: "expectedData",
    label: "预期数据与目标",
    why: "写清周期、规模、收入和毛利，并说明数字怎么算出来的。没有把握的写区间并注明假设——系统会把它当作待核验假设，这正是评审要审的地方。",
    template: () =>
      "12 个月内覆盖 <N> 家客户，月活 <N>，营收 <N> 万元，毛利率 <N>%；测算依据是<关键假设>。"
  }
];

export type BriefTemplates = Record<HintField["key"], string>;

export function buildBriefTemplates(projectName: string): BriefTemplates {
  return {
    summary: HINTS[0]!.template(projectName),
    targetUsers: HINTS[1]!.template(projectName),
    businessModel: HINTS[2]!.template(projectName),
    expectedData: HINTS[3]!.template(projectName)
  };
}

export function ProjectBriefHints({
  projectName,
  onFillEmpty
}: {
  projectName: string;
  /** 只填还空着的栏，已经动笔的内容一个字都不覆盖。 */
  onFillEmpty(templates: BriefTemplates): void;
}) {
  const [open, setOpen] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  // 名称还没写，说明用户还在想"做什么"；这时候把四栏提示推到他眼前只是噪音。
  if (projectName.trim().length < 2) {
    return null;
  }

  const templates = buildBriefTemplates(projectName.trim());

  async function copy(key: string, text: string): Promise<void> {
    const ok = await writeToClipboard(text);
    if (!ok) {
      return;
    }
    setCopied(key);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(null), 1800);
  }

  return (
    <section className="brief-hints" aria-label="填写提示">
      <div className="brief-hints-head">
        <p className="eyebrow">HOW TO FILL THIS IN</p>
        <button
          type="button"
          className="brief-hints-toggle"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          {open ? "收起提示" : "看看怎么写"}
        </button>
      </div>

      <p className="brief-hints-lede">
        下面四栏决定评审能问出什么。照着骨架改两处就能提交，改得越具体，
        后面质询问得越准。
      </p>

      {open ? (
        <>
          {HINTS.map((hint) => (
            <div className="brief-hint" key={hint.key}>
              <div className="brief-hint-head">
                <strong>{hint.label}</strong>
                <button
                  type="button"
                  className="brief-hint-copy"
                  onClick={() => void copy(hint.key, templates[hint.key])}
                  aria-label={`复制${hint.label}模板`}
                >
                  {copied === hint.key ? "已复制" : "复制模板"}
                </button>
              </div>
              <p className="brief-hint-why">{hint.why}</p>
              <code className="brief-hint-template">{templates[hint.key]}</code>
            </div>
          ))}

          <div className="brief-hints-actions">
            <button
              type="button"
              className="brief-hints-fill"
              onClick={() => onFillEmpty(templates)}
            >
              把模板填进空着的栏
            </button>
            <button
              type="button"
              className="brief-hints-copy-all"
              onClick={() =>
                void copy(
                  "__all__",
                  HINTS.map(
                    (hint) => `${hint.label}\n${templates[hint.key]}`
                  ).join("\n\n")
                )
              }
            >
              {copied === "__all__" ? "已复制全部" : "复制全部四栏"}
            </button>
          </div>
          <p className="brief-hints-foot">
            栏里的 &lt; &gt; 是给你替换的内容，不是格式要求。已经写过的栏不会被覆盖。
          </p>
        </>
      ) : null}
    </section>
  );
}

/**
 * 复制到剪贴板。
 *
 * `navigator.clipboard` 只在安全上下文里有；局域网 http 打开时它是
 * undefined。老实的做法是返回 false，让按钮保持不变而不是假装复制成功——
 * 用户点了"复制"却粘贴不出东西，比按钮没反应更让人怀疑自己。
 */
async function writeToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 落到下面的兜底路径
    }
  }
  if (typeof document === "undefined") {
    return false;
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}
