import { describe, expect, it } from "vitest";
import { assessTranslationFidelity } from "./translation-fidelity-service";

const assess = (original: string, translated: string) =>
  assessTranslationFidelity({
    translationId: "00000000-0000-7000-8000-000000000000",
    original,
    translated,
    now: "2026-10-14T00:00:00.000Z"
  });

const riskTypes = (original: string, translated: string) =>
  assess(original, translated).findings.map((f) => f.riskType);

describe("assessTranslationFidelity", () => {
  it("flags a direction conflict when a decrease becomes an increase", () => {
    expect(riskTypes("Revenue decreased by 12%.", "收入增长了 12%。")).toContain(
      "direction-conflict"
    );
  });

  it("flags a flipped negation", () => {
    expect(
      riskTypes("Not all participants agreed.", "所有参与者都同意。")
    ).toContain("negation-changed");
  });

  it("flags a certainty shift when a hedge disappears", () => {
    expect(
      riskTypes("The treatment may improve outcomes.", "该治疗能够改善结果。")
    ).toContain("certainty-shift");
  });

  it("flags a changed date", () => {
    expect(riskTypes("The report was published in 2021.", "该报告发布于 2023 年。")).toContain(
      "date-changed"
    );
  });

  it("flags a changed unit", () => {
    expect(riskTypes("The parcel weighs 5 kg.", "包裹重 5 公里。")).toContain(
      "unit-changed"
    );
  });

  it("flags a number that vanished", () => {
    expect(riskTypes("It cost 250 dollars.", "这花了钱。")).toContain("none");
  });

  it("produces no findings for a faithful translation", () => {
    expect(riskTypes("Revenue decreased by 12%.", "收入下降了 12%。")).toEqual([]);
  });

  it("marks every finding as a heuristic suggestion, never a proven error", () => {
    const assessment = assess("Revenue decreased by 12%.", "收入增长了 12%。");
    expect(assessment.method).toBe("rule-based");
    expect(assessment.findings.length).toBeGreaterThan(0);
    for (const finding of assessment.findings) {
      expect(finding.heuristic).toBe(true);
      expect(finding.reviewStatus).toBe("pending");
      expect(finding.basis.length).toBeGreaterThan(0);
    }
  });
});
