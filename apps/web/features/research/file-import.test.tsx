import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Component tests for the file-import panel.
 *
 * Data access is faked; what is pinned down is the honesty of the surface:
 *  - an upload that was refused, and a file that was stored but could not be
 *    read, both stay on screen with their reason instead of disappearing;
 *  - a duplicate is named as a duplicate rather than as a new import;
 *  - progress is reported while bytes are still moving;
 *  - read-only accounts are simply not offered an upload control.
 */

const listSourceFiles = vi.fn();
const uploadSourceFile = vi.fn();
const retrySourceFileParse = vi.fn();

class Failure extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly file?: unknown
  ) {
    super(message);
    this.name = "FileIngestionFailedError";
  }
}

vi.mock("./api", () => ({
  listSourceFiles: (...args: unknown[]) => listSourceFiles(...args),
  uploadSourceFile: (...args: unknown[]) => uploadSourceFile(...args),
  retrySourceFileParse: (...args: unknown[]) => retrySourceFileParse(...args),
  FileIngestionFailedError: Failure
}));

const { FileImportPanel } = await import("./file-import");

const SESSION_ID = "session-1";

function record(overrides: {
  id?: string;
  fileName?: string;
  kind?: "pdf" | "docx" | "txt" | "markdown" | "csv";
  parseStatus: "parsed" | "needs_ocr" | "failed";
  parseError?: string;
}) {
  return {
    id: overrides.id ?? "file-1",
    sessionId: SESSION_ID,
    sourceId: overrides.parseStatus === "parsed" ? "source-1" : undefined,
    fileName: overrides.fileName ?? "notes.txt",
    declaredMimeType: "application/octet-stream",
    detectedKind: overrides.kind ?? "txt",
    byteSize: 32,
    sha256: "a".repeat(64),
    parseStatus: overrides.parseStatus,
    ...(overrides.parseError ? { parseError: overrides.parseError } : {}),
    parseStats: null,
    parserVersion: "nexus-file-parsers@1",
    createdAt: "2026-10-11T07:00:00.000Z",
    updatedAt: "2026-10-11T07:00:00.000Z"
  } as never;
}

/** Lets a test set `<input type=file>` to something without going through UI. */
function selectFiles(files: File[]) {
  const input = screen.getByTestId("file-input") as HTMLInputElement;
  Object.defineProperty(input, "files", {
    value: files,
    writable: false,
    configurable: true
  });
  fireEvent.change(input);
}

