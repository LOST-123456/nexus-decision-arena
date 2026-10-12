import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Component tests for the imported-file reader.
 *
 * Data access is faked. What is being pinned down is the difference between
 * "readable" and "understood":
 *  - pages, headings and csv rows stay navigable, because the parser preserved
 *    them rather than flattening the document into prose;
 *  - a scanned file says it needs OCR and offers nothing to excerpt, instead of
 *    showing an empty reader that looks like a loading failure;
 *  - a confirmed excerpt is submitted through the existing evidence endpoint and
 *    comes back **unverified**, with the UI saying that locating is not
 *    verifying.
 */

const getSourceFileContent = vi.fn();
const createEvidence = vi.fn();

vi.mock("./api", () => ({
  getSourceFileContent: (...args: unknown[]) => getSourceFileContent(...args),
  createEvidence: (...args: unknown[]) => createEvidence(...args),
  FileIngestionFailedError: class extends Error {}
}));

const { FileReader } = await import("./file-reader");

const SESSION_ID = "session-1";
const FILE_ID = "file-1";

const CLAIMS = [
  { id: "claim-1", statement: "市场同比增长 12%" }
] as never;

function base(overrides: {
  id?: string;
  fileName: string;
  kind: "pdf" | "docx" | "txt" | "markdown" | "csv";
  parseStatus: "parsed" | "needs_ocr" | "failed";
  sourceId?: string;
  parseStats?: unknown;
  parseError?: string;
}) {
  return {
    id: overrides.id ?? FILE_ID,
    sessionId: SESSION_ID,
    sourceId: overrides.sourceId ?? (overrides.parseStatus === "parsed" ? "source-1" : undefined),
    fileName: overrides.fileName,
    declaredMimeType: "application/octet-stream",
    detectedKind: overrides.kind,
    byteSize: 128,
    sha256: "b".repeat(64),
    parseStatus: overrides.parseStatus,
    ...(overrides.parseError ? { parseError: overrides.parseError } : {}),
    parseStats: overrides.parseStats ?? null,
    parserVersion: "nexus-file-parsers@1",
    createdAt: "2026-10-11T07:00:00.000Z",
    updatedAt: "2026-10-11T07:00:00.000Z"
  } as never;
}

function content(file: unknown, text: string, table?: unknown) {
  return {
    file,
    source: (file as { sourceId?: string }).sourceId
      ? { id: "source-1", title: "导入的文件", kind: "document", contentHash: "abcdef1234" }
      : null,
    snapshot: text.length > 0 ? { id: "snap-1", contentHash: "abcdef1234", charCount: text.length } : null,
    content: text,
    contentType: "text/plain",
    ...(table ? { table } : {})
  } as never;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  createEvidence.mockResolvedValue({
    evidence: {
      id: "evidence-1",
      locatorStatus: "anchored",
      locator: "位置 1",
      verificationStatus: "unverified"
    }
  });
});

