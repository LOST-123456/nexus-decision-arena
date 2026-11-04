"use client";

import { usePathname, useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent
} from "react";
import { createPortal } from "react-dom";
import { MAX_PAGE_LIMIT } from "@nexus/shared";
import { listSessions, type SessionSummary } from "../features/arena/api-client";
import { RELATION_LABELS } from "../features/arena/session-relation";
import { workflowLabel } from "../features/research/labels";
import { trapTabWithinPanel, useModalFocus } from "./ui/dialog";

/*
 * 跳到会话 — the keyboard path to a session you already have access to.
 *
 * This is deliberately NOT called "quick search". The P29 navigation review
 * asked for 快速搜索 and the answer was no: the product has no cross-session /
 * cross-source search endpoint, and a box that filters the current page while
 * claiming to search would be a capability the product does not have. What it
 * does have is `GET /api/sessions`, which the server already narrows to the
 * sessions the caller may read (`readableSessionIds`). So this surface searches
 * exactly that list — title and id — and says so in one line of visible text
 * rather than letting the user assume it reads inside the research.
 *
 * The behaviour it keeps from the original intent is the one users actually
 * wanted: type a word, press Enter, land in the session. No mouse required.
 *
 * Focus, Tab cycling and the return path come from `useModalFocus` /
 * `trapTabWithinPanel` — the same contract every other modal in the app runs
 * on, so this cannot drift from them.
 */

type LoadState = "idle" | "loading" | "ready" | "error";

/**
 * Where a chosen session opens.
 *
 * A session record is one row that two surfaces read: the decision arena at
 * `/sessions/{id}` and the research workspace at `/research/{id}`. Picking one
 * of them as *the* destination would quietly re-merge two entry points this
 * project keeps deliberately separate, so the panel follows the user instead:
 * standing in the research area opens the research workspace, anywhere else
 * opens the arena. The record is the same either way.
 */
export function destinationFor(pathname: string, sessionId: string): string {
  const inResearchArea =
    pathname === "/research" || pathname.startsWith("/research/");
  return inResearchArea ? `/research/${sessionId}` : `/sessions/${sessionId}`;
}

/** Case- and whitespace-insensitive match over the two fields a summary owns. */
export function filterSessions(
  sessions: readonly SessionSummary[],
  query: string
): SessionSummary[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...sessions];
  return sessions.filter(
    (session) =>
      session.projectName.toLowerCase().includes(needle) ||
      session.id.toLowerCase().includes(needle)
  );
}

/**
 * Wraps around both ends. Kept separate and pure because "does ArrowUp on the
 * first row jump to the last" is the kind of thing that is easy to get wrong
 * and cheap to test without a DOM.
 */
export function moveActiveIndex(
  index: number,
  delta: number,
  length: number
): number {
  if (length <= 0) return 0;
  return (((index + delta) % length) + length) % length;
}

/**
 * The one line of feedback under the list. Pure so the four states can be
 * asserted without rendering: loading, failed-before-any-data, no match, and
 * the plain count.
 */
export function describeStatus(params: {
  state: LoadState;
  loaded: boolean;
  matchCount: number;
  query: string;
  error: string | null;
}): string {
  const { state, loaded, matchCount, query, error } = params;
  const needle = query.trim();
  if (state === "loading" && !loaded) return "正在加载会话…";
  if (state === "error" && !loaded) {
    return error ?? "无法加载会话列表，请重试。";
  }
  if (matchCount === 0) {
    if (!loaded) return "还没有可跳转的会话。";
    return needle === ""
      ? "还没有可跳转的会话。"
      : `没有匹配「${needle}」的会话。`;
  }
  return needle === ""
    ? `共 ${matchCount} 个可跳转的会话。`
    : `匹配到 ${matchCount} 个会话。`;
}

