/**
 * Suspense fallback for route segments. The failure side of the app already
 * says what went wrong (P16); this is the mirror image — it says something is
 * on its way, in the same shell, instead of blanking the viewport.
 */
export default function Loading() {
  return (
    <main className="workspace-fallback" data-testid="route-loading">
      <section
        className="workspace-notice"
        data-tone="loading"
        role="status"
        aria-live="polite"
      >
        <p className="eyebrow">LOADING</p>
        <h2>正在载入</h2>
        <p className="workspace-notice-hint">正在准备页面内容…</p>
      </section>
    </main>
  );
}