describe("FileReader", () => {
  it("shows the stored text of a plain-text file", async () => {
    getSourceFileContent.mockResolvedValue(
      content(base({ fileName: "notes.txt", kind: "txt", parseStatus: "parsed" }), "第一段。\n\n第二段。")
    );
    render(
      <FileReader
        sessionId={SESSION_ID}
        fileId={FILE_ID}
        claims={CLAIMS}
        defaultClaimId={null}
        canEdit
        onClose={() => undefined}
        onChanged={() => undefined}
      />
    );
    await waitFor(() =>
      expect(screen.getByTestId("file-content").textContent).toContain("第一段。")
    );
  });

  it("pages through a pdf and finds a term across its pages", async () => {
    // `\f` is the page separator the parser stored, so page navigation is real
    // navigation rather than a guess at where one page ends.
    getSourceFileContent.mockResolvedValue(
      content(base({ fileName: "report.pdf", kind: "pdf", parseStatus: "parsed" }), "第一页结论。\f第二页方法说明。\f第三页附录。")
    );
    render(
      <FileReader
        sessionId={SESSION_ID}
        fileId={FILE_ID}
        claims={CLAIMS}
        defaultClaimId={null}
        canEdit
        onClose={() => undefined}
        onChanged={() => undefined}
      />
    );
    await waitFor(() => expect(screen.getByText(/第 1 \/ 3 页/)).toBeTruthy());
    expect(screen.getByTestId("file-content").textContent).toBe("第一页结论。");

    fireEvent.click(screen.getByText("下一页"));
    await waitFor(() => expect(screen.getByText(/第 2 \/ 3 页/)).toBeTruthy());
    expect(screen.getByTestId("file-content").textContent).toBe("第二页方法说明。");

    fireEvent.change(screen.getByLabelText("在全文搜索"), {
      target: { value: "方法" }
    });
    await waitFor(() => expect(screen.getByTestId("file-search-hits")).toBeTruthy());
    expect(screen.getByText("第 2 页")).toBeTruthy();
  });

  it("renders a csv as a table with row numbers and inferred column types", async () => {
    getSourceFileContent.mockResolvedValue(
      content(
        base({ fileName: "data.csv", kind: "csv", parseStatus: "parsed" }),
        "region,amount\nEast,1200\n",
        {
          columns: ["region", "amount"],
          columnTypes: ["text", "integer"],
          rows: [
            ["East", "1200"],
            ["West", "980"]
          ],
          rowCount: 2
        }
      )
    );
    render(
      <FileReader
        sessionId={SESSION_ID}
        fileId={FILE_ID}
        claims={CLAIMS}
        defaultClaimId={null}
        canEdit
        onClose={() => undefined}
        onChanged={() => undefined}
      />
    );
    await waitFor(() => expect(screen.getByTestId("csv-table")).toBeTruthy());
    // Types are labelled as inferred, and rows keep their numbers: a citation can
    // point at a row without pretending the numbers prove anything.
    expect(screen.getByText(/整数（推断）/)).toBeTruthy();
    expect(screen.getByText("region")).toBeTruthy();
    expect(screen.getByRole("table").textContent).toContain("East");
  });

  it("says a scanned pdf needs OCR and offers nothing to excerpt", async () => {
    getSourceFileContent.mockResolvedValue(
      content(
        base({
          fileName: "scan.pdf",
          kind: "pdf",
          parseStatus: "needs_ocr",
          parseStats: { kind: "ocr", pageCount: 3 }
        }),
        ""
      )
    );
    render(
      <FileReader
        sessionId={SESSION_ID}
        fileId={FILE_ID}
        claims={CLAIMS}
        defaultClaimId={null}
        canEdit
        onClose={() => undefined}
        onChanged={() => undefined}
      />
    );
    await waitFor(() => expect(screen.getByTestId("needs-ocr-note")).toBeTruthy());
    expect(screen.getByTestId("needs-ocr-note").textContent).toContain("3 页");
    // No source exists, so there is nothing a citation could point at.
    expect(screen.getByText(/无法登记引用/)).toBeTruthy();
    expect(createEvidence).not.toHaveBeenCalled();
  });

  it("surfaces the recorded reason when a file could not be read", async () => {
    getSourceFileContent.mockResolvedValue(
      content(
        base({
          fileName: "broken.pdf",
          kind: "pdf",
          parseStatus: "failed",
          parseError: "该文件不是完整的 PDF：文件结尾缺少 %%EOF 标记。"
        }),
        ""
      )
    );
    render(
      <FileReader
        sessionId={SESSION_ID}
        fileId={FILE_ID}
        claims={CLAIMS}
        defaultClaimId={null}
        canEdit
        onClose={() => undefined}
        onChanged={() => undefined}
      />
    );
    await waitFor(() =>
      expect(screen.getByText(/缺少 %%EOF/)).toBeTruthy()
    );
  });

  it("takes the selected passage and submits it as an unverified citation", async () => {
    getSourceFileContent.mockResolvedValue(
      content(base({ fileName: "notes.txt", kind: "txt", parseStatus: "parsed" }), "增长率达到 12%。")
    );
    const changed = vi.fn();
    render(
      <FileReader
        sessionId={SESSION_ID}
        fileId={FILE_ID}
        claims={CLAIMS}
        defaultClaimId="claim-1"
        canEdit
        onClose={() => undefined}
        onChanged={changed}
      />
    );
    await waitFor(() => expect(screen.getByTestId("file-content")).toBeTruthy());

    fireEvent.change(screen.getByLabelText("原文摘录（必须是原文中的连续文字）"), {
      target: { value: "增长率达到 12%。" }
    });
    fireEvent.click(screen.getByText("定位并确认引用"));

    await waitFor(() => expect(createEvidence).toHaveBeenCalledTimes(1));
    const command = createEvidence.mock.calls[0]![1] as {
      anchorText: string;
      claimIds: string[];
      sourceId: string;
    };
    expect(command.anchorText).toBe("增长率达到 12%。");
    expect(command.claimIds).toEqual(["claim-1"]);
    expect(command.sourceId).toBe("source-1");
    // Nothing in the client claims verification: the server's answer is shown.
    await waitFor(() => expect(screen.getByTestId("file-excerpt-result")).toBeTruthy());
    // "待核实" is the exact label: located is not verified.
    expect(screen.getByText("待核实")).toBeTruthy();
    expect(changed).toHaveBeenCalled();
  });

  it("refuses to submit an excerpt with no claim attached", async () => {
    getSourceFileContent.mockResolvedValue(
      content(base({ fileName: "notes.txt", kind: "txt", parseStatus: "parsed" }), "增长率达到 12%。")
    );
    render(
      <FileReader
        sessionId={SESSION_ID}
        fileId={FILE_ID}
        claims={CLAIMS}
        defaultClaimId={null}
        canEdit
        onClose={() => undefined}
        onChanged={() => undefined}
      />
    );
    await waitFor(() => expect(screen.getByTestId("file-content")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("原文摘录（必须是原文中的连续文字）"), {
      target: { value: "增长率达到 12%。" }
    });
    fireEvent.click(screen.getByText("定位并确认引用"));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(createEvidence).not.toHaveBeenCalled();
  });
});
