import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The arena's history page, checked against the real component with only the
 * data access faked.
 *
 * What is pinned down here is the one destructive action on the page: the
 * delete button opens a confirmation, nothing is deleted until it is answered,
 * and dismissing it leaves the session exactly where it was. This page used to
 * be the only place in the app still leaning on `window.confirm`, which cannot
 * be styled, cannot be reached by a screen reader's dialog pattern, and blocks
 * the thread while it is up.
 */

const getCurrentUser = vi.fn();
const listSessions = vi.fn();
const deleteSession = vi.fn();

vi.mock("./api-client", () => ({
  getCurrentUser: (...args: unknown[]) => getCurrentUser(...args),
  listSessions: (...args: unknown[]) => listSessions(...args),
  deleteSession: (...args: unknown[]) => deleteSession(...args)
}));

const { SessionHistory } = await import("./session-history");
const { ApiTransportError } = await import("../../lib/api-transport");

const OWNER = { id: "owner-1", role: "owner" as const };
const VIEWER = { id: "viewer-1", role: "viewer" as const };
const REVIEWER = { id: "reviewer-1", role: "reviewer" as const };

function session(over: Record<string, unknown> = {}) {
  return {
    id: "s-1",
    projectName: "第四季度出货量核查",
    phase: "DECIDED",
    currentConclusion: "增长属实",
    conflictCount: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    relation: "owner",
    ...over
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** The list endpoint answers with a window, not a bare array. */
function page(
  sessions: unknown[],
  extra: { nextCursor?: string | null; hasNextPage?: boolean } = {}
) {
  return {
    sessions,
    nextCursor: extra.nextCursor ?? null,
    hasNextPage: extra.hasNextPage ?? false
  };
}

describe("SessionHistory", () => {
  it("offers delete to whoever owns the record, and to a global owner", async () => {
    // A global owner may delete any record.
    getCurrentUser.mockResolvedValue(OWNER);
    listSessions.mockResolvedValue(page([session({ relation: "granted" })]));
    render(<SessionHistory />);

    expect(await screen.findByRole("button", { name: "删除" })).toBeTruthy();

    // A viewer may not delete a record that belongs to somebody else.
    cleanup();
    getCurrentUser.mockResolvedValue(VIEWER);
    listSessions.mockResolvedValue(page([session({ relation: "granted" })]));
    render(<SessionHistory />);

    await waitFor(() => expect(screen.getByRole("heading", { level: 2 })).toBeTruthy());
    expect(screen.queryByRole("button", { name: "删除" })).toBeNull();

    // The person who created it may delete it, whatever their global role.
    // The button used to be gated on the global role alone, so a reviewer
    // was not offered the delete the backend would have allowed.
    cleanup();
    getCurrentUser.mockResolvedValue(REVIEWER);
    listSessions.mockResolvedValue(page([session({ relation: "owner" })]));
    render(<SessionHistory />);

    await waitFor(() => expect(screen.getByRole("heading", { level: 2 })).toBeTruthy());
    expect(screen.queryByRole("button", { name: "删除" })).toBeTruthy();
  });

  it("asks before deleting, and deletes nothing until it is answered", async () => {
    getCurrentUser.mockResolvedValue(OWNER);
    listSessions.mockResolvedValue(page([session()]));
    render(<SessionHistory />);

    fireEvent.click(await screen.findByRole("button", { name: "删除" }));
    const dialog = await screen.findByTestId("session-delete-dialog");

    // The question is explicit about what is lost, not just "are you sure".
    expect(dialog.textContent).toContain("永久删除");
    expect(dialog.textContent).toContain("无法恢复");
    expect(deleteSession).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));

    await waitFor(() => expect(screen.queryByTestId("session-delete-dialog")).toBeNull());
    expect(deleteSession).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(
      "第四季度出货量核查"
    );
  });

  it("deletes and drops the row once the deletion is confirmed", async () => {
    getCurrentUser.mockResolvedValue(OWNER);
    listSessions.mockResolvedValue(
      page([session(), session({ id: "s-2", projectName: "另一场评审" })])
    );
    deleteSession.mockResolvedValue(undefined);
    render(<SessionHistory />);

    fireEvent.click((await screen.findAllByRole("button", { name: "删除" }))[0]!);
    fireEvent.click(
      within(await screen.findByTestId("session-delete-dialog")).getByRole("button", {
        name: "删除"
      })
    );

    await waitFor(() => expect(deleteSession).toHaveBeenCalledWith("s-1"));
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "第四季度出货量核查" })).toBeNull()
    );
    expect(screen.getByRole("heading", { name: "另一场评审" })).toBeTruthy();
  });
});

