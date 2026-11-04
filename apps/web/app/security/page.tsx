import { OversightPanel } from "../../features/security/oversight-panel";

const controls = [
  ["数据位置", "项目、审计事件和报告保存在本地 PostgreSQL；模型保存在 E 盘。"],
  ["密钥边界", "模型 API Key 仅由服务端环境变量读取，不进入浏览器代码和导出文件。"],
  ["日志脱敏", "应用日志不记录 API Key；项目输入仅在评审流程内使用。"],
  ["删除机制", "历史记录支持删除会话及其关联业务数据。"],
  ["模型调用边界", "固定 Demo 使用 fixture；新项目必须使用真实模型模式。"],
  ["人类最终裁决", "高风险冲突不会由 AI 自动关闭，必须进入人工检查点。"]
] as const;

export default function SecurityPage() {
  return (
    <main id="main" tabIndex={-1} className="security-shell">
      <section className="security-document">
        <p className="eyebrow">SECURITY & DATA GOVERNANCE</p>
        <h1>安全与数据治理</h1>
        <p className="lead">
          系统将模型输出约束在可审计的决策流程中，不把密钥、最终责任和高风险裁决交给浏览器或 AI。
        </p>
        <div className="security-grid">
          {controls.map(([title, body], index) => (
            <article key={title}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <h2>{title}</h2>
              <p>{body}</p>
            </article>
          ))}
        </div>

        {/*
          The six cards above are assertions, and an assertion cannot be
          checked. This section makes the page's own claim falsifiable: the two
          promises that leave a trace in the database — "a person decides the
          risky conflicts" and "runs are recorded honestly" — are counted from
          the rows themselves.

          Kept on this page rather than given its own route on purpose. A
          separate "governance dashboard" would be a second place asserting
          things about governance, and the first place to drift.
        */}
        <div className="security-measured">
          <p className="eyebrow">MEASURED, NOT ASSERTED</p>
          <h2>上面这些主张，在这个部署里的实际数据</h2>
          <p className="lead">
            六条里有两类会留下可核对的痕迹：人工裁决与运行记录。下面把它们数出来，
            而不是再声明一遍。
          </p>
          <OversightPanel />
        </div>
      </section>
    </main>
  );
}