export function QuickSwitcher() {
  const router = useRouter();
  const pathname = usePathname() ?? "/";
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [state, setState] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);
  /**
   * Whether the server has more sessions than this panel asked for.
   *
   * Read from the response rather than compared against the page size: a
   * workspace holding exactly the page size has nothing left, and a workspace
   * holding one more does — the two look identical from a row count.
   */
  const [capped, setCapped] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  // Cosmetic only, but "Ctrl K" on a Mac is a lie the user pays for at the
  // keyboard. Set after mount so the server-rendered frame stays stable.
  const [modifier, setModifier] = useState("Ctrl");
  const panelRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const titleId = `${baseId}-title`;
  const hintId = `${baseId}-hint`;
  const listId = `${baseId}-list`;

  useModalFocus(open, panelRef);

  const items = sessions === null ? [] : filterSessions(sessions, query);

  const load = useCallback(async (): Promise<void> => {
    setState("loading");
    setError(null);
    try {
      // Widest horizon the shared page contract allows, because a switcher is
      // for reaching a session you have not touched recently. The status line
      // discloses the cap whenever the server says there is more.
      const page = await listSessions({ limit: MAX_PAGE_LIMIT });
      setSessions(page.sessions);
      setCapped(page.hasNextPage);
      setState("ready");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "无法加载会话列表，请重试。"
      );
      setState("error");
    }
  }, []);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      setOpen((current) => !current);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (window.navigator.userAgent.includes("Mac")) setModifier("⌘");
  }, []);

  // A fresh open always starts from an empty query and the top of the list;
  // carrying the previous query over makes the panel look like it kept a state
  // the user never asked it to keep.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    void load();
  }, [open, load]);

  // The list shrinks under the cursor when the query narrows; without this the
  // active id can point at a row that is no longer rendered.
  useEffect(() => {
    setActiveIndex((current) =>
      items.length === 0 ? 0 : Math.min(current, items.length - 1)
    );
  }, [items.length]);

  useEffect(() => {
    if (!open || items.length === 0) return;
    const active = document.getElementById(`${listId}-option-${activeIndex}`);
    active?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex, items.length, listId]);

  function choose(session: SessionSummary): void {
    setOpen(false);
    router.push(destinationFor(pathname, session.id));
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => moveActiveIndex(current, 1, items.length));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => moveActiveIndex(current, -1, items.length));
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(Math.max(items.length - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      const target = items[activeIndex];
      if (!target) return;
      event.preventDefault();
      choose(target);
    }
  }

  function handlePanelKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      return;
    }
    const panel = panelRef.current;
    if (!panel) return;
    trapTabWithinPanel(panel, event);
  }

  const activeOptionId =
    items.length === 0 ? undefined : `${listId}-option-${activeIndex}`;

  const status = describeStatus({
    state,
    loaded: sessions !== null,
    matchCount: items.length,
    query,
    error
  });
  // Only shown when the server says there is more: below the cap the claim
  // would be noise, and at exactly the cap there may be nothing left to warn
  // about — a row count cannot tell those apart, the response can.
  const cappedReached = sessions !== null && capped;

  return (
    <>
      <button
        type="button"
        className="app-nav-quick-switcher"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-keyshortcuts="Control+K Meta+K"
        data-testid="quick-switcher-trigger"
        onClick={() => setOpen(true)}
      >
        <span className="quick-switcher-label">跳到会话</span>
        <kbd className="quick-switcher-kbd" aria-hidden="true">
          {modifier} K
        </kbd>
      </button>

      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              className="dialog-backdrop"
              data-testid="quick-switcher"
              onMouseDown={(event) => {
                // Same rule as the confirmation dialog: only a press that both
                // starts and ends on the backdrop dismisses.
                if (event.target !== event.currentTarget) return;
                setOpen(false);
              }}
              onKeyDown={handlePanelKeyDown}
            >
              <div
                ref={panelRef}
                className="quick-switcher"
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
              >
                <h2 className="quick-switcher-title" id={titleId}>
                  跳到会话
                </h2>

                <input
                  data-modal-default-focus
                  data-testid="quick-switcher-input"
                  className="quick-switcher-input"
                  type="text"
                  role="combobox"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label="会话标题或 id"
                  aria-expanded={items.length > 0}
                  aria-controls={listId}
                  aria-activedescendant={activeOptionId}
                  aria-autocomplete="list"
                  aria-describedby={hintId}
                  placeholder="输入会话标题或 id…"
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setActiveIndex(0);
                  }}
                  onKeyDown={handleInputKeyDown}
                />

                <p className="quick-switcher-hint" id={hintId}>
                  只匹配你有权查看的会话标题与 id，不检索会话内容。
                </p>

                {items.length > 0 ? (
                  <ul
                    className="quick-switcher-list"
                    id={listId}
                    role="listbox"
                    aria-label="可跳转的会话"
                    data-testid="quick-switcher-list"
                  >
                    {items.map((session, index) => (
                      <li
                        key={session.id}
                        id={`${listId}-option-${index}`}
                        role="option"
                        aria-selected={index === activeIndex}
                        className={`quick-switcher-option${
                          index === activeIndex
                            ? " quick-switcher-option-active"
                            : ""
                        }`}
                        onMouseEnter={() => setActiveIndex(index)}
                        onMouseDown={(event) => {
                          // mousedown, not click: `useModalFocus` restores focus
                          // on unmount, and a click that lands after that
                          // restore misses the row it aimed at.
                          event.preventDefault();
                          choose(session);
                        }}
                      >
                        <span className="quick-switcher-name">
                          {session.projectName}
                        </span>
                        <span className="quick-switcher-meta">
                          {/*
                            Ahead of the phase because it answers a question
                            about the row itself: this palette can hold two
                            hundred researches from several people, and
                            "其中哪些是我建的" is what decides the choice.
                          */}
                          {session.relation ? (
                            <>
                              {RELATION_LABELS[session.relation]}
                              <span aria-hidden="true"> · </span>
                            </>
                          ) : null}
                          {workflowLabel(session.phase)}
                          <span aria-hidden="true"> · </span>
                          <code className="quick-switcher-id">
                            {session.id.slice(0, 8)}
                          </code>
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}

                {state === "error" ? (
                  <div className="quick-switcher-error" role="alert">
                    <span>{error ?? "无法加载会话列表，请重试。"}</span>
                    <button type="button" onClick={() => void load()}>
                      重试
                    </button>
                  </div>
                ) : null}

                <p
                  className="quick-switcher-status"
                  role="status"
                  aria-live="polite"
                >
                  {status}
                  {cappedReached ? `（仅列出最近 ${MAX_PAGE_LIMIT} 个会话）` : null}
                </p>
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  );
}
