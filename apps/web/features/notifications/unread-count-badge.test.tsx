import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The badge on the 消息 destination.
 *
 * The rule it exists to keep: **never render a number you do not have.** Four
 * different situations arrive as "nothing to show" — signed out, API down,
 * request failed, genuinely empty — and only the last of them is a real zero.
 * Drawing `0` for the other three would tell a reader their desk is clear when
 * nobody asked.
 *
 * The second half is that the bar is on every page, so the count must not cost
 * a feed: the endpoint returns one number, and the re-reads are bound to the
 * moments the answer can change rather than to a timer.
 */

const mocks = vi.hoisted(() => ({
  usePathname: vi.fn<() => string>(),
  getUnreadNotificationCount: vi.fn<() => Promise<number | null>>()
}));

vi.mock("next/navigation", () => ({ usePathname: mocks.usePathname }));
vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return {
    ...actual,
    getUnreadNotificationCount: () => mocks.getUnreadNotificationCount()
  };
});

const {
  UnreadCountBadge,
  useUnreadNotificationCount,
  notifyNotificationsChanged
} = await import("./unread-count-badge");

function Count() {
  const count = useUnreadNotificationCount();
  return <span data-testid="count">{count === null ? "null" : count}</span>;
}

beforeEach(() => {
  mocks.usePathname.mockReset();
  mocks.usePathname.mockReturnValue("/");
  mocks.getUnreadNotificationCount.mockReset();
});

afterEach(cleanup);

describe("UnreadCountBadge", () => {
  it("draws nothing when there is no count to draw", () => {
    render(<UnreadCountBadge count={null} />);
    expect(screen.queryByTestId("notifications-badge")).toBeNull();
  });

  it("draws nothing for a real zero", () => {
    render(<UnreadCountBadge count={0} />);
    expect(screen.queryByTestId("notifications-badge")).toBeNull();
  });

  it("shows the number", () => {
    render(<UnreadCountBadge count={3} />);
    expect(screen.getByTestId("notifications-badge").textContent).toBe("3");
  });

  it("caps the display but not the label", () => {
    render(<UnreadCountBadge count={150} />);
    const badge = screen.getByTestId("notifications-badge");
    // The digits are abbreviated so the bar keeps its width...
    expect(badge.textContent).toBe("99+");
    // ...but the accessible name still says the real figure.
    expect(badge.getAttribute("aria-label")).toBe("150 项待处理");
  });

  it("names the meaning rather than leaving a bare number to be read out", () => {
    render(<UnreadCountBadge count={1} />);
    expect(
      screen.getByTestId("notifications-badge").getAttribute("aria-label")
    ).toBe("1 项待处理");
  });
});

describe("useUnreadNotificationCount", () => {
  it("reads the count when the bar mounts", async () => {
    mocks.getUnreadNotificationCount.mockResolvedValue(4);

    render(<Count />);

    await act(async () => {});
    expect(screen.getByTestId("count").textContent).toBe("4");
  });

  it("stays null when the API says there is no account", async () => {
    mocks.getUnreadNotificationCount.mockResolvedValue(null);

    render(<Count />);

    await act(async () => {});
    expect(screen.getByTestId("count").textContent).toBe("null");
  });

  it("re-reads on navigation, because the answer may have changed", async () => {
    mocks.getUnreadNotificationCount.mockResolvedValue(1);
    mocks.usePathname.mockReturnValue("/history");

    const { rerender } = render(<Count />);
    await act(async () => {});
    expect(mocks.getUnreadNotificationCount).toHaveBeenCalledTimes(1);

    mocks.usePathname.mockReturnValue("/research");
    rerender(<Count />);
    await act(async () => {});

    expect(mocks.getUnreadNotificationCount).toHaveBeenCalledTimes(2);
  });

  it("re-reads when the tab regains focus", async () => {
    mocks.getUnreadNotificationCount.mockResolvedValue(2);
    render(<Count />);
    await act(async () => {});

    mocks.getUnreadNotificationCount.mockResolvedValue(0);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    expect(screen.getByTestId("count").textContent).toBe("0");
  });

  it("re-reads when the page marks an item read", async () => {
    mocks.getUnreadNotificationCount.mockResolvedValue(5);
    render(<Count />);
    await act(async () => {});
    expect(screen.getByTestId("count").textContent).toBe("5");

    mocks.getUnreadNotificationCount.mockResolvedValue(4);
    await act(async () => {
      notifyNotificationsChanged();
    });

    expect(screen.getByTestId("count").textContent).toBe("4");
  });

  it("does not poll: a settled tab makes no further requests", async () => {
    vi.useFakeTimers();
    mocks.getUnreadNotificationCount.mockResolvedValue(1);

    render(<Count />);
    await act(async () => {});
    const reads = mocks.getUnreadNotificationCount.mock.calls.length;

    await act(async () => {
      vi.advanceTimersByTime(600_000);
    });

    expect(mocks.getUnreadNotificationCount.mock.calls.length).toBe(reads);
    vi.useRealTimers();
  });
});
