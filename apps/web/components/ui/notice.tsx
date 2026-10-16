import type { ReactNode } from "react";

/**
 * The one place a "something went wrong / nothing here yet" panel is built.
 *
 * Before this existed the same skeleton — eyebrow, heading, reason, hint,
 * actions — was hand-written six times (404, route error, global error,
 * loading, and twice in the session workspace), and each copy could drift in
 * copy, tone or markup without any test noticing. The class names are the
 * existing ones, so this is a refactor, not a restyle.
 *
 * Adding a tone means adding it here *and* a matching
 * `.workspace-notice[data-tone="…"]` rule in globals.css — the union is
 * deliberately limited to the tones that actually have styling, so an
 * unstyled tone cannot be selected by accident.
 */
export type NoticeTone = "danger" | "neutral" | "loading";

export interface NoticeProps {
  /** Small all-caps line above the heading, e.g. "404 / NOT FOUND". */
  eyebrow: string;
  title: string;
  /** What actually happened, in the operator's words. */
  reason?: ReactNode;
  /** What they can do about it. */
  hint?: ReactNode;
  /** Recovery controls; rendered inside the standard actions row. */
  actions?: ReactNode;
  /** Defaults to `danger`, which is the panel's own base styling. */
  tone?: NoticeTone;
  /** `alert` for failures, `status` for progress. Omitted leaves it decorative. */
  role?: "alert" | "status";
  live?: "polite" | "assertive";
  testId?: string;
}

export function Notice({
  eyebrow,
  title,
  reason,
  hint,
  actions,
  tone = "danger",
  role,
  live,
  testId
}: NoticeProps) {
  return (
    <section
      className="workspace-notice"
      data-tone={tone}
      {...(role ? { role } : {})}
      {...(live ? { "aria-live": live } : {})}
      {...(testId ? { "data-testid": testId } : {})}
    >
      <p className="eyebrow">{eyebrow}</p>
      <h2>{title}</h2>
      {reason ? <p className="workspace-notice-reason">{reason}</p> : null}
      {hint ? <p className="workspace-notice-hint">{hint}</p> : null}
      {actions ? <div className="workspace-notice-actions">{actions}</div> : null}
    </section>
  );
}

export interface FullPageNoticeProps extends NoticeProps {
  /** Goes on the `<main>` wrapper, which is what the tests reach for. */
  testId?: string;
}

/**
 * A `Notice` that fills the viewport on its own — the shape every whole-app
 * boundary needs (404, route error, global error, loading).
 *
 * The landmark and its id are part of the component on purpose: the skip link
 * in the root layout points at `#main`, so a boundary that forgot the id would
 * quietly break it. Centralising it means that cannot be forgotten. That also
 * covers `global-error`, which renders its own `<html>` with no skip link —
 * there the id is harmless and keeps the landmark story uniform.
 */
export function FullPageNotice({ testId, ...notice }: FullPageNoticeProps) {
  return (
    <main
      id="main"
      tabIndex={-1}
      className="workspace-fallback"
      data-testid={testId}
    >
      <Notice {...notice} />
    </main>
  );
}
