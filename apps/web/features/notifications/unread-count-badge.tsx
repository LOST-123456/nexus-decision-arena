"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { getUnreadNotificationCount } from "./api";

/**
 * The unread count in the global bar.
 *
 * Two deliberate limits, because a badge sits on every page:
 *
 *  1. **It never renders a number it does not have.** `null` covers signed out,
 *     unreachable API and "not asked yet" alike; all three draw nothing. A bar
 *     that shows `0` when the request failed is claiming the desk is clear.
 *  2. **It does not poll.** The count is re-read when the reader navigates, when
 *     the tab regains focus, and when this client marks something read — the
 *     three moments it can actually have changed. A timer would buy a number
 *     that is at most a minute fresher in exchange for a request per minute per
 *     open tab, and nobody acts on a notification they are not looking at.
 */
const CHANGED_EVENT = "nexus:notifications-changed";

/** Tells the badge to re-read, after a write the badge did not see. */
export function notifyNotificationsChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(CHANGED_EVENT));
}

export function useUnreadNotificationCount(): number | null {
  const pathname = usePathname() ?? "/";
  const [count, setCount] = useState<number | null>(null);

  // Navigating can change what is waiting for you, so the route is the trigger.
  useEffect(() => {
    let cancelled = false;
    void getUnreadNotificationCount().then((next) => {
      if (!cancelled) setCount(next);
    });
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  useEffect(() => {
    const refresh = (): void => {
      void getUnreadNotificationCount().then(setCount);
    };
    const onVisibility = (): void => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", refresh);
    window.addEventListener(CHANGED_EVENT, refresh);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener(CHANGED_EVENT, refresh);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return count;
}

/**
 * Nothing at all for `null`, `0` or a negative count.
 *
 * The digits are `aria-hidden` and the meaning lives in the label, so a screen
 * reader announces "消息，3 项待处理" instead of reading a bare number after the
 * link text.
 */
export function UnreadCountBadge({ count }: { count: number | null }) {
  if (count === null || count <= 0) return null;
  const text = count > 99 ? "99+" : String(count);

  return (
    <span
      className="app-nav-badge"
      data-testid="notifications-badge"
      aria-label={`${count} 项待处理`}
    >
      <span aria-hidden="true">{text}</span>
    </span>
  );
}
