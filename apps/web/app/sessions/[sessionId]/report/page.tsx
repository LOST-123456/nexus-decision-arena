import Link from "next/link";

export default async function ReportPage({
  params
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;

  return (
    <main className="report-shell">
      <header className="report-header">
        <Link className="brand-lockup brand-lockup-compact" href={`/sessions/${sessionId}`}>
          <span className="brand-mark" aria-hidden="true">
            N
          </span>
          <span>
            <strong>Nexus Decision Arena</strong>
            <small>SESSION / {sessionId}</small>
          </span>
        </Link>
        <span className="report-status">REPORT READY</span>
      </header>

      <article className="report-document">
        <div className="report-hero">
          <p className="eyebrow">DECISION REPORT</p>
          <h1>有限立项</h1>
          <p>先在 3 间实验室验证 12 个月，设置阶段验收门槛。</p>
        </div>

        <section className="report-section">
          <p className="eyebrow">01 / EXPLANATION</p>
          <h2>决策解释</h2>
          <p>
            初始分析支持立项，但交叉质询暴露了采购规模、开发周期、毛利率和合规责任四项证据缺口。人工采纳高严重度质询后，不再支持直接扩张，改为有限试点。
          </p>
        </section>

        <section className="report-section">
          <p className="eyebrow">02 / NEXT ACTIONS</p>
          <h2>后续动作</h2>
          <ol>
            <li>
              <span>01</span>
              取得 3 间实验室的试点确认
            </li>
            <li>
              <span>02</span>
              提交硬件兼容性原型报告
            </li>
            <li>
              <span>03</span>
              建立包含实施成本的单位经济模型
            </li>
            <li>
              <span>04</span>
              取得采购周期和合规责任的外部依据
            </li>
          </ol>
        </section>

        <footer className="report-footer">
          <span>INITIAL: 建议立项</span>
          <span>CHALLENGED: 暂缓规模化扩张</span>
          <span>HUMAN: 采纳关键质询</span>
          <span>FINAL: 有限立项</span>
        </footer>
      </article>
    </main>
  );
}
