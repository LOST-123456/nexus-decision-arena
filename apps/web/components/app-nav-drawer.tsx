"use client";

import { useEffect, useRef, type KeyboardEvent } from "react";
import Link from "next/link";
import { createPortal } from "react-dom";
import { activeHref } from "./app-nav";
import { UnreadCountBadge } from "../features/notifications/unread-count-badge";
import { trapTabWithinPanel, useModalFocus } from "./ui/dialog";

/**
 * The phone-sized navigation.
 *
 * Below 768px the global bar cannot hold six destinations plus the theme
 * switch and the account badge without wrapping into three rows, so the
 * destinations move into a drawer and the bar keeps only the brand, the
 * trigger and its actions. The drawer is a real modal: focus moves into it,
 * Tab cycles inside it, Escape and the backdrop close it, and focus goes back
 * to the trigger — the same four moves `ConfirmDialog` owes, from the same
 * shared hook, so there is one implementation rather than two that drift.
 *
 * It is a portal rather than a child of the bar so it cannot be clipped by an
 * ancestor's overflow, and it renders nothing at all while closed so a
 * keyboard user never tabs into a hidden menu.
 */
export interface AppNavDrawerProps {
  open: boolean;
  pathname: string;
  links: ReadonlyArray<{ href: string; label: string }>;
  /**
   * The same count the desktop strip shows. Passed in rather than fetched here:
   * the drawer is a second rendering of one set of destinations, not a second
   * reader of the notification API.
   */
  unreadCount?: number | null;
  onClose: () => void;
}

export function AppNavDrawer({
  open,
  pathname,
  links,
  unreadCount = null,
  onClose
}: AppNavDrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const openedAtPathname = useRef(pathname);

  // Navigating away closes the drawer: leaving it open would cover the page
  // the reader just asked for. The mount run only records where we started —
  // closing on open would dismiss the drawer the reader just opened (and, in
  // the tests, double-count every close request).
  useEffect(() => {
    if (openedAtPathname.current === pathname) return;
    openedAtPathname.current = pathname;
    if (open) onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  useModalFocus(open, panelRef);

  if (!open || typeof document === "undefined") return null;

  const current = activeHref(pathname, links);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    const panel = panelRef.current;
    if (!panel) return;
    trapTabWithinPanel(panel, event);
  }

  return createPortal(
    <div
      className="app-nav-drawer-backdrop"
      data-testid="app-nav-drawer"
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return;
        onClose();
      }}
      onKeyDown={handleKeyDown}
    >
      <div
        ref={panelRef}
        className="app-nav-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="导航"
      >
        <div className="app-nav-drawer-head">
          <span className="app-nav-drawer-title">导航</span>
          <button
            type="button"
            className="app-nav-drawer-close"
            data-modal-default-focus
            onClick={onClose}
          >
            关闭
          </button>
        </div>
        <nav aria-label="主导航">
          <ul className="app-nav-drawer-list">
            {links.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  className="app-nav-drawer-link"
                  aria-current={current === link.href ? "page" : undefined}
                  onClick={onClose}
                >
                  {link.label}
                  {link.href === "/notifications" ? (
                    <UnreadCountBadge count={unreadCount} />
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </div>,
    document.body
  );
}
