import { describe, expect, it } from "vitest";
import { newId } from "../ids";
import { computeReportEvidenceCoverage } from "./evidence-coverage";

const CLAIM_A = newId();
const CLAIM_B = newId();

function claim(id: string, evidenceIds: string[] = []) {
  return { id, evidenceIds };
}

function evidence(overrides: {
  claimIds: string[];
  verificationStatus?: "unverified" | "verified" | "rejected";
  direction?: "supports" | "opposes" | "context";
  kind?: "project_input" | "calculation" | "external_reference" | "assumption";
}) {
  return {
    claimIds: overrides.claimIds,
    verificationStatus: overrides.verificationStatus ?? "unverified",
    direction: overrides.direction ?? "supports",
    kind: overrides.kind ?? "external_reference"
  };
}

/**
 * 这几条规则的作用是同一个：让"报告说已核实"这件事没法被悄悄伪造。
 */
describe("computeReportEvidenceCoverage", () => {
  it("一条已核实支撑证据都没有时，level 是证据不足", () => {
    const coverage = computeReportEvidenceCoverage(
      [claim(CLAIM_A, ["e1"]), claim(CLAIM_B, ["e2"])],
      [evidence({ claimIds: [CLAIM_A] })]
    );

    expect(coverage.level).toBe("unverified");
    expect(coverage.claimsWithoutVerifiedEvidence).toBe(2);
    expect(coverage.coverageRatio).toBe(0);
  });

  it("部分主张有已核实证据时是部分核实，不是已核实", () => {
    const coverage = computeReportEvidenceCoverage(
      [claim(CLAIM_A, ["e1"]), claim(CLAIM_B, ["e2"])],
      [
        evidence({ claimIds: [CLAIM_A], verificationStatus: "verified" }),
        evidence({ claimIds: [CLAIM_B] })
      ]
    );

    expect(coverage.level).toBe("partial");
    expect(coverage.claimsWithoutVerifiedEvidence).toBe(1);
    expect(coverage.coverageRatio).toBe(0.5);
  });

  it("只有全部主张都有已核实证据，才配叫已核实", () => {
    const coverage = computeReportEvidenceCoverage(
      [claim(CLAIM_A, ["e1"])],
      [evidence({ claimIds: [CLAIM_A], verificationStatus: "verified" })]
    );

    expect(coverage.level).toBe("verified");
    expect(coverage.coverageRatio).toBe(1);
    expect(coverage.usage).toContain("可以作为决策依据");
  });

  it("背景材料不构成支撑——context 不等于已核实", () => {
    const coverage = computeReportEvidenceCoverage(
      [claim(CLAIM_A, ["e1"])],
      [
        evidence({
          claimIds: [CLAIM_A],
          verificationStatus: "verified",
          direction: "context"
        })
      ]
    );

    expect(coverage.level).toBe("unverified");
  });

  it("反证也不构成支撑", () => {
    const coverage = computeReportEvidenceCoverage(
      [claim(CLAIM_A, ["e1"])],
      [
        evidence({
          claimIds: [CLAIM_A],
          verificationStatus: "verified",
          direction: "opposes"
        })
      ]
    );

    expect(coverage.level).toBe("unverified");
  });

  it("假设型证据永远不算已核实，即便库里写着 verified", () => {
    // schema 已经禁止这种状态，这里再挡一次：这条规则不能只靠一个地方守。
    const coverage = computeReportEvidenceCoverage(
      [claim(CLAIM_A, ["e1"])],
      [
        evidence({
          claimIds: [CLAIM_A],
          verificationStatus: "verified",
          kind: "assumption"
        })
      ]
    );

    expect(coverage.level).toBe("unverified");
  });

  it("被驳回的证据不算，但会计入证据总数", () => {
    const coverage = computeReportEvidenceCoverage(
      [claim(CLAIM_A, ["e1"])],
      [evidence({ claimIds: [CLAIM_A], verificationStatus: "rejected" })]
    );

    expect(coverage.totalEvidence).toBe(1);
    expect(coverage.verifiedEvidence).toBe(0);
    expect(coverage.level).toBe("unverified");
  });

  it("没有主张时分母为 0，不返回 100%", () => {
    const coverage = computeReportEvidenceCoverage([], []);

    expect(coverage.totalClaims).toBe(0);
    expect(coverage.coverageRatio).toBeNull();
    expect(coverage.level).toBe("unverified");
    expect(coverage.statement).toContain("没有记录任何主张");
  });

  it("statement 里同时给出主张数与证据数，读的人不必自己算", () => {
    const coverage = computeReportEvidenceCoverage(
      [claim(CLAIM_A, ["e1"]), claim(CLAIM_B, ["e2"])],
      [evidence({ claimIds: [CLAIM_A], verificationStatus: "verified" })]
    );

    expect(coverage.statement).toContain("2 条主张");
    expect(coverage.statement).toContain("1 条没有任何已核实证据");
    expect(coverage.statement).toContain("1 条已核实");
  });
});
