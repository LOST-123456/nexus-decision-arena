import Link from "next/link";
import { DecisionMap } from "../components/decision-map";
import { previewSession } from "../features/arena/preview-session";

export default function HomePage() {
  return (
    <main className="entry-shell">
      <header className="entry-header">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            N
          </span>
          <div>
            <p className="eyebrow">NEXUS / DECISION OPERATIONS</p>
            <h1>Nexus Decision Arena</h1>
          </div>
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
      </header>

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