/**
 * "Which of these are mine?"
 *
 * Every row on this page is readable, so the badge is not a permission — it is
 * the reason the row is here. Two researches can be equally readable and mean
 * completely different things: one the user made, one somebody handed to them.
 */
describe("SessionHistory — 来源", () => {
  it("每个卡片都说清自己为什么在这张列表上", async () => {
    getCurrentUser.mockResolvedValue(OWNER);
    listSessions.mockResolvedValue(
      page([
        session(),
        session({ id: "s-2", projectName: "别人分享的调研", relation: "granted" })
      ])
    );
    render(<SessionHistory />);

    const badges = await screen.findAllByTestId("relation-badge");
    expect(badges.map((node) => node.textContent)).toEqual([
      "我创建的",
      "共享给我"
    ]);
    // Machine-readable as well as human-readable: the test after this one
    // filters on this value, and a label change must not move the wire value.
    expect(badges[1]!.getAttribute("data-relation")).toBe("granted");
  });

  it("按来源筛选走服务端，带 relation 参数重新取数", async () => {
    getCurrentUser.mockResolvedValue(OWNER);
    listSessions.mockResolvedValue(
      page([
        session(),
        session({ id: "s-2", projectName: "别人分享的调研", relation: "granted" })
      ])
    );
    render(<SessionHistory />);

    fireEvent.click(await screen.findByTestId("relation-filter-granted"));

    // The parameter, not a client-side slice of the rows already loaded: a
    // page holds at most fifty rows, so filtering here would answer "none
    // shared with you" whenever the shared ones sit beyond page one.
    await waitFor(() =>
      expect(listSessions).toHaveBeenLastCalledWith({ relation: "granted" })
    );
  });

  it("筛选后为空时不说「还没有评审记录」", async () => {
    getCurrentUser.mockResolvedValue(OWNER);
    listSessions
      .mockResolvedValueOnce(
        page([
          session(),
          session({ id: "s-2", projectName: "别人分享的调研", relation: "granted" })
        ])
      )
      .mockResolvedValue(page([]));
    render(<SessionHistory />);

    fireEvent.click(await screen.findByTestId("relation-filter-granted"));

    const empty = await screen.findByTestId("history-filter-empty");
    expect(empty.textContent).toContain("没有「共享给我」的记录");
    // The sentence that would contradict the two rows the user just saw.
    expect(screen.queryByText("还没有评审记录")).toBeNull();

    // And the filter can be undone from the empty state itself.
    fireEvent.click(within(empty).getByRole("button", { name: "清除筛选" }));
    await waitFor(() =>
      expect(listSessions).toHaveBeenLastCalledWith({})
    );
  });

  it("没有身份系统时不编造来源，也不画筛选", async () => {
    getCurrentUser.mockResolvedValue(null);
    // `relation: null` is what the server sends for an operator deployment:
    // there are no accounts, so there is nobody to attribute a research to.
    listSessions.mockResolvedValue(
      page([
        session({ relation: null }),
        session({ id: "s-2", projectName: "第二场", relation: null })
      ])
    );
    render(<SessionHistory />);

    expect(await screen.findByRole("heading", { name: "第四季度出货量核查" })).toBeTruthy();
    expect(screen.queryAllByTestId("relation-badge")).toHaveLength(0);
    expect(screen.queryByTestId("relation-filter")).toBeNull();
  });
});

/**
 * 分页。
 *
 * 头部以前印的是「{n} SESSIONS」——一个页大小，被排版成总数。现在有下一页时
 * 说「已加载」，没有下一页时说「共」，并且第二页是追加而不是替换。
 */
