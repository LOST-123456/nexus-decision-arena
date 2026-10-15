import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "页面不存在 · Nexus Decision Arena"
};

/**
 * Without this file Next answers an unknown path with its own English 404
 * page, which drops the operator out of the product's language and design
 * system. This keeps 404 inside the same shell as everything else and points
 * at the two entrances that actually exist.
 */
export default function NotFound() {
  return (
    <main className="workspace-fallback" data-testid="not-found">
      <section className="workspace-notice" data-tone="neutral" role="alert">
        <p className="eyebrow">404 / NOT FOUND</p>
        <h2>页面不存在</h2>
        <p className="workspace-notice-reason">
          这个地址没有对应的页面，它可能已经改名或被删除了。
        </p>
        <p className="workspace-notice-hint">
          请检查链接是否正确，或从下面的入口重新开始。
        </p>
        <div className="workspace-notice-actions">
          <Link className="workspace-retry" href="/">
            返回首页
          </Link>
          <Link className="workspace-retry" href="/research">
            研究与事实核查
          </Link>
        </div>
      </section>
    </main>
  );
}
