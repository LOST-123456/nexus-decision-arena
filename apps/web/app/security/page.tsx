import Link from "next/link";

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
    <main className="security-shell">
      <header className="security-header">
        <Link className="brand-lockup brand-lockup-compact" href="/">
          <span className="brand-mark" aria-hidden="true">N</span>
          <span><strong>Nexus Decision Arena</strong><small>SECURITY & GOVERNANCE</small></span>
        </Link>
        <Link className="header-secondary-link" href="/">返回首页</Link>
      </header>
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
      </section>
    </main>
  );
}