describe("SessionHistory · 分页", () => {
  it("says 已加载 while a further page exists, 共 once it does not", async () => {
    getCurrentUser.mockResolvedValue(OWNER);
    listSessions.mockResolvedValue(page([session()], { hasNextPage: true, nextCursor: "c1" }));
    render(<SessionHistory />);

    await screen.findByRole("heading", { level: 2 });
    expect(screen.getByText("已加载 1 项")).toBeTruthy();

    cleanup();
    listSessions.mockResolvedValue(page([session()]));
    render(<SessionHistory />);

    await screen.findByRole("heading", { level: 2 });
    expect(screen.getByText("共 1 项")).toBeTruthy();
  });

  it("appends the next page instead of replacing the rows already shown", async () => {
    getCurrentUser.mockResolvedValue(OWNER);
    listSessions
      .mockResolvedValueOnce(page([session()], { nextCursor: "c1", hasNextPage: true }))
      .mockResolvedValueOnce(page([session({ id: "s-2", projectName: "更早的评审" })]));
    render(<SessionHistory />);

    fireEvent.click(await screen.findByTestId("session-history-more"));

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "更早的评审" })).toBeTruthy()
    );
    expect(screen.getByRole("heading", { name: "第四季度出货量核查" })).toBeTruthy();
    expect(listSessions).toHaveBeenLastCalledWith({ after: "c1" });
    expect(screen.queryByTestId("session-history-more")).toBeNull();
  });
});

/**
 * 未登录不是「服务故障」。
 *
 * 列表是按账户隔离的，所以匿名的读会被答 401。以前这个 401 和其它失败共用
 * 一个字符串槽，页面上就写成了「操作失败 / Authentication required」——半句
 * 中文半句英文，说成点击失败了，而且没有任何出路。这里把三种情况钉住。
 */
describe("SessionHistory · 读取失败的分支", () => {
  function signInError() {
    return new ApiTransportError("http", "Authentication required", { status: 401 });
  }

  it("未登录时请人登录，而不是报服务故障", async () => {
    getCurrentUser.mockResolvedValue(null);
    listSessions.mockRejectedValue(signInError());
    render(<SessionHistory />);

    const panel = await screen.findByTestId("history-load-error");
    expect(panel.textContent).toContain("需要登录");
    expect(panel.textContent).toContain("去登录");

    // Neither of the other two stories may be told instead.
    expect(panel.textContent).not.toContain("Authentication required");
    expect(panel.textContent).not.toContain("4100");
    expect(panel.textContent).not.toContain("操作失败");
  });

  it("连不上时不印端口号，只给一个能重试的按钮", async () => {
    getCurrentUser.mockResolvedValue(null);
    listSessions.mockRejectedValue(new Error("无法连接到核心 API"));
    render(<SessionHistory />);

    const panel = await screen.findByTestId("history-load-error");
    expect(panel.textContent).toContain("无法加载历史记录");
    expect(screen.getByRole("button", { name: "重新加载" })).toBeTruthy();
    expect(panel.textContent).not.toContain("4100");
    expect(panel.textContent).not.toContain("需要登录");
  });

  it("读取失败时不把 0 当成总数印在标题旁", async () => {
    getCurrentUser.mockResolvedValue(null);
    listSessions.mockRejectedValue(new Error("boom"));
    render(<SessionHistory />);

    await screen.findByTestId("history-load-error");
    expect(screen.queryByText("共 0 项")).toBeNull();
    expect(screen.queryByText("已加载 0 项")).toBeNull();
  });

  it("空列表给出去处，而不只是告诉人这里空", async () => {
    getCurrentUser.mockResolvedValue(OWNER);
    listSessions.mockResolvedValue(page([]));
    render(<SessionHistory />);

    const empty = await screen.findByText("还没有评审记录");
    expect(empty).toBeTruthy();
    const cta = screen.getByRole("link", { name: "新建评审" });
    expect(cta.getAttribute("href")).toBe("/sessions/new");
  });
});
