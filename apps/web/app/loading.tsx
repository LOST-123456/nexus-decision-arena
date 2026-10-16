import { FullPageNotice } from "../components/ui/notice";

/**
 * Suspense fallback for route segments. The failure side of the app already
 * says what went wrong (P16); this is the mirror image — it says something is
 * on its way, in the same shell, instead of blanking the viewport.
 */
export default function Loading() {
  return (
    <FullPageNotice
      testId="route-loading"
      tone="loading"
      role="status"
      live="polite"
      eyebrow="LOADING"
      title="正在载入"
      hint="正在准备页面内容…"
    />
  );
}
