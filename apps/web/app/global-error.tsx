"use client";

import "./globals.css";

/**
 * Last line of defence: this one catches a failure inside the root layout
 * itself, so it must render its own `<html>`/`<body>` and cannot rely on
 * `AppNav`. The theme is fixed to the product default because the bootstrap
 * script lives in the layout that just failed.
 */
export default function GlobalError({
  error,
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="zh-CN" data-theme="dark">
      <body>
        <main className="workspace-fallback" data-testid="global-error">
          <section className="workspace-notice" role="alert">
            <p className="eyebrow">APPLICATION ERROR</p>
            <h2>应用无法启动</h2>
            <p className="workspace-notice-reason">
              {error.message || "应用在加载基础界面时发生了错误。"}
            </p>
            <p className="workspace-notice-hint">
              请重试；如果仍然失败，请把错误编号反馈给管理员
              {error.digest ? `（错误编号 ${error.digest}）` : ""}。
            </p>
            <div className="workspace-notice-actions">
              <button type="button" className="workspace-retry" onClick={reset}>
                重试
              </button>
              <a className="workspace-retry" href="/">
                返回首页
              </a>
            </div>
          </section>
        </main>
      </body>
    </html>
  );
}
