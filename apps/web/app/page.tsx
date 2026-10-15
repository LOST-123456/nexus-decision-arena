import Link from "next/link";
import { DecisionMap } from "../components/decision-map";
import { previewSession } from "../features/arena/preview-session";

export default function HomePage() {
  return (
    <main className="entry-shell">
      <section className="entry-hero" aria-label="产品说明">
        <div className="entry-hero-copy">
          <p className="eyebrow">NEXUS / DECISION OPERATIONS</p>
          <h1>Nexus Decision Arena</h1>
          <p className="entry-hero-lead">
            五个 AI 角色独立分析、交叉质询与冲突检测，最终由人裁决，并留下可回放的决策记录。
          </p>
        </div>
        <div className="entry-actions">
          <Link className="header-secondary-link" href="/sessions/new">
            新建评审
          </Link>
          <Link className="primary-link" href="/sessions/demo">
            进入固定演示
            <span aria-hidden="true">→</span>
          </Link>
        </div>
      </section>

      <section className="entry-stage" aria-label="Decision workspace preview">
        <div className="entry-status-rail">
          <div>
            <span className="rail-index">01</span>
            <span>五角色独立分析</span>
          </div>
          <div>
            <span className="rail-index">02</span>
            <span>交叉质询与冲突检测</span>
          </div>
          <div className="rail-active">
            <span className="rail-index">03</span>
            <span>人工裁决与决策回放</span>
          </div>
        </div>

        <div className="entry-map-frame">
          <DecisionMap session={previewSession} compact />
        </div>
      </section>
    </main>
  );
}