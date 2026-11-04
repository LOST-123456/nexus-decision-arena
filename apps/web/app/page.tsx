import Link from "next/link";
import { DecisionMap } from "../components/decision-map";
import { previewSession } from "../features/arena/preview-session";

/**
 * The front door.
 *
 * This page used to describe one of the product's two surfaces and offer two
 * buttons into it, both pointing at the arena. A visitor who came for the
 * fact-checking half had no way to learn it existed short of noticing a nav
 * link — and the product's own name, "Arena", quietly agreed with the omission.
 *
 * Both paths now get their own card, the same amount of copy and the same
 * accent treatment. They are presented side by side rather than merged into one
 * "workspace" because they are not the same surface: the arena is where claims
 * are argued and ruled on, the research workspace is where material is kept,
 * cited and checked. They share the session record — the note under the cards
 * says so — but a visitor chooses which one to open.
 *
 * Everything here is server-rendered. There is no state on this page, so there
 * is nothing to hydrate; the only interactive parts are the global nav and the
 * preview canvas below.
 */
export default function HomePage() {
  return (
    <main id="main" tabIndex={-1} className="entry-shell">
      <section className="entry-hero" aria-labelledby="entry-title">
        <div className="entry-hero-copy">
          <p className="eyebrow">NEXUS / DECISION OPERATIONS</p>
          <h1 id="entry-title">Nexus Decision Arena</h1>
          <p className="entry-hero-lead">
            两条路径，同一条要求：结论要能被证据支撑。竞技场让 AI 角色先各自分析、
            再互相质询，最后由人裁决并留下可回放的记录；研究工作台把来源、引用与
            核实状态摆在同一张台账上，报告里的每一句话都能点回它的出处。
          </p>
        </div>
      </section>

      <section className="entry-paths" aria-labelledby="entry-paths-title">
        <h2 className="entry-paths-title" id="entry-paths-title">
          从哪里开始
        </h2>

        <div className="entry-paths-grid">
          <article className="entry-path" data-testid="entry-path-arena">
            <p className="entry-path-index">路径 01</p>
            <h3>决策竞技场</h3>
            <p className="entry-path-lead">
              五个 AI 角色独立分析、交叉质询与冲突检测，最终由人裁决。
            </p>
            <ul className="entry-path-points">
              <li>五个角色各写各的，先不互相看</li>
              <li>冲突被标出来，由人判断谁对并说明理由</li>
              <li>整场决策可回放，事件按序留痕</li>
            </ul>
            <div className="entry-path-actions">
              <Link className="primary-link" href="/sessions/new">
                新建评审
              </Link>
              <Link className="header-secondary-link" href="/sessions/demo">
                固定演示
              </Link>
            </div>
          </article>

          <article className="entry-path" data-testid="entry-path-research">
            <p className="entry-path-index">路径 02</p>
            <h3>研究与事实核查</h3>
            <p className="entry-path-lead">
              材料、主张、引用与核实状态摆在一起，报告里的每句话都能溯源。
            </p>
            <ul className="entry-path-points">
              <li>来源先进资料库，进报告前先看可信度与独立性</li>
              <li>引用逐条核对，断掉的那条会被标出来</li>
              <li>AI 抽取的建议与人的核实分开记录，不互相顶替</li>
            </ul>
            <div className="entry-path-actions">
              <Link className="primary-link" href="/research">
                开始一项研究
              </Link>
              <Link className="header-secondary-link" href="/research/library">
                资料库
              </Link>
            </div>
          </article>
        </div>

        <p className="entry-paths-note">
          两条路径共用同一条研究记录：研究工作台看证据与引用，质询视图看争论与裁决。
        </p>
      </section>

      <section className="entry-preview" aria-labelledby="entry-preview-title">
        <div className="entry-preview-head">
          <h2 id="entry-preview-title">竞技场内部</h2>
          <p>
            一场评审的现场：各角色的判断被摆在同一张图上，冲突、质询与人工裁决依次留痕。
            下面是固定演示中的一段真实记录，不是示意图。
          </p>
        </div>

        <div className="entry-stage" aria-label="决策竞技场预览">
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
        </div>
      </section>
    </main>
  );
}
