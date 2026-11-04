import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiTransportError } from "../../lib/api-transport";

/**
 * The workspace header, checked against the real component with only data
 * access faked.
 *
 * The research question was display-only: it could be set once, when the
 * research was created, and a research whose question was never filled in said
 * "（未填写研究问题）" in the workspace and in every report it produced, with no
 * way to correct it.
 */

const SESSION_ID = "0199e6d0-0000-7000-8000-000000000001";

const getResearchWorkspace = vi.fn();
const updateResearchQuestion = vi.fn();
const listLibrarySessions = vi.fn();
const getEvents = vi.fn();
const getCurrentUser = vi.fn();

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return {
    ...actual,
    getResearchWorkspace: (...args: unknown[]) => getResearchWorkspace(...args),
    updateResearchQuestion: (...args: unknown[]) =>
      updateResearchQuestion(...args),
    listLibrarySessions: (...args: unknown[]) => listLibrarySessions(...args),
    getEvents: (...args: unknown[]) => getEvents(...args)
  };
});

vi.mock("../arena/api-client", () => ({
  getCurrentUser: (...args: unknown[]) => getCurrentUser(...args)
}));

vi.mock("next/navigation", () => ({
  usePathname: () => `/research/${SESSION_ID}`
}));

const { ResearchWorkspace } = await import("./research-workspace");

function workspace(researchQuestion: string | null) {
  return {
    session: {
      id: SESSION_ID,
      phase: "ANALYSIS",
      operationalStatus: "ACTIVE",
      researchQuestion,
      currentConclusion: null,
      title: "第四季度出货量"
    },
    claims: [],
    evidence: [],
    sources: [],
    conflicts: [],
    challenges: [],
    agentRuns: [],
    reviews: [],
    verdicts: [],
    gaps: [],
    openReviewRequests: [],
    summary: {
      claims: 0,
      evidence: 0,
      sources: 0,
      challenges: 0,
      unresolvedChallenges: 0,
      reviews: 0,
      failedRuns: 0,
      verified: 0,
      unverified: 0,
      rejected: 0,
      openVerdicts: 0,
      needsMoreEvidence: 0,
      blockingGaps: 0
    }
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  listLibrarySessions.mockResolvedValue({ sessions: [] });
  getEvents.mockResolvedValue([]);
  // The backend only hands a session to somebody who may read it, and an
  // anonymous caller gets none - so an editable session always belongs to
  // somebody signed in. The edit control follows the role, not the absence
  // of one.
  getCurrentUser.mockResolvedValue({
    id: "u-9",
    username: "owner",
    role: "owner"
  });
});

afterEach(() => {
  cleanup();
});

