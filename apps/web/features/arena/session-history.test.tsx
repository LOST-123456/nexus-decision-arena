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

const OWNER = { id: "owner-1", role: "owner" as const };
const VIEWER = { id: "viewer-1", role: "viewer" as const };

function session(over: Record<string, unknown> = {}) {
  return {
    id: "s-1",
    projectName: "第四季度出货量核查",
    phase: "DECIDED",
    currentConclusion: "增长属实",
    conflictCount: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SessionHistory", () => {
  it("offers delete only to an owner", async () => {
    getCurrentUser.mockResolvedValue(OWNER);
    listSessions.mockResolvedValue([session()]);
    render(<SessionHistory />);

    expect(await screen.findByRole("button", { name: "删除" })).toBeTruthy();

    cleanup();
    getCurrentUser.mockResolvedValue(VIEWER);
    render(<SessionHistory />);

    await waitFor(() => expect(screen.getByRole("heading", { level: 2 })).toBeTruthy());
    expect(screen.queryByRole("button", { name: "删除" })).toBeNull();
  });

  it("asks before deleting, and deletes nothing until it is answered", async () => {
    getCurrentUser.mockResolvedValue(OWNER);
    listSessions.mockResolvedValue([session()]);
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
    listSessions.mockResolvedValue([session(), session({ id: "s-2", projectName: "另一场评审" })]);
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
