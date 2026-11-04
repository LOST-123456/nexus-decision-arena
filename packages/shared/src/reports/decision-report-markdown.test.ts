import { describe, expect, it } from "vitest";
import { newId } from "../ids";
import type { FinalReport } from "../domain/final-report";
import {
  decisionReportFileStem,
  renderDecisionReportMarkdown
} from "./decision-report-markdown";

function report(overrides: Partial<FinalReport> = {}): FinalReport {
  const timestamp = "2026-10-27T09:00:00.000Z";
  return {
    id: newId(),
    sessionId: newId(),
    projectName: "高校实验室 AI 危化品库存与安全预警平台",
    executiveSummary: "方向必要，证据不足。",
    initialConclusion: "建议立项",
    postChallengeConclusion: "暂缓规模化扩张",
    humanAction: "采纳关键质询",
    finalConclusion: "有限立项",
    decisionExplanation: "先在 3 间实验室验证 12 个月。",
    requiredNextActions: ["取得试点确认", "提交原型报告"],
    decisiveChallengeIds: [newId(), newId()],
    evidenceIds: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides
  };
}

describe("renderDecisionReportMarkdown", () => {
  it("renders every section the report page shows", () => {
    const markdown = renderDecisionReportMarkdown(report());

    for (const heading of [
      "## 执行摘要",
      "## 决策解释",
      "## 后续动作",
      "## 结论链",
      "## 裁决依据",
      "## 文件信息"
    ]) {
      expect(markdown).toContain(heading);
    }
  });

  it("keeps the conclusion chain, which the old client-side export dropped", () => {
    const sample = report();
    const markdown = renderDecisionReportMarkdown(sample);

    expect(markdown).toContain(`初始结论：${sample.initialConclusion}`);
    expect(markdown).toContain(`质询后结论：${sample.postChallengeConclusion}`);
    expect(markdown).toContain(`人工动作：${sample.humanAction}`);
    expect(markdown).toContain(`最终结论：${sample.finalConclusion}`);
  });

  it("counts the decision basis and lists the ids it counts", () => {
    const sample = report({ decisiveChallengeIds: [newId(), newId(), newId()] });
    const markdown = renderDecisionReportMarkdown(sample);

    expect(markdown).toContain("关键质询：3 项");
    expect(markdown).toContain("关联证据：0 项");
    for (const id of sample.decisiveChallengeIds) {
      expect(markdown).toContain(id);
    }
  });

  it("says a human decision is missing instead of printing nothing", () => {
    const markdown = renderDecisionReportMarkdown(report());
    expect(markdown).toContain("人工裁决：尚未记录");

    const withDecision = report({ humanDecisionId: newId() });
    expect(renderDecisionReportMarkdown(withDecision)).toContain(
      `人工裁决：${withDecision.humanDecisionId}`
    );
  });

  it("numbers the next actions in the order the page shows them", () => {
    const markdown = renderDecisionReportMarkdown(
      report({ requiredNextActions: ["甲", "乙", "丙"] })
    );
    expect(markdown.indexOf("1. 甲")).toBeLessThan(markdown.indexOf("2. 乙"));
    expect(markdown.indexOf("2. 乙")).toBeLessThan(markdown.indexOf("3. 丙"));
  });
});

describe("decisionReportFileStem", () => {
  it("is built from the project, so two projects never share a filename", () => {
    const a = decisionReportFileStem(report({ projectName: "项目甲" }));
    const b = decisionReportFileStem(report({ projectName: "项目乙" }));

    expect(a).not.toBe(b);
    expect(a).toContain("项目甲");
  });

  it("carries the report date, so two reports of one project differ", () => {
    const first = decisionReportFileStem(
      report({ projectName: "项目甲", updatedAt: "2026-10-01T00:00:00.000Z" })
    );
    const second = decisionReportFileStem(
      report({ projectName: "项目甲", updatedAt: "2026-10-27T00:00:00.000Z" })
    );

    expect(first).toContain("2026-10-01");
    expect(second).toContain("2026-10-27");
    expect(first).not.toBe(second);
  });

  it("strips characters a filesystem would reject", () => {
    const stem = decisionReportFileStem(
      report({ projectName: 'a/b\\c:d*e?f"g<h>i|j' })
    );
    expect(stem).toBe("a-b-c-d-e-f-g-h-i-j-决策报告-2026-10-27");
  });

  it("falls back to a usable stem when the project name is all separators", () => {
    expect(decisionReportFileStem(report({ projectName: "///" }))).toBe(
      "decision-决策报告-2026-10-27"
    );
  });
});
