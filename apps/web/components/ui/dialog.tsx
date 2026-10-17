"use client";

import {
  useEffect,
  useId,
  useRef,
  type KeyboardEvent,
  type ReactNode,
  type RefObject
} from "react";
import { createPortal } from "react-dom";
import { Button } from "./button";

/**
 * The one place a confirmation is asked.
 *
 * Until this existed the app had no dialog at all: revoking a share grant,
 * cancelling an agent run, approving a search candidate and deleting a comment
 * each fired on a single click, with the only guard being a `title` tooltip or
 * nothing at all. That is the shape WCAG 2.2 §3.3.4 and the platform's own
 * "dangerous operation" rule are about — the consequence has to be visible and
 * the answer has to be deliberate.
 *
 * The focus contract is part of the component, not a call site's problem:
 * focus moves in on open, Tab cycles inside the panel, Escape cancels, and
 * focus goes back to whatever opened it. Hand-rolled copies drift on exactly
 * those four points, which is why there is one implementation.
 *
 * `role="dialog"` + `aria-modal` rather than `alertdialog`: the outcome of the
 * action is already announced by the call site's own live region, and a single
 * role keeps assistive-tech behaviour and test queries uniform across every
 * confirmation in the app.
 */

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

/**
 * The focus contract every modal in this app owes its user, in one place.
 *
 * WCAG 2.2 is explicit about the four moves: focus enters the panel when it
 * opens, Tab cycles inside it, Escape leaves, and focus returns to whatever
 * opened it. Each of those is easy to write and easy to forget, and a modal
 * that misses one is worse than no modal — the keyboard user is then trapped
 * or dropped somewhere unrelated. `ConfirmDialog` and the navigation drawer
 * both run on this hook, so there is one implementation to get right rather
 * than two that drift.
 *
 * The cleanup runs for "closed" and "unmounted while open" alike, so a caller
 * that removes the modal from a list cannot lose the return path.
 */
export function useModalFocus(
  open: boolean,
  panelRef: RefObject<HTMLElement | null>,
  options: { lockScroll?: boolean } = {}
): void {
  const { lockScroll = true } = options;
  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    const restoreTo =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    const initial =
      panel?.querySelector<HTMLElement>("[data-modal-default-focus]") ?? panel;
    initial?.focus();
    const previousOverflow = document.body.style.overflow;
    if (lockScroll) {
      document.body.style.overflow = "hidden";
    }
    return () => {
      if (lockScroll) {
        document.body.style.overflow = previousOverflow;
      }
      restoreTo?.focus();
    };
  }, [open, panelRef, lockScroll]);
}

/**
 * Tab cycling for a modal panel. Returns true when it handled the key, so a
 * caller can stop there; the empty-panel case focuses the panel itself, which
 * is what keeps a modal with no controls (a notice, say) from being a trap.
 */
export function trapTabWithinPanel(
  panel: HTMLElement,
  event: { key: string; shiftKey: boolean; preventDefault: () => void }
): boolean {
  if (event.key !== "Tab") return false;
  const focusable = focusableWithin(panel);
  if (focusable.length === 0) {
    event.preventDefault();
    panel.focus();
    return true;
  }
  // The length check above makes both of these defined; the assertions say so
  // to the compiler, which cannot narrow an indexed access on its own.
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  const active = document.activeElement;
  const inside = active instanceof Node && panel.contains(active);
  if (event.shiftKey && (!inside || active === first)) {
    event.preventDefault();
    last.focus();
    return true;
  }
  if (!event.shiftKey && (!inside || active === last)) {
    event.preventDefault();
    first.focus();
    return true;
  }
  return false;
}

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** The consequence of confirming, in the operator's words. */
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /**
   * `danger` tints the confirm control for irreversible or outward-facing
   * actions (revoke, delete, cancel a run, reject a review). `neutral` keeps
   * the accent styling for ordinary acknowledgements.
   */
  tone?: "danger" | "neutral";
  /**
   * True while the confirmed action is in flight. Both controls lock so a
   * second click cannot submit the same thing twice, and Escape stops
   * dismissing — closing mid-flight would drop the failure message the caller
   * is about to render.
   */
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  testId?: string;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "确认",
  cancelLabel = "取消",
  tone = "danger",
  busy = false,
  onConfirm,
  onCancel,
  testId
}: ConfirmDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  useModalFocus(open, panelRef);

  if (!open || typeof document === "undefined") return null;

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      // Ignored while busy on purpose: see the `busy` prop.
      if (busy) return;
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;
    trapTabWithinPanel(panel, event);
  }

  return createPortal(
    <div
      className="dialog-backdrop"
      data-testid={testId}
      onMouseDown={(event) => {
        // mousedown, not click: a drag that ends on the backdrop must not
        // dismiss a confirmation the pointer never chose.
        if (busy || event.target !== event.currentTarget) return;
        onCancel();
      }}
      onKeyDown={handleKeyDown}
    >
      <div
        ref={panelRef}
        className="dialog-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
      >
        <h2 className="dialog-title" id={titleId}>
          {title}
        </h2>
        {description ? (
          <div className="dialog-description" id={descriptionId}>
            {description}
          </div>
        ) : null}
        <div className="dialog-actions">
          <Button data-modal-default-focus onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            className={`dialog-confirm${tone === "danger" ? " dialog-confirm-danger" : ""}`}
            onClick={onConfirm}
            disabled={busy}
            aria-busy={busy || undefined}
          >
            {busy ? "处理中…" : confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  );
}
