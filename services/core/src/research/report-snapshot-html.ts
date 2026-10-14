import type { FactCheckReport } from "./fact-check-report";
import type { ResearchReportSnapshot } from "@nexus/shared";
import { languageCodeLabel } from "@nexus/shared";

/**
 * A print-friendly, self-contained rendering of one saved version.
 *
 * Everything on the page comes from the frozen payload and the version's
 * own metadata: no query runs while an export is being built, so the
 * document cannot absorb material that arrived after the save. All text
 * that originated from a page or a file — excerpts, titles, locators —
 * passes through `escapeHtml`, because it is untrusted data being placed
 * into a document.
 */
export function renderSnapshotHtml(
  snapshot: ResearchReportSnapshot,
  report: FactCheckReport
): string {
  const sections: string[] = [];

  sections.push(`
  <section class="meta">
    <h1>事实核查报告 · 版本 v${snapshot.version}</h1>
    <dl>
      <div><dt>快照 ID</dt><dd><code>${escapeHtml(snapshot.snapshotId)}</code></dd></div>
      <div><dt>保存时间</dt><dd>${escapeHtml(snapshot.createdAt)}</dd></div>
      <div><dt>保存人</dt><dd>${escapeHtml(snapshot.createdBy)}</dd></div>
      <div><dt>材料指纹</dt><dd><code>${escapeHtml(snapshot.materialsFingerprint)}</code></dd></div>
      <div><dt>快照哈希</dt><dd><code>${escapeHtml(snapshot.snapshotHash)}</code></dd></div>
      <div><dt>变更原因</dt><dd>${escapeHtml(snapshot.changeReason ?? "（未填写）")}</dd></div>
      <div><dt>报告生成时间</dt><dd>${escapeHtml(report.generatedAt)}</dd></div>
    </dl>
    <p class="note">本导出内容来自该版本的不可变快照，不包含保存之后的任何变更。</p>
  </section>`);

  sections.push(`
  <section>
    <h2>研究问题</h2>
    <p class="question">${escapeHtml(report.researchQuestion ?? "（未填写研究问题）")}</p>
    <p class="muted">核查范围：主张 ${report.scope.claims} 条 · 材料 ${report.scope.evidence} 条 · 来源 ${report.scope.sources} 个 · 质询 ${report.scope.challenges} 项 · 人工裁定 ${report.scope.reviews} 条</p>
  </section>`);

  const verdictRows = Object.entries(report.summary.byStatus)
    .filter(([, count]) => count > 0)
    .map(
      ([status, count]) =>
        `<tr><th scope="row">${escapeHtml(status)}</th><td>${count}</td></tr>`
    )
    .join("");
  sections.push(`
  <section>
    <h2>结论概览</h2>
    <table>
      <caption>各结论状态的主张数</caption>
      <thead><tr><th scope="col">结论状态</th><th scope="col">主张数</th></tr></thead>
      <tbody>${verdictRows || '<tr><td colspan="2">尚无结论。</td></tr>'}</tbody>
    </table>
    <p class="muted">待跟进结论 ${report.summary.openVerdicts} 项 · 已核实材料 ${report.summary.verified} 条 · 未核实 ${report.summary.unverified} 条 · 已否证 ${report.summary.rejected} 条</p>
  </section>`);

  for (const finding of report.findings) {
    const citations = (
      label: string,
      items: FactCheckReport["findings"][number]["supporting"]
    ): string =>
      items.length === 0
        ? ""
        : `<h4>${escapeHtml(label)}（${items.length}）</h4>` +
          items
            .map(
              (citation) => `
        <blockquote>
          <p>${escapeHtml(citation.excerpt)}</p>
          <footer>
            ${escapeHtml(citation.title)} · 核实状态 ${escapeHtml(citation.verificationStatus)} · 可靠度 ${citation.reliability.toFixed(2)}
            ${citation.source ? ` · 来源 ${escapeHtml(citation.source.title)}` : " · 未登记来源"}
            ${citation.locator ? ` · 定位 ${escapeHtml(citation.locator)}` : ""}
            ${citation.verifiedBy ? ` · 核实人 ${escapeHtml(citation.verifiedBy)}` : ""}
          </footer>
        </blockquote>`
            )
            .join("");

    sections.push(`
  <section class="finding">
    <h3>${escapeHtml(finding.statement)}</h3>
    <p class="muted">主张状态 ${escapeHtml(finding.claimStatus)} · 结论 ${escapeHtml(finding.verdict.status)} · 把握度 ${Math.round(finding.verdict.confidence * 100)}% · 重要性 ${finding.importance}</p>
    <p>${escapeHtml(finding.verdict.rationale)}</p>
    ${
      finding.review
        ? `<p class="review">人工裁定：${escapeHtml(finding.review.outcome)} — ${escapeHtml(finding.review.rationale)}（${escapeHtml(finding.review.reviewer)}）</p>`
        : ""
    }
    ${citations("支持证据", finding.supporting)}
    ${citations("反对证据", finding.opposing)}
    ${citations("背景材料", finding.context)}
    ${citations("未参与结论的材料", finding.excluded)}
  </section>`);
  }

  if (report.revalidation) {
    const warnings = report.revalidation;
    const changed = warnings.changedSources
      .map(
        (source) =>
          `<li>${escapeHtml(source.title)}（检查于 ${escapeHtml(source.checkedAt)}，当前版本 ${escapeHtml(source.currentContentHash.slice(0, 12))}…）</li>`
      )
      .join("");
    const reconfirm = warnings.evidenceNeedingReconfirmation
      .map(
        (item) =>
          `<li>${escapeHtml(item.title)}：${escapeHtml(item.reason)}</li>`
      )
      .join("");
    const affected = warnings.affectedClaims
      .map((claim) => `<li>${escapeHtml(claim.statement)}</li>`)
      .join("");
    sections.push(`
  <section class="risk">
    <h2>来源监测与重新核查</h2>
    <p class="muted">待处理复核任务 ${warnings.openTaskCount} 项 · 复核中 ${warnings.inReviewTaskCount} 项 · 最近一次检查 ${escapeHtml(warnings.lastCheckedAt ?? "未记录")}</p>
    ${changed ? `<h4>已发生内容变化的来源</h4><ul>${changed}</ul>` : ""}
    ${reconfirm ? `<h4>需要再次确认的材料</h4><ul>${reconfirm}</ul>` : ""}
    ${affected ? `<h4>可能受影响、建议重新核查的主张</h4><ul>${affected}</ul>` : ""}
    <h4>报告所用来源版本</h4>
    <ul>${warnings.sourceVersions
      .map(
        (version) =>
          `<li>${escapeHtml(version.title)}：${version.contentHash ? escapeHtml(version.contentHash.slice(0, 12)) + "…" : "无已保存版本"}</li>`
      )
      .join("")}</ul>
    <p class="note">以上变化不改变本报告任何结论：推导结论只依据已核实材料，重新核查的结论由人工在工作台记录。</p>
  </section>`);
  }

  // The frozen research quality assessment. Rendered from the payload this
  // version was saved with — never recomputed — so a historical export shows
  // the quality reading of its own moment.
  if (report.researchQuality) {
    const quality = report.researchQuality;
    const dimensionRows = quality.dimensions
      .map((dimension) => {
        const score =
          dimension.score === null
            ? "无法计算"
            : `${dimension.score} / 100`;
        return `<tr><th scope="row">${escapeHtml(dimension.id)}</th><td>${escapeHtml(score)}</td><td>${dimension.weight}%</td><td>${escapeHtml(dimension.status)}</td></tr>`;
      })
      .join("");
    const findings = quality.findings
      .map(
        (finding) =>
          `<li>[${escapeHtml(finding.severity)}] ${escapeHtml(finding.category)}（${escapeHtml(finding.scope)} · <code>${escapeHtml(finding.entityId)}</code>）：${escapeHtml(finding.reason)}</li>`
      )
      .join("");
    const recommendations = quality.recommendations
      .map(
        (recommendation) =>
          `<li>${escapeHtml(recommendation.title)}：${escapeHtml(recommendation.detail)}</li>`
      )
      .join("");
    const qualityLimits = quality.limitations
      .map((limitation) => `<li>${escapeHtml(limitation)}</li>`)
      .join("");
    sections.push(`
  <section class="risk">
    <h2>研究质量评估</h2>
    <p class="muted">评估时间 ${escapeHtml(quality.assessedAt)} · 规则版本 ${escapeHtml(quality.ruleVersion)} · 材料范围指纹 <code>${escapeHtml(quality.inputFingerprint)}</code></p>
    <p>${
      quality.overall.score === null
        ? "综合评分无法计算：可计算权重不足总权重的一半，或没有任何维度可计算。"
        : `综合评分 <strong>${quality.overall.score} / 100</strong>（覆盖权重 ${Math.round(quality.overall.coverage * 100)}%，${quality.overall.assessedDimensions}/6 个维度参与），状态 ${escapeHtml(quality.overall.status)}。`
    }</p>
    <p>${escapeHtml(quality.overall.explanation)}</p>
    <table>
      <caption>六个维度（分数为 null 表示数据不足，从未按 0 分计）</caption>
      <thead><tr><th scope="col">维度</th><th scope="col">分数</th><th scope="col">权重</th><th scope="col">状态</th></tr></thead>
      <tbody>${dimensionRows}</tbody>
    </table>
    <h4>质量问题（${quality.findings.length}）</h4>
    ${findings ? `<ul>${findings}</ul>` : "<p class=\"muted\">未发现规则命中项。</p>"}
    ${recommendations ? `<h4>改进建议</h4><ul>${recommendations}</ul>` : ""}
    ${qualityLimits ? `<h4>评估局限</h4><ul>${qualityLimits}</ul>` : ""}
    <p class="note">质量分数不是结论正确的概率：它只描述材料对结论的支持程度，不改变本报告的任何结论。</p>
  </section>`);
  }

  const unresolved = report.gaps.unresolvedConflicts    .map(
      (conflict) =>
        `<li>严重度 ${conflict.severity}：${escapeHtml(conflict.summary)}</li>`
    )
    .join("");
  sections.push(`
  <section>
    <h2>缺口、冲突与限制</h2>
    <h4>未解决冲突（${report.gaps.unresolvedConflicts.length}）</h4>
    ${unresolved ? `<ul>${unresolved}</ul>` : "<p class=\"muted\">没有未解决的冲突。</p>"}
    <h4>适用范围与限制</h4>
    <ul>${report.limits.map((limit) => `<li>${escapeHtml(limit)}</li>`).join("")}</ul>
  </section>`);

  // The frozen multilingual reading summary. Rendered from the payload this
  // version was saved with — never recomputed — and absent when no
  // translation was stored. An aid inventory, never a fact.
  if (report.multilingual) {
    const ml = report.multilingual;
    const sourceLanguages = ml.sourceLanguages.map(languageCodeLabel).join("、");
    const targetLanguages = ml.targetLanguages.map(languageCodeLabel).join("、");
    sections.push(`
  <section class="risk">
    <h2>多语言阅读辅助</h2>
    <p class="muted">涉及语言 ${escapeHtml(sourceLanguages || "无")} · 译文目标语言 ${escapeHtml(targetLanguages || "无")} · 已存储译文 ${ml.translationCount} 条</p>
    <p>人工复核 ${ml.humanReviewedCount} 条，其中认可 ${ml.approvedCount} 条、标记或要求重译 ${ml.flaggedCount} 条。</p>
    <p class="note">译文仅供辅助阅读：本报告所有引用锚定原文摘录，译文不构成、也不能替代对任何材料的核实；机器翻译未经人工复核前不得视为已确认。</p>
  </section>`);
  }

  sections.push(`
  <section>
    <h2>可追溯性</h2>
    <p class="muted">主张 ${report.provenance.claimIds.length} 条 · 证据 ${report.provenance.evidenceIds.length} 条 · 来源 ${report.provenance.sourceIds.length} 个 · 人工复核 ${report.provenance.reviewIds.length} 次 · 事件序号上界 ${report.provenance.lastEventSequence}</p>
  </section>`);

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>事实核查报告 · 版本 v${snapshot.version}</title>
<style>
  :root { color-scheme: light; }
  body { font-family: "Noto Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; margin: 0 auto; max-width: 46rem; padding: 2rem 1.25rem; color: #1f2328; line-height: 1.65; }
  h1 { font-size: 1.6rem; margin-bottom: 0.5rem; }
  h2 { font-size: 1.2rem; margin: 2rem 0 0.5rem; border-bottom: 1px solid #d8dee4; padding-bottom: 0.3rem; }
  h3 { font-size: 1.05rem; margin: 1.5rem 0 0.25rem; }
  h4 { font-size: 0.95rem; margin: 1rem 0 0.35rem; color: #424a53; }
  .muted { color: #59636e; font-size: 0.9rem; }
  .note { background: #fff8c5; border: 1px solid #d4a72c66; border-radius: 6px; padding: 0.5rem 0.75rem; font-size: 0.9rem; }
  .question { font-size: 1.1rem; font-weight: 600; }
  .review { border-left: 3px solid #0969da; padding-left: 0.75rem; }
  .risk { background: #f6f8fa; border: 1px solid #d8dee4; border-radius: 8px; padding: 0.5rem 1rem 1rem; }
  blockquote { margin: 0.5rem 0; padding: 0.5rem 0.9rem; border-left: 3px solid #8c959f; background: #f6f8fa; }
  blockquote footer { font-size: 0.85rem; color: #59636e; margin-top: 0.35rem; }
  table { border-collapse: collapse; width: 100%; margin: 0.5rem 0; }
  th, td { border: 1px solid #d8dee4; padding: 0.35rem 0.6rem; text-align: left; font-size: 0.9rem; }
  caption { text-align: left; font-size: 0.85rem; color: #59636e; padding-bottom: 0.25rem; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 1rem; margin: 0.5rem 0; }
  dt { color: #59636e; }
  dd { margin: 0; }
  code { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 0.85em; }
  ul { padding-left: 1.25rem; }
  section { break-inside: avoid-page; }
  .finding { break-inside: avoid-page; }
  @media print {
    body { max-width: none; padding: 0; }
    .risk, blockquote { background: #fff; }
  }
</style>
</head>
<body>
${sections.join("\n")}
</body>
</html>
`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
