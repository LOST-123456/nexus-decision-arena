import { coverageLevelLabel, type ReportEvidenceCoverage } from "@nexus/shared";

/**
 * 证据覆盖率横幅。
 *
 * 产品最不能出的错，是让人以为 AI 说过的话已经被核实过。这条横幅的作用不是
 * 免责，而是把"这轮结论背后到底有多少已核实证据"放在最显眼的位置，并说明
 * 该怎么用它——只给数字不解释，读者会当成噪音划过去。
 */
export function ReportCoverageNotice({
  coverage
}: {
  coverage: ReportEvidenceCoverage;
}) {
  const ratio =
    coverage.coverageRatio === null
      ? null
      : Math.round(coverage.coverageRatio * 100);
  return (
    <section
      className={`report-coverage report-coverage-${coverage.level}`}
      aria-label="证据覆盖率"
    >
      <div className="report-coverage-head">
        <span className="report-coverage-level">
          {coverageLevelLabel(coverage.level)}
        </span>
        <span className="report-coverage-ratio">
          {ratio === null ? "无主张可统计" : `已核实主张 ${ratio}%`}
        </span>
      </div>
      <p className="report-coverage-statement">{coverage.statement}</p>
      <p className="report-coverage-usage">{coverage.usage}</p>
    </section>
  );
}
