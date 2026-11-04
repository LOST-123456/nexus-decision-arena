import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LibrarySourceDetailSchema,
  LibrarySourceSummarySchema,
  ShareGrantSchema,
  type LibrarySourceSummary
} from "@nexus/shared";

/**
 * The rules of the cross-research library surface, checked against the real
 * component.
 *
 * Only the data access is faked. What these tests pin down is the honesty
 * contract: the panel never presents research the account may not see, it
 * distinguishes "you may browse" from "you may copy" *before* the button is
 * pressed, it says out loud that a copy carries no verification, a duplicate
 * names the row that already exists instead of just refusing, a source with no
 * capture offers the reference route rather than a dead end, revoking a share
 * says that copies and audit survive, and a read-only account is told it is
 * read-only instead of being offered controls that would fail.
 */

const copyLibrarySource = vi.fn();
const createShareGrant = vi.fn();
const getCopyLineage = vi.fn();
const getLibrarySource = vi.fn();
const getCurrentUser = vi.fn();
const listLibrarySessions = vi.fn();
const listShareGrants = vi.fn();
const readLibrarySnapshot = vi.fn();
const revokeShareGrant = vi.fn();
const searchLibrarySources = vi.fn();

class LibraryFailedError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly duplicate?: { sourceId: string; title: string; canonicalUrl: string | null; reason: string }
  ) {
    super(message);
    this.name = "LibraryFailedError";
  }
}

vi.mock("./api", () => ({
  LibraryFailedError,
  copyLibrarySource: (...args: unknown[]) => copyLibrarySource(...args),
  createShareGrant: (...args: unknown[]) => createShareGrant(...args),
  getCopyLineage: (...args: unknown[]) => getCopyLineage(...args),
  getLibrarySource: (...args: unknown[]) => getLibrarySource(...args),
  listLibrarySessions: (...args: unknown[]) => listLibrarySessions(...args),
  listShareGrants: (...args: unknown[]) => listShareGrants(...args),
  readLibrarySnapshot: (...args: unknown[]) => readLibrarySnapshot(...args),
  revokeShareGrant: (...args: unknown[]) => revokeShareGrant(...args),
  searchLibrarySources: (...args: unknown[]) => searchLibrarySources(...args)
}));

// The signed-in identity is data access too, and stubbed for the same reason:
// the panel asks the server who it is when no role was handed to it.
vi.mock("../arena/api-client", () => ({
  getCurrentUser: () => getCurrentUser()
}));

const { SourceLibraryPanel } = await import("./source-library");

const OWN_SESSION = "0199e6d0-0000-7000-8000-000000000001";
const SHARED_READ_SESSION = "0199e6d0-0000-7000-8000-000000000002";
const SHARED_COPY_SESSION = "0199e6d0-0000-7000-8000-000000000003";
const OWN_SOURCE = "0199e6d0-0000-7000-8000-000000000011";
const SHARED_SOURCE = "0199e6d0-0000-7000-8000-000000000012";
const COPY_SOURCE = "0199e6d0-0000-7000-8000-000000000013";
const SNAPSHOT_ID = "0199e6d0-0000-7000-8000-000000000021";
const GRANT_ID = "0199e6d0-0000-7000-8000-000000000031";
const UPDATED_AT = "2026-10-12T09:30:00.000Z";

function sessionFixture(overrides: {
  sessionId: string;
  access: "own" | "granted";
  researchQuestion: string;
  grantScope?: "read" | "copy";
  sourceCount?: number;
}) {
  return {
    sessionId: overrides.sessionId,
    researchQuestion: overrides.researchQuestion,
    access: overrides.access,
    ...(overrides.access === "granted"
      ? { grantId: GRANT_ID, ...(overrides.grantScope ? { grantScope: overrides.grantScope } : {}) }
      : {}),
    sourceCount: overrides.sourceCount ?? 1,
    updatedAt: UPDATED_AT
  };
}

