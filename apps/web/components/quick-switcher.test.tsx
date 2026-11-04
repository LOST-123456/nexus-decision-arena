import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_PAGE_LIMIT } from "@nexus/shared";

/*
 * 跳到会话 (⌘K / Ctrl+K).
 *
 * Two things are being defended here, and only one of them is behaviour.
 *
 * The behaviour: the panel opens from the keyboard, focus lands in the
 * combobox, arrows move the selection (including wrapping), Enter navigates,
 * Escape returns focus to the trigger, and nothing is fetched before the user
 * asks for it.
 *
 * The other thing is what the panel *claims*. It searches the session list —
 * titles and ids — and says so out loud. A "search" that quietly only filters
 * one page is worse than no search at all, so the honest sentence is asserted
 * as part of the contract rather than left to survive on good intentions.
 */

const mocks = vi.hoisted(() => ({
  listSessions: vi.fn(),
  push: vi.fn<(href: string) => void>(),
  usePathname: vi.fn<() => string>()
}));

vi.mock("../features/arena/api-client", () => ({
  listSessions: (...args: unknown[]) => mocks.listSessions(...args)
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
  usePathname: () => mocks.usePathname()
}));

const {
  QuickSwitcher,
  describeStatus,
  destinationFor,
  filterSessions,
  moveActiveIndex
} = await import("./quick-switcher");

const { listSessions, push, usePathname } = mocks;

type Summary = Parameters<typeof filterSessions>[0][number];

function session(over: Partial<Summary> = {}): Summary {
  return {
    id: "0192f0aa-1111-7000-8000-000000000001",
    projectId: "project-1",
    projectName: "第四季度出货量核查",
    phase: "HUMAN_REVIEW",
    operationalStatus: "ACTIVE",
    currentConclusion: null,
    conflictCount: 0,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z",
    ...over
  } as Summary;
}

const SESSIONS = [
  session({ id: "aaaa1111-0000-7000-8000-000000000001", projectName: "第四季度出货量核查" }),
  session({
    id: "bbbb2222-0000-7000-8000-000000000002",
    projectName: "华南区复购率是否真的更高",
    phase: "DECIDED"
  }),
  session({
    id: "cccc3333-0000-7000-8000-000000000003",
    projectName: "供应商集中度风险评估",
    phase: "CREATED"
  })
];

const input = () => screen.getByTestId("quick-switcher-input");
const options = () => screen.getAllByRole("option");

/**
 * The list endpoint answers with a window, not a bare array. Going through one
 * helper means a test cannot quietly keep asserting the old shape.
 */
const page = (
  sessions: Summary[],
  extra: { nextCursor?: string | null; hasNextPage?: boolean } = {}
) => ({
  sessions,
  nextCursor: extra.nextCursor ?? null,
  hasNextPage: extra.hasNextPage ?? false
});

beforeEach(() => {
  listSessions.mockResolvedValue(page(SESSIONS));
  usePathname.mockReturnValue("/");
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("opening", () => {
  it("fetches nothing until the user asks for the panel", () => {
    render(<QuickSwitcher />);
    expect(listSessions).not.toHaveBeenCalled();
    expect(screen.queryByTestId("quick-switcher")).toBeNull();
  });

  it("opens on Ctrl+K and puts the caret in the combobox", async () => {
    render(<QuickSwitcher />);

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });

    expect(await screen.findByTestId("quick-switcher")).toBeTruthy();
    expect(document.activeElement).toBe(input());
    expect(input().getAttribute("role")).toBe("combobox");
    await waitFor(() => expect(options()).toHaveLength(3));
  });

  it("opens on the trigger and closes on Escape, returning focus to the trigger", async () => {
    render(<QuickSwitcher />);
    const trigger = screen.getByTestId("quick-switcher-trigger");

    // A real click focuses the button first; `fireEvent.click` does not, and the
    // return path is captured from whatever held focus when the panel opened.
    trigger.focus();
    fireEvent.click(trigger);
    await screen.findByTestId("quick-switcher");
    // The trigger tells assistive tech it discloses a dialog, and that it is up.
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    fireEvent.keyDown(input(), { key: "Escape" });

    expect(screen.queryByTestId("quick-switcher")).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });

  it("says what it searches, and does not claim to read inside the research", async () => {
    render(<QuickSwitcher />);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });

    const hint = await screen.findByText(/只匹配你有权查看的会话标题与 id/);
    expect(hint.textContent).toContain("不检索会话内容");
    // The input carries the hint as its description, so a screen reader hears
    // the same limitation a sighted user reads.
    expect(input().getAttribute("aria-describedby")).toBe(hint.getAttribute("id"));
  });
});

