"use client";

import Link from "next/link";
import { useEffect } from "react";

/**
 * Route-level error boundary. Without it an uncaught render error falls back
 * to Next's own error screen, which says nothing an operator can act on. Here
 * the message, a retry and a way out are all present, and the digest is kept
 * so a report can be traced back to a server log line.
 */
export default function RouteError({
  error,
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Route error:", error);
  }, [error]);

  return (
    <main id="main" tabIndex={-1} className="workspace-fallback" data-testid="route-error">
      <section className="workspace-notice" role="alert">
        <p className="eyebrow">UNEXPECTED ERROR</p>
        <h2>页面出错了</h2>
        <p className="workspace-notice-reason">
          {error.message || "渲染这个页面时发生了未预期的错误。"}
        </p>
        <p className="workspace-notice-hint">
          可以先重试；如果反复出现，请把页面地址反馈给管理员
          {error.digest ? `（错误编号 ${error.digest}）` : ""}。
        </p>
        <div className="workspace-notice-actions">
          <button type="button" className="workspace-retry" onClick={reset}>
            重试
          </button>
          <Link className="workspace-retry" href="/">
            返回首页
          </Link>
        </div>
      </section>
    </main>
  );
}