function file(name: string, body = "content") {
  return new File([new TextEncoder().encode(body)], name, {
    type: "application/octet-stream"
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  listSourceFiles.mockResolvedValue({ files: [] });
});

describe("FileImportPanel", () => {
  it("offers an upload control only to accounts that may write", () => {
    render(
      <FileImportPanel
        sessionId={SESSION_ID}
        canEdit={false}
        onOpenFile={() => undefined}
        onChanged={() => undefined}
      />
    );
    expect(screen.queryByTestId("file-dropzone")).toBeNull();
    expect(screen.getByText(/只读角色/)).toBeTruthy();
  });

  it("states the accepted formats and the ceiling before anything fails", () => {
    render(
      <FileImportPanel
        sessionId={SESSION_ID}
        canEdit
        onOpenFile={() => undefined}
        onChanged={() => undefined}
      />
    );
    expect(screen.getByText(/PDF、Word\(\.docx\)/)).toBeTruthy();
    expect(screen.getByText(/10 MB/)).toBeTruthy();
  });

  it("uploads every selected file separately and reports each outcome", async () => {
    uploadSourceFile
      .mockResolvedValueOnce({
        file: record({
          id: "file-1",
          fileName: "report.pdf",
          kind: "pdf",
          parseStatus: "parsed"
        }),
        source: null,
        duplicated: false
      })
      .mockResolvedValueOnce({
        file: record({
          id: "file-2",
          fileName: "scan.pdf",
          kind: "pdf",
          parseStatus: "needs_ocr"
        }),
        source: null,
        duplicated: false
      });
    render(
      <FileImportPanel
        sessionId={SESSION_ID}
        canEdit
        onOpenFile={() => undefined}
        onChanged={() => undefined}
      />
    );
    selectFiles([file("report.pdf"), file("scan.pdf")]);

    await waitFor(() => expect(uploadSourceFile).toHaveBeenCalledTimes(2));
    expect(
      uploadSourceFile.mock.calls.every(
        (call) => (call[0] as { sessionId: string }).sessionId === SESSION_ID
      )
    ).toBe(true);
    await waitFor(() => {
      expect(screen.getByText("已读取原文")).toBeTruthy();
      expect(screen.getByText("需要 OCR（无文字层）")).toBeTruthy();
    });
  });

  it("reports upload progress while the file is still moving", async () => {
    // The upload is held open on purpose: progress is only observable while the
    // request is in flight, so releasing it early would hide the very state
    // this test is about.
    let release: (() => void) | undefined;
    uploadSourceFile.mockImplementation(
      async (input: { onProgress?: (percent: number) => void }) => {
        input.onProgress?.(42);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return {
          file: record({ parseStatus: "parsed" }),
          source: null,
          duplicated: false
        };
      }
    );
    render(
      <FileImportPanel
        sessionId={SESSION_ID}
        canEdit
        onOpenFile={() => undefined}
        onChanged={() => undefined}
      />
    );
    selectFiles([file("notes.txt")]);
    await waitFor(() =>
      expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
        "42"
      )
    );
    release?.();
  });

  it("says a repeated file is a duplicate rather than a new import", async () => {
    uploadSourceFile.mockResolvedValue({
      file: record({ parseStatus: "parsed" }),
      source: null,
      duplicated: true
    });
    render(
      <FileImportPanel
        sessionId={SESSION_ID}
        canEdit
        onOpenFile={() => undefined}
        onChanged={() => undefined}
      />
    );
    selectFiles([file("renamed.txt")]);
    await waitFor(() => expect(screen.getByText(/内容重复/)).toBeTruthy());
  });

  it("keeps a refused upload visible with the reason", async () => {
    uploadSourceFile.mockRejectedValue(
      new Failure("不支持的文件类型。", "unsupported_type")
    );
    render(
      <FileImportPanel
        sessionId={SESSION_ID}
        canEdit
        onOpenFile={() => undefined}
        onChanged={() => undefined}
      />
    );
    selectFiles([file("image.png")]);
    await waitFor(() =>
      expect(screen.getByText(/不支持的文件类型：只接受 PDF/)).toBeTruthy()
    );
  });

  it("accepts a drop of several files at once", async () => {
    uploadSourceFile.mockResolvedValue({
      file: record({ parseStatus: "parsed" }),
      source: null,
      duplicated: false
    });
    render(
      <FileImportPanel
        sessionId={SESSION_ID}
        canEdit
        onOpenFile={() => undefined}
        onChanged={() => undefined}
      />
    );
    fireEvent.drop(screen.getByTestId("file-dropzone"), {
      dataTransfer: { files: [file("a.txt"), file("b.csv")] }
    });
    await waitFor(() => expect(uploadSourceFile).toHaveBeenCalledTimes(2));
  });

  it("opens the reader for a readable file and offers retry for the rest", async () => {
    const opened: string[] = [];
    listSourceFiles.mockResolvedValue({
      files: [
        record({
          id: "file-1",
          fileName: "readable.pdf",
          kind: "pdf",
          parseStatus: "parsed"
        }),
        record({
          id: "file-9",
          fileName: "broken.pdf",
          kind: "pdf",
          parseStatus: "failed",
          parseError: "该文件不是完整的 PDF：文件结尾缺少 %%EOF 标记。"
        })
      ]
    });
    retrySourceFileParse.mockResolvedValue({
      file: record({ id: "file-9", parseStatus: "failed" }),
      source: null,
      duplicated: false
    });
    render(
      <FileImportPanel
        sessionId={SESSION_ID}
        canEdit
        onOpenFile={(file) => opened.push(file.id)}
        onChanged={() => undefined}
      />
    );

    await waitFor(() => expect(screen.getByText("broken.pdf")).toBeTruthy());
    expect(screen.getByText(/缺少 %%EOF/)).toBeTruthy();

    fireEvent.click(screen.getByText("重新解析"));
    await waitFor(() =>
      expect(retrySourceFileParse).toHaveBeenCalledWith(SESSION_ID, "file-9")
    );

    fireEvent.click(screen.getByText("打开阅读"));
    expect(opened).toEqual(["file-1"]);
  });
});