describe("selection", () => {
  it("filters on the query and reports how many matched", async () => {
    render(<QuickSwitcher />);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    await waitFor(() => expect(options()).toHaveLength(3));

    fireEvent.change(input(), { target: { value: "复购率" } });

    await waitFor(() => expect(options()).toHaveLength(1));
    expect(options()[0]?.textContent).toContain("华南区复购率是否真的更高");
    expect(screen.getByRole("status").textContent).toBe("匹配到 1 个会话。");
  });

  it("walks the list with the arrow keys, wrapping at both ends", async () => {
    render(<QuickSwitcher />);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    await waitFor(() => expect(options()).toHaveLength(3));

    expect(input().getAttribute("aria-activedescendant")).toBe(options()[0]?.id);

    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(input().getAttribute("aria-activedescendant")).toBe(options()[1]?.id);
    expect(options()[1]?.getAttribute("aria-selected")).toBe("true");
    expect(options()[0]?.getAttribute("aria-selected")).toBe("false");

    // Down twice more wraps back to the top rather than sticking on the last row.
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(input().getAttribute("aria-activedescendant")).toBe(options()[0]?.id);

    fireEvent.keyDown(input(), { key: "ArrowUp" });
    expect(input().getAttribute("aria-activedescendant")).toBe(options()[2]?.id);

    fireEvent.keyDown(input(), { key: "Home" });
    expect(input().getAttribute("aria-activedescendant")).toBe(options()[0]?.id);
    fireEvent.keyDown(input(), { key: "End" });
    expect(input().getAttribute("aria-activedescendant")).toBe(options()[2]?.id);
  });

  it("opens the active session on Enter and closes behind itself", async () => {
    render(<QuickSwitcher />);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    await waitFor(() => expect(options()).toHaveLength(3));

    fireEvent.keyDown(input(), { key: "ArrowDown" });
    fireEvent.keyDown(input(), { key: "Enter" });

    expect(push).toHaveBeenCalledWith(`/sessions/${SESSIONS[1]!.id}`);
    await waitFor(() =>
      expect(screen.queryByTestId("quick-switcher")).toBeNull()
    );
  });

  it("keeps the active row inside the list when the query narrows it", async () => {
    render(<QuickSwitcher />);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    await waitFor(() => expect(options()).toHaveLength(3));

    fireEvent.keyDown(input(), { key: "End" });
    expect(input().getAttribute("aria-activedescendant")).toBe(options()[2]?.id);

    // The row the caret was on no longer exists; the active id must fall back
    // to a row that is actually rendered.
    fireEvent.change(input(), { target: { value: "供应商" } });

    await waitFor(() => expect(options()).toHaveLength(1));
    expect(input().getAttribute("aria-activedescendant")).toBe(options()[0]?.id);
  });
});

describe("when there is nothing to show", () => {
  it("says the list is empty rather than pretending it is loading", async () => {
    listSessions.mockResolvedValue(page([]));
    render(<QuickSwitcher />);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("还没有可跳转的会话。")
    );
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  it("reports a failed load and offers a retry that really reloads", async () => {
    listSessions.mockRejectedValueOnce(new Error("网络不可达"));
    render(<QuickSwitcher />);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("网络不可达");

    listSessions.mockResolvedValueOnce(page(SESSIONS));
    fireEvent.click(screen.getByRole("button", { name: "重试" }));

    await waitFor(() => expect(options()).toHaveLength(3));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("destinationFor", () => {
  it("opens the research workspace while standing in the research area", () => {
    expect(destinationFor("/research", "s1")).toBe("/research/s1");
    expect(destinationFor("/research/s1/evidence", "s2")).toBe("/research/s2");
    expect(destinationFor("/research/library", "s3")).toBe("/research/s3");
  });

  it("opens the arena everywhere else, including the history list", () => {
    expect(destinationFor("/", "s1")).toBe("/sessions/s1");
    expect(destinationFor("/history", "s1")).toBe("/sessions/s1");
    expect(destinationFor("/sessions/demo", "s1")).toBe("/sessions/s1");
    expect(destinationFor("/security", "s1")).toBe("/sessions/s1");
  });

  it("navigates to whichever surface the user is already in", async () => {
    usePathname.mockReturnValue("/research/library");
    render(<QuickSwitcher />);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    await waitFor(() => expect(options()).toHaveLength(3));

    fireEvent.keyDown(input(), { key: "Enter" });

    expect(push).toHaveBeenCalledWith(`/research/${SESSIONS[0]!.id}`);
  });
});

describe("coverage", () => {
  it("asks for the widest window the page contract allows", async () => {
    render(<QuickSwitcher />);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });

    await waitFor(() => expect(listSessions).toHaveBeenCalled());
    expect(listSessions).toHaveBeenCalledWith({ limit: MAX_PAGE_LIMIT });
  });

  it("says the list is capped only when the server says there is more", async () => {
    const many = Array.from({ length: MAX_PAGE_LIMIT }, (_, index) =>
      session({
        id: `bulk-${index}`,
        projectName: `批量会话 ${index}`
      })
    );
    listSessions.mockResolvedValue(page(many, { hasNextPage: true }));

    render(<QuickSwitcher />);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain(
        `仅列出最近 ${MAX_PAGE_LIMIT} 个会话`
      )
    );

    // A workspace holding exactly the page size and nothing more looks
    // identical by row count to one holding more. Only the response can tell
    // them apart, so the disclosure has to come from `hasNextPage`.
    cleanup();
    listSessions.mockResolvedValue(page(many));
    render(<QuickSwitcher />);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });

    await waitFor(() => expect(options()).toHaveLength(MAX_PAGE_LIMIT));
    expect(screen.getByRole("status").textContent).not.toContain("仅列出最近");

    cleanup();
    listSessions.mockResolvedValue(page(SESSIONS));
    render(<QuickSwitcher />);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });

    await waitFor(() => expect(options()).toHaveLength(3));
    expect(screen.getByRole("status").textContent).not.toContain("仅列出最近");
  });
});