describe("research question editing", () => {
  it("offers to fill in a question that was never recorded", async () => {
    getResearchWorkspace.mockResolvedValue(workspace(null));
    render(<ResearchWorkspace sessionId={SESSION_ID} />);

    await waitFor(() =>
      expect(screen.getByTestId("edit-research-question")).toBeTruthy()
    );
    // The button says what it will do, because the field is empty.
    expect(screen.getByTestId("edit-research-question").textContent).toContain(
      "填写研究问题"
    );
    expect(screen.getByText("（未填写研究问题）")).toBeTruthy();
  });

  it("saves the trimmed question and shows what was stored", async () => {
    getResearchWorkspace.mockResolvedValue(workspace(null));
    updateResearchQuestion.mockResolvedValue({
      sessionId: SESSION_ID,
      researchQuestion: "第四季度出货量是否真实增长？"
    });
    render(<ResearchWorkspace sessionId={SESSION_ID} />);
    await waitFor(() =>
      expect(screen.getByTestId("edit-research-question")).toBeTruthy()
    );

    fireEvent.click(screen.getByTestId("edit-research-question"));
    fireEvent.change(screen.getByTestId("research-question-input"), {
      target: { value: "  第四季度出货量是否真实增长？  " }
    });
    getResearchWorkspace.mockResolvedValue(
      workspace("第四季度出货量是否真实增长？")
    );
    fireEvent.click(screen.getByTestId("save-research-question"));

    await waitFor(() =>
      expect(updateResearchQuestion).toHaveBeenCalledWith(
        SESSION_ID,
        "第四季度出货量是否真实增长？"
      )
    );
    await waitFor(() =>
      expect(screen.getByText("第四季度出货量是否真实增长？")).toBeTruthy()
    );
    expect(screen.queryByTestId("research-question-form")).toBeNull();
  });

  it("refuses to save an empty question", async () => {
    getResearchWorkspace.mockResolvedValue(workspace("原来的问题"));
    render(<ResearchWorkspace sessionId={SESSION_ID} />);
    await waitFor(() =>
      expect(screen.getByTestId("edit-research-question")).toBeTruthy()
    );

    fireEvent.click(screen.getByTestId("edit-research-question"));
    fireEvent.change(screen.getByTestId("research-question-input"), {
      target: { value: "   " }
    });
    fireEvent.click(screen.getByTestId("save-research-question"));

    await waitFor(() =>
      expect(screen.getByTestId("research-question-error")).toBeTruthy()
    );
    expect(updateResearchQuestion).not.toHaveBeenCalled();
  });

  it("keeps the draft when the save is refused, and says why", async () => {
    getResearchWorkspace.mockResolvedValue(workspace("原来的问题"));
    updateResearchQuestion.mockRejectedValue(
      new Error("Only a researcher on this session may edit it")
    );
    render(<ResearchWorkspace sessionId={SESSION_ID} />);
    await waitFor(() =>
      expect(screen.getByTestId("edit-research-question")).toBeTruthy()
    );

    fireEvent.click(screen.getByTestId("edit-research-question"));
    fireEvent.change(screen.getByTestId("research-question-input"), {
      target: { value: "改过的问题" }
    });
    fireEvent.click(screen.getByTestId("save-research-question"));

    await waitFor(() =>
      expect(screen.getByTestId("research-question-error").textContent).toContain(
        "Only a researcher on this session may edit it"
      )
    );
    // Nothing the user typed is lost to the refusal.
    expect(
      (screen.getByTestId("research-question-input") as HTMLTextAreaElement).value
    ).toBe("改过的问题");
  });

  it("offers no edit control to a viewer", async () => {
    getResearchWorkspace.mockResolvedValue(workspace("原来的问题"));
    getCurrentUser.mockResolvedValue({ id: "u-1", username: "v", role: "viewer" });
    render(<ResearchWorkspace sessionId={SESSION_ID} />);

    await waitFor(() => expect(screen.getByText("原来的问题")).toBeTruthy());
    expect(screen.queryByTestId("edit-research-question")).toBeNull();
  });

  it("offers no edit control to an anonymous reader", async () => {
    // The button used to appear for anyone who was not signed in, and for
    // anyone whose /api/auth/me call had failed - both of which could only
    // ever end in a 401. A control that cannot succeed is not an offer.
    getResearchWorkspace.mockResolvedValue(workspace("原来的问题"));
    getCurrentUser.mockResolvedValue(null);
    render(<ResearchWorkspace sessionId={SESSION_ID} />);

    await waitFor(() => expect(screen.getByText("原来的问题")).toBeTruthy());
    expect(screen.queryByTestId("edit-research-question")).toBeNull();
  });
});

/**
 * Research reads are owner-scoped, so 401 is the ordinary answer for a visitor
 * who is not signed in. Saying "确认后端已启动并完成 0005 迁移" to that visitor
 * describes a problem they do not have, and offers a retry that cannot help.
 */
describe("research workspace when the caller is not signed in", () => {
  it("asks for a login instead of blaming the backend", async () => {
    getResearchWorkspace.mockRejectedValue(
      new ApiTransportError("http", "Authentication required", {
        status: 401,
        payload: { error: "Authentication required" }
      })
    );

    render(<ResearchWorkspace sessionId={SESSION_ID} />);

    expect(await screen.findByTestId("research-sign-in-required")).toBeTruthy();
    expect(screen.getByRole("link", { name: "去登录" }).getAttribute("href")).toBe(
      "/login"
    );
    // Retrying the same unauthenticated request answers 401 again.
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
    expect(screen.queryByTestId("research-not-found")).toBeNull();
    expect(screen.queryByTestId("research-load-error")).toBeNull();
    expect(screen.queryByText(/0005 迁移/)).toBeNull();
    expect(screen.queryByText(/Authentication required/)).toBeNull();
  });
});