function sourceFixture(overrides: {
  sourceId: string;
  sessionId: string;
  title: string;
  snapshotCount?: number;
  alreadyCopied?: boolean;
}): LibrarySourceSummary {
  return LibrarySourceSummarySchema.parse({
    sourceId: overrides.sourceId,
    sessionId: overrides.sessionId,
    title: overrides.title,
    kind: "url",
    url: "https://example.org/q4",
    canonicalUrl: "https://example.org/q4",
    publisher: "统计年报",
    author: "统计处",
    languages: ["zh"],
    snapshotCount: overrides.snapshotCount ?? 1,
    latestSnapshotAt: UPDATED_AT,
    contentHash: "a".repeat(64),
    retrievalStatus: "fetched",
    alreadyCopied: overrides.alreadyCopied ?? false
  });
}

function grantFixture(overrides: {
  id?: string;
  subjectId?: string;
  scope?: "read" | "copy";
  revoked?: boolean;
}) {
  return ShareGrantSchema.parse({
    id: overrides.id ?? GRANT_ID,
    sessionId: OWN_SESSION,
    subjectType: "user",
    subjectId: overrides.subjectId ?? "user-2",
    scope: overrides.scope ?? "copy",
    grantedBy: "Owner (owner)",
    grantedAt: UPDATED_AT,
    ...(overrides.revoked
      ? { revokedAt: UPDATED_AT, revokedBy: "Owner (owner)", revokeReason: "研究已结束" }
      : {})
  });
}

function primeLibrary(overrides: {
  sessions?: ReturnType<typeof sessionFixture>[];
  sources?: LibrarySourceSummary[];
  total?: number;
  lineage?: Record<string, unknown>;
  grants?: unknown[];
} = {}) {
  listLibrarySessions.mockResolvedValue({
    sessions: overrides.sessions ?? [
      sessionFixture({
        sessionId: OWN_SESSION,
        access: "own",
        researchQuestion: "我的研究"
      })
    ]
  });
  searchLibrarySources.mockResolvedValue({
    sources: overrides.sources ?? [
      sourceFixture({ sourceId: OWN_SOURCE, sessionId: OWN_SESSION, title: "季度回顾" })
    ],
    total: overrides.total ?? (overrides.sources?.length ?? 1)
  });
  getCopyLineage.mockResolvedValue({ lineage: overrides.lineage ?? {} });
  listShareGrants.mockResolvedValue({ grants: overrides.grants ?? [] });
}

async function settle() {
  await waitFor(() => expect(searchLibrarySources).toHaveBeenCalled());
  await waitFor(() => expect(listLibrarySessions).toHaveBeenCalled());
}

beforeEach(() => {
  for (const fn of [
    copyLibrarySource,
    createShareGrant,
    getCopyLineage,
    getLibrarySource,
    getCurrentUser,
    listLibrarySessions,
    listShareGrants,
    readLibrarySnapshot,
    revokeShareGrant,
    searchLibrarySources
  ]) {
    fn.mockReset();
  }
  // No role handed to the panel unless a test says otherwise: the account the
  // server reports is a writer, so the panel offers its controls.
  getCurrentUser.mockResolvedValue({
    id: "user-1",
    username: "owner",
    displayName: "Owner",
    role: "owner"
  });
});

afterEach(cleanup);