describe("filterSessions", () => {  it("matches the title and the id, ignoring case and surrounding spaces", () => {
    expect(filterSessions(SESSIONS, "  复购率 ")).toHaveLength(1);
    expect(filterSessions(SESSIONS, "BBBB2222")).toHaveLength(1);
    expect(filterSessions(SESSIONS, "  ")).toHaveLength(3);
    expect(filterSessions(SESSIONS, "不存在的关键词")).toHaveLength(0);
  });
});

describe("moveActiveIndex", () => {
  it("wraps in both directions and never leaves the range", () => {
    expect(moveActiveIndex(0, 1, 3)).toBe(1);
    expect(moveActiveIndex(2, 1, 3)).toBe(0);
    expect(moveActiveIndex(0, -1, 3)).toBe(2);
    expect(moveActiveIndex(0, 1, 0)).toBe(0);
  });
});

describe("describeStatus", () => {
  it("distinguishes loading, failure, empty and match states", () => {
    expect(
      describeStatus({ state: "loading", loaded: false, matchCount: 0, query: "", error: null })
    ).toBe("正在加载会话…");
    expect(
      describeStatus({
        state: "error",
        loaded: false,
        matchCount: 0,
        query: "",
        error: "网络不可达"
      })
    ).toBe("网络不可达");
    expect(
      describeStatus({ state: "ready", loaded: true, matchCount: 0, query: "", error: null })
    ).toBe("还没有可跳转的会话。");
    expect(
      describeStatus({ state: "ready", loaded: true, matchCount: 0, query: " x ", error: null })
    ).toBe("没有匹配「x」的会话。");
    expect(
      describeStatus({ state: "ready", loaded: true, matchCount: 3, query: "", error: null })
    ).toBe("共 3 个可跳转的会话。");
  });
});

/**
 * 这个面板最多列 200 条、来自好几个人，所以「哪条是我建的」是它必须回答的
 * 问题之一——不是权限（能列出来的都能进），而是来源。
 */
describe("provenance", () => {
  it("标出每条会话的来源；没有身份系统时不编造", async () => {
    listSessions.mockResolvedValue(
      page([
        session({ ...({ relation: "owner" } as Partial<Summary>) }),
        session({
          id: "bbbb2222-0000-7000-8000-000000000002",
          projectName: "别人共享的调研",
          ...({ relation: "granted" } as Partial<Summary>)
        }),
        session({
          id: "cccc3333-0000-7000-8000-000000000003",
          projectName: "无身份部署里的调研",
          ...({ relation: null } as Partial<Summary>)
        })
      ])
    );
    render(<QuickSwitcher />);

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    await waitFor(() => expect(options()).toHaveLength(3));

    const [, second, third] = options();
    expect(second!.textContent).toContain("共享给我");
    expect(third!.textContent).not.toContain("共享给我");
    // A deployment with no identities has nobody to attribute a research to.
    expect(third!.textContent).not.toContain("我创建的");
  });
});
