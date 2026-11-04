import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { computeReportEvidenceCoverage } from "@nexus/shared";
import { ReportCoverageNotice } from "./report-coverage-notice";

afterEach(cleanup);

const CLAIM_ID = "00000000-0000-7000-8000-0000000000c1";
const EVIDENCE_ID = "00000000-0000-7000-8000-0000000000e1";

function coverageFor(
  input: {
    verificationStatus?: "verified" | "unverified" | "rejected";
    direction?: "supports" | "opposes" | "context";
    kind?: "external_reference" | "assumption";
  },
  options: { claims?: number } = {}
) {
  const claims = Array.from({ length: options.claims ?? 1 }, (_, index) => ({
    id: index === 0 ? CLAIM_ID : `${CLAIM_ID}${index}`,
    evidenceIds: [EVIDENCE_ID]
  }));
  return computeReportEvidenceCoverage(claims, [
    {
      claimIds: [CLAIM_ID],
      verificationStatus: input.verificationStatus ?? "verified",
      direction: input.direction ?? "supports",
      kind: input.kind ?? "external_reference"
    }
  ]);
}

/**
 * 这条横幅唯一的职责，是让人一眼看出"我手上这份结论核过没有"。
 * 所以测试盯的是三件事：等级写没写对、百分比算没算对、以及措辞有没有
 * 把"建议"说成"结果"。
 */
describe("ReportCoverageNotice", () => {
  it("全部核实时给出等级与占比，不是一句免责声明", () => {
    render(<ReportCoverageNotice coverage={coverageFor({})} />);

    const notice = screen.getByLabelText("证据覆盖率");
    expect(notice.className).toContain("report-coverage-verified");
    expect(notice.textContent).toContain("已核实");
    expect(notice.textContent).toContain("已核实主张 100%");
  });

  it("证据未核实时刻意不显示成 100%", () => {
    render(
      <ReportCoverageNotice
        coverage={coverageFor({ verificationStatus: "unverified" })}
      />
    );

    const notice = screen.getByLabelText("证据覆盖率");
    expect(notice.className).toContain("report-coverage-unverified");
    expect(notice.textContent).toContain("证据不足");
    expect(notice.textContent).toContain("已核实主张 0%");
  });

  it("反证与背景材料都不计入已核实", () => {
    // 有证据 ≠ 有支撑。这两个边界如果漏了，报告会显得比实际更可靠。
    const opposes = render(
      <ReportCoverageNotice coverage={coverageFor({ direction: "opposes" })} />
    );
    expect(screen.getByLabelText("证据覆盖率").textContent).toContain(
      "证据不足"
    );
    opposes.unmount();

    render(
      <ReportCoverageNotice coverage={coverageFor({ direction: "context" })} />
    );
    expect(screen.getByLabelText("证据覆盖率").textContent).toContain(
      "证据不足"
    );
  });

  it("部分核实单独成一档，不归到'证据不足'也不归到'已核实'", () => {
    const claims = [
      { id: CLAIM_ID, evidenceIds: [EVIDENCE_ID] },
      { id: `${CLAIM_ID}-2`, evidenceIds: [] }
    ];
    render(
      <ReportCoverageNotice
        coverage={computeReportEvidenceCoverage(claims, [
          {
            claimIds: [CLAIM_ID],
            verificationStatus: "verified",
            direction: "supports",
            kind: "external_reference"
          }
        ])}
      />
    );

    const notice = screen.getByLabelText("证据覆盖率");
    expect(notice.className).toContain("report-coverage-partial");
    expect(notice.textContent).toContain("部分核实");
    expect(notice.textContent).toContain("已核实主张 50%");
  });

  it("没有主张时说明无主张可统计，而不是给出 0% 或 100%", () => {
    // 分母为 0 时写"100% 已核实"是这类面板最容易犯的错。
    render(
      <ReportCoverageNotice coverage={computeReportEvidenceCoverage([], [])} />
    );

    const notice = screen.getByLabelText("证据覆盖率");
    expect(notice.textContent).toContain("无主张可统计");
    expect(notice.textContent).not.toContain("%");
  });

  it("同时给出缺口数字和该怎么用", () => {
    render(
      <ReportCoverageNotice
        coverage={coverageFor({ verificationStatus: "unverified" })}
      />
    );

    const notice = screen.getByLabelText("证据覆盖率");
    expect(notice.querySelector(".report-coverage-statement")?.textContent).toContain(
      "1 条主张"
    );
    // 只给数字不解释，读者会当成噪音划过去。
    expect(notice.querySelector(".report-coverage-usage")?.textContent).toContain(
      "不是已经核实的结果"
    );
  });
});