describe("cross-research library panel", () => {
  it("lists only the researches the account may see, with how it may use each", async () => {
    primeLibrary({
      sessions: [
        sessionFixture({ sessionId: OWN_SESSION, access: "own", researchQuestion: "我的研究" }),
        sessionFixture({
          sessionId: SHARED_READ_SESSION,
          access: "granted",
          researchQuestion: "同事的研究",
          grantScope: "read"
        }),
        sessionFixture({
          sessionId: SHARED_COPY_SESSION,
          access: "granted",
          researchQuestion: "可复制的研究",
          grantScope: "copy"
        })
      ]
    });
    render(<SourceLibraryPanel currentSessionId={OWN_SESSION} />);
    await settle();

    const sessions = screen.getByTestId("library-sessions");
    expect(sessions.textContent).toContain("我的研究");
    expect(sessions.textContent).toContain("自有");
    // "granted" alone would hide whether the material may also be copied.
    expect(sessions.textContent).toContain("被授权 · 可浏览");
    expect(sessions.textContent).toContain("被授权 · 可浏览并复制");
    expect(screen.queryByTestId("library-error")).toBeNull();
  });

  it("offers the copy control only where copying is actually permitted", async () => {
    primeLibrary({
      sessions: [
        sessionFixture({ sessionId: OWN_SESSION, access: "own", researchQuestion: "我的研究" }),
        sessionFixture({
          sessionId: SHARED_READ_SESSION,
          access: "granted",
          researchQuestion: "同事的研究",
          grantScope: "read"
        }),
        sessionFixture({
          sessionId: SHARED_COPY_SESSION,
          access: "granted",
          researchQuestion: "可复制的研究",
          grantScope: "copy"
        })
      ],
      sources: [
        sourceFixture({ sourceId: OWN_SOURCE, sessionId: OWN_SESSION, title: "我的来源" }),
        sourceFixture({
          sourceId: SHARED_SOURCE,
          sessionId: SHARED_READ_SESSION,
          title: "只读来源"
        }),
        sourceFixture({
          sourceId: COPY_SOURCE,
          sessionId: SHARED_COPY_SESSION,
          title: "可复制来源"
        })
      ]
    });
    render(<SourceLibraryPanel currentSessionId={OWN_SESSION} />);
    await settle();

    const rows = screen.getAllByTestId("library-row");
    expect(rows).toHaveLength(3);
    const buttons = screen.getAllByTestId("library-copy");
    expect(buttons).toHaveLength(3);

    // Own and copy-granted material may travel; read-granted material may not,
    // and the control says so before it is pressed rather than failing after.
    expect((buttons[0] as HTMLButtonElement).disabled).toBe(false);
    expect((buttons[1] as HTMLButtonElement).disabled).toBe(true);
    expect((buttons[1] as HTMLButtonElement).getAttribute("title")).toContain(
      "只授予了浏览权限"
    );
    expect((buttons[2] as HTMLButtonElement).disabled).toBe(false);
  });

  it("says out loud that a copy carries no verification, and reloads the target", async () => {
    primeLibrary();
    copyLibrarySource.mockResolvedValue({
      sourceId: COPY_SOURCE,
      sessionId: OWN_SESSION,
      mode: "copy",
      copy: { originStatus: "current", forkState: "synced" }
    });
    const onChanged = vi.fn().mockResolvedValue(undefined);

    render(
      <SourceLibraryPanel currentSessionId={OWN_SESSION} onChanged={onChanged} />
    );
    await settle();
    fireEvent.click(screen.getByTestId("library-copy"));

    await waitFor(() => expect(copyLibrarySource).toHaveBeenCalled());
    expect(copyLibrarySource).toHaveBeenCalledWith(OWN_SESSION, {
      sourceSessionId: OWN_SESSION,
      sourceId: OWN_SOURCE,
      mode: "copy"
    });
    const message = await screen.findByTestId("library-message");
    // The single most dangerous misunderstanding this panel could cause is
    // that copying material also copies its verification. It must not be left
    // to inference.
    expect(message.textContent).toContain("未核实");
    expect(message.textContent).toContain("重新登记证据");
    expect(onChanged).toHaveBeenCalled();
  });

  it("does not reload a research this workspace is not showing", async () => {
    primeLibrary({
      sessions: [
        sessionFixture({ sessionId: OWN_SESSION, access: "own", researchQuestion: "我的研究" }),
        sessionFixture({
          sessionId: SHARED_COPY_SESSION,
          access: "granted",
          researchQuestion: "可复制的研究",
          grantScope: "copy"
        })
      ]
    });
    copyLibrarySource.mockResolvedValue({ sourceId: COPY_SOURCE, sessionId: SHARED_COPY_SESSION, mode: "copy" });
    const onChanged = vi.fn().mockResolvedValue(undefined);

    render(
      <SourceLibraryPanel currentSessionId={SHARED_COPY_SESSION} onChanged={onChanged} />
    );
    await settle();

    // Point the target at the *other* research this account owns.
    fireEvent.change(screen.getByTestId("library-target"), {
      target: { value: OWN_SESSION }
    });
    fireEvent.click(screen.getByTestId("library-copy"));

    await waitFor(() => expect(copyLibrarySource).toHaveBeenCalled());
    expect(copyLibrarySource.mock.calls[0]?.[0]).toBe(OWN_SESSION);
    // The workspace is showing a different research, so there is nothing here
    // to refresh — a copy elsewhere is not this research's state.
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("names the row that already exists when a duplicate is refused", async () => {
    primeLibrary();
    copyLibrarySource.mockRejectedValue(
      new LibraryFailedError(
        "duplicate",
        "duplicate_source",
        {
          sourceId: SHARED_SOURCE,
          title: "Q4 年报",
          canonicalUrl: "https://example.org/q4",
          reason: "canonical_url"
        }
      )
    );
    render(<SourceLibraryPanel currentSessionId={OWN_SESSION} />);
    await settle();
    fireEvent.click(screen.getByTestId("library-copy"));

    const message = await screen.findByTestId("library-message");
    // "Duplicate" with no way forward is not an answer.
    expect(message.textContent).toContain("Q4 年报");
    expect(message.textContent).toContain("不会重复保存");
    expect(screen.queryByTestId("library-error")).toBeNull();
  });

  it("offers the reference route when a source has no capture to copy", async () => {
    primeLibrary({
      sources: [
        sourceFixture({
          sourceId: OWN_SOURCE,
          sessionId: OWN_SESSION,
          title: "尚未抓取的通告",
          snapshotCount: 0
        })
      ]
    });
    copyLibrarySource.mockRejectedValue(
      new LibraryFailedError("no capture", "source_has_no_capture")
    );
    render(<SourceLibraryPanel currentSessionId={OWN_SESSION} />);
    await settle();

    // A source with no stored text is still placeable in a research, so the
    // panel offers that route instead of a dead end.
    expect(
      screen.getByRole("button", { name: "仅引用" })
    ).toBeTruthy();
    fireEvent.click(screen.getByTestId("library-copy"));

    const error = await screen.findByTestId("library-error");
    expect(error.textContent).toContain("仅引用");
  });

  it("reads a stored version and reports the copy lineage it already has", async () => {
    primeLibrary({
      lineage: {
        [OWN_SOURCE]: {
          sessionId: OWN_SESSION,
          sourceId: OWN_SOURCE,
          originSessionId: SHARED_READ_SESSION,
          originSourceId: SHARED_SOURCE,
          originSnapshotHash: "a".repeat(64),
          copiedBy: "Owner (owner)",
          copiedAt: UPDATED_AT,
          forkState: "synced",
          originStatus: "changed"
        }
      }
    });
    getLibrarySource.mockResolvedValue(
      LibrarySourceDetailSchema.parse({
        ...sourceFixture({ sourceId: OWN_SOURCE, sessionId: OWN_SESSION, title: "季度回顾" }),
        versions: [
          {
            snapshotId: SNAPSHOT_ID,
            contentHash: "a".repeat(64),
            title: "季度回顾",
            contentType: "text/html; charset=utf-8",
            contentBytes: 24,
            charCount: 12,
            sourceLanguage: "zh",
            retrievedAt: UPDATED_AT
          }
        ]
      })
    );
    readLibrarySnapshot.mockResolvedValue({
      snapshotId: SNAPSHOT_ID,
      contentHash: "a".repeat(64),
      content: "第四季度出货量同比增长 12%。"
    });

    render(<SourceLibraryPanel currentSessionId={OWN_SESSION} />);
    await settle();

    // The row already says where the material came from and that the origin
    // has moved on — a copy is never silently "the same as the original".
    const pill = await screen.findByTestId("library-copy-pill");
    expect(pill.textContent).toContain("副本");
    expect(pill.textContent).toContain("原研究已更新");

    fireEvent.click(screen.getByRole("button", { name: "查看原文与版本" }));
    await waitFor(() => expect(getLibrarySource).toHaveBeenCalledWith(OWN_SOURCE));
    fireEvent.click(await screen.findByRole("button", { name: "阅读该版本" }));

    const content = await screen.findByTestId("library-snapshot-content");
    await waitFor(() =>
      expect(content.textContent).toContain("第四季度出货量同比增长 12%。")
    );
  });

  it("revokes a share without claiming the copies disappear", async () => {
    primeLibrary({
      grants: [grantFixture({ id: GRANT_ID, scope: "read" })]
    });
    revokeShareGrant.mockResolvedValue(
      grantFixture({ id: GRANT_ID, scope: "read", revoked: true })
    );

    render(<SourceLibraryPanel currentSessionId={OWN_SESSION} />);
    await settle();

    const rows = await screen.findAllByTestId("library-grant-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain("可浏览");

    fireEvent.click(screen.getByTestId("library-grant-revoke"));

    // Revoking takes another account's access away, so the confirmation is not
    // decoration: nothing leaves this panel until it is answered.
    const dialog = await screen.findByTestId("library-grant-revoke-dialog");
    expect(revokeShareGrant).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "撤销" }));

    await waitFor(() => expect(revokeShareGrant).toHaveBeenCalled());
    expect(revokeShareGrant).toHaveBeenCalledWith(GRANT_ID, "撤销共享");
    const message = await screen.findByTestId("library-message");
    expect(message.textContent).toContain("副本与审计记录保留");
  });

  it("leaves the grant alone when the revocation is dismissed", async () => {
    primeLibrary({
      grants: [grantFixture({ id: GRANT_ID, scope: "read" })]
    });

    render(<SourceLibraryPanel currentSessionId={OWN_SESSION} />);
    await settle();

    fireEvent.click(await screen.findByTestId("library-grant-revoke"));
    const dialog = await screen.findByTestId("library-grant-revoke-dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));

    await waitFor(() => expect(screen.queryByTestId("library-grant-revoke-dialog")).toBeNull());
    expect(revokeShareGrant).not.toHaveBeenCalled();
  });

  it("空授权对象不静默返回，而是说明缺什么", async () => {
    primeLibrary();

    render(<SourceLibraryPanel currentSessionId={OWN_SESSION} />);
    await settle();

    // 以前这里直接 return：不发请求、不报错，按钮看起来就是坏的。
    fireEvent.submit(screen.getByTestId("library-grant-form"));

    const error = await screen.findByRole("alert");
    expect(error.textContent).toContain("请填写要授权的账号");
    expect(createShareGrant).not.toHaveBeenCalled();
  });

  it("asks for a username and says an unresolvable subject is refused, not filed", async () => {
    primeLibrary();
    createShareGrant.mockResolvedValue(grantFixture({ id: GRANT_ID, scope: "read" }));

    render(<SourceLibraryPanel currentSessionId={OWN_SESSION} />);
    await settle();

    // The form must not promise something the server cannot do: a username is
    // the normal thing to type, and a subject naming nothing is refused rather
    // than stored as a grant that could never match.
    const hint = await screen.findByTestId("library-subject-hint");
    expect(hint.textContent).toContain("匹配不到账号的授权会被拒绝");

    fireEvent.change(screen.getByLabelText("账号用户名或 ID"), {
      target: { value: "reviewer-two" }
    });
    fireEvent.submit(screen.getByTestId("library-grant-form"));

    await waitFor(() => expect(createShareGrant).toHaveBeenCalled());
    expect(createShareGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: OWN_SESSION,
        subjectType: "user",
        subjectId: "reviewer-two",
        scope: "read"
      })
    );
  });

  it("reports an already-revoked grant as history rather than offering the control again", async () => {
    primeLibrary({
      grants: [grantFixture({ id: GRANT_ID, scope: "copy", revoked: true })]
    });

    render(<SourceLibraryPanel currentSessionId={OWN_SESSION} />);
    await settle();

    const row = (await screen.findAllByTestId("library-grant-row"))[0];
    expect(row?.textContent).toContain("已撤销");
    expect(screen.queryByTestId("library-grant-revoke")).toBeNull();
  });

  it("tells a read-only account it is read-only instead of offering dead controls", async () => {
    primeLibrary({
      sessions: [
        sessionFixture({
          sessionId: SHARED_COPY_SESSION,
          access: "granted",
          researchQuestion: "可复制的研究",
          grantScope: "copy"
        })
      ]
    });

    render(<SourceLibraryPanel canEdit={false} />);
    await settle();

    expect(screen.getByTestId("library-readonly")).toBeTruthy();
    expect((screen.getByTestId("library-copy") as HTMLButtonElement).disabled).toBe(
      true
    );
    // Nothing may be written by a read-only account, so no sharing form either.
    expect(screen.queryByTestId("library-grants")).toBeNull();
  });

  it("works out for itself that a viewer may not write", async () => {
    // An own research with an own source and itself as the copy target: every
    // other reason the control could be off is absent, so what is left is the
    // role.
    primeLibrary();
    // The standalone library page has no session to read a role from, so the
    // panel asks the server. Being handed no role must not become a licence to
    // offer controls the account cannot use.
    getCurrentUser.mockResolvedValue({
      id: "user-9",
      username: "viewer",
      displayName: "Viewer",
      role: "viewer"
    });

    render(<SourceLibraryPanel currentSessionId={OWN_SESSION} />);
    await settle();

    await waitFor(() =>
      expect((screen.getByTestId("library-copy") as HTMLButtonElement).disabled).toBe(
        true
      )
    );
    expect(screen.getByTestId("library-readonly")).toBeTruthy();
    expect(screen.queryByTestId("library-grants")).toBeNull();
  });

  it("sends the filters it was given, and states a failure with its retry intact", async () => {
    primeLibrary();
    render(<SourceLibraryPanel currentSessionId={OWN_SESSION} />);
    await settle();

    // The language filter's meaning is on screen, not left to be guessed: it
    // matches languages the system recorded, and the panel says so.
    expect(screen.getByTestId("library-language-hint").textContent).toContain(
      "不做语言猜测"
    );

    fireEvent.change(screen.getByLabelText("关键词"), { target: { value: "出货量" } });
    fireEvent.change(screen.getByLabelText("发布者"), { target: { value: "国家统计局" } });
    fireEvent.change(screen.getByLabelText("域名"), { target: { value: "stats.gov.cn" } });
    fireEvent.change(screen.getByLabelText("语言"), { target: { value: "zh" } });
    fireEvent.click(screen.getByRole("button", { name: "检索" }));

    await waitFor(() =>
      expect(searchLibrarySources).toHaveBeenLastCalledWith(
        expect.objectContaining({
          query: "出货量",
          publisher: "国家统计局",
          domain: "stats.gov.cn",
          language: "zh",
          targetSessionId: OWN_SESSION
        })
      )
    );

    searchLibrarySources.mockRejectedValue(new Error("资料库暂时不可用"));
    fireEvent.click(screen.getByRole("button", { name: "检索" }));
    const error = await screen.findByTestId("library-error");
    expect(error.textContent).toContain("资料库暂时不可用");
    // The results table is still there: a failed search does not pretend to be
    // an empty library.
    expect(screen.getByTestId("library-results")).toBeTruthy();
  });
});
