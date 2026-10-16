import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";

/**
 * One visual contract for the app's small action control.
 *
 * `.workspace-retry` was previously written by hand nine times across four
 * files, on three different elements (`<button>`, `next/link`, bare `<a>`).
 * Nothing tied those together: the look lived only in the stylesheet, so each
 * new call site re-decided the markup and could silently drift.
 */
export const ACTION_CLASS = "workspace-retry";

function withClass(className?: string): string {
  return className ? `${ACTION_CLASS} ${className}` : ACTION_CLASS;
}

/**
 * An in-page action. `type` defaults to `button` so a control inside a form
 * cannot submit it by accident — the mistake this default exists to prevent.
 */
export function Button({
  children,
  className,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type={type} className={withClass(className)} {...rest}>
      {children}
    </button>
  );
}

export interface ActionLinkProps {
  href: string;
  children: ReactNode;
  className?: string;
}

/** A navigation action that stays inside the router. */
export function ActionLink({ href, children, className }: ActionLinkProps) {
  return (
    <Link href={href} className={withClass(className)}>
      {children}
    </Link>
  );
}

/**
 * The same control for the one case that cannot use the router: `global-error`
 * renders its own `<html>` after the root layout failed, so there is no router
 * context to navigate with and a full document load is the correct answer.
 * Kept here rather than inlined so the class contract still has one home.
 */
export function HardActionLink({ href, children, className }: ActionLinkProps) {
  return (
    <a href={href} className={withClass(className)}>
      {children}
    </a>
  );
}
