import { describe, expect, it } from "vitest";
import {
  claimStatusLabel,
  directionLabel,
  pendingVerificationLabel,
  verificationLabel,
  verdictLabel,
  workflowLabel
} from "./labels";

describe("research labels", () => {
  it("keeps the panel's accepted/rejected wording away from true/false", () => {
    expect(claimStatusLabel("accepted")).toContain("内部结论");
    expect(claimStatusLabel("rejected")).toContain("内部结论");
    expect(claimStatusLabel("accepted")).not.toBe("成立");
    expect(claimStatusLabel("rejected")).not.toBe("不成立");
    expect(claimStatusLabel("accepted")).not.toBe("true");
    expect(claimStatusLabel("rejected")).not.toBe("false");
  });

  it("distinguishes evidence verification from the fact-check verdict", () => {
    expect(verificationLabel("verified")).toBe("已核实");
    expect(verdictLabel("supported")).toContain("支持证据");
    expect(verificationLabel("verified")).not.toBe(verdictLabel("supported"));
  });

  it("names doubt explicitly instead of implying a conclusion", () => {
    expect(verdictLabel("insufficient_evidence")).toContain("未下结论");
    expect(verdictLabel("unsupported")).toContain("无");
    expect(verdictLabel("mixed_evidence")).toContain("冲突");
  });

  it("labels evidence direction", () => {
    expect(directionLabel("supports")).toBe("支持");
    expect(directionLabel("opposes")).toBe("反对");
    expect(directionLabel("context")).toBe("背景");
  });

  it("maps workflow phases to progress wording", () => {
    expect(workflowLabel("HUMAN_REVIEW")).toBe("待人工裁定");
    expect(workflowLabel("REPORT_READY")).toBe("报告已生成");
    expect(workflowLabel("CREATED")).toBe("待启动");
  });

  it("describes the verification backlog", () => {
    expect(pendingVerificationLabel(0)).toBe("无待核实材料");
    expect(pendingVerificationLabel(3)).toBe("3 条待核实");
  });
});
