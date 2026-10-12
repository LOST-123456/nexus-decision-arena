"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SourceFileRecord } from "@nexus/shared";
import {
  FileIngestionFailedError,
  listSourceFiles,
  retrySourceFileParse,
  uploadSourceFile
} from "./api";
import { StatusPill } from "./components";
import {
  fileFailureCodeMessage,
  fileParseStatusLabel,
  fileParseStatusTone,
  formatDate,
  sourceFileKindLabel
} from "./labels";

/**
 * Uploading local research files.
 *
 * The rules this panel keeps visible, because hiding them would change what a
 * user believes about their own material:
 *
 *   - **Uploading is not reading.** A row appears once the server has finished
 *     trying, and it says which of the three outcomes happened. Nothing here
 *     implies the file was understood.
 *   - **A duplicate is content, not a name.** Identical bytes resolve to the
 *     earlier import even under a different name; the same name with different
 *     bytes is a different file and says so.
 *   - **Failure stays on screen.** `needs_ocr` and `failed` are listed rather
 *     than dropped, each with the reason the server gave, and each retryable.
 */

/** What the server accepts, said once so the limit is not discovered by failure. */
const ACCEPTED_HINT =
  "PDF、Word(.docx)、TXT、Markdown、CSV，单文件默认上限 10 MB";

type Row = {
  id: string;
  name: string;
  state: "uploading" | "uploaded" | "failed";
  percent: number;
  message?: string;
  outcome?: "parsed" | "needs_ocr" | "failed" | "duplicate";
  file?: SourceFileRecord;
};

export function FileImportPanel({
  sessionId,
  canEdit,
  onOpenFile,
  onChanged
}: {
  sessionId: string;
  canEdit: boolean;
  onOpenFile: (file: SourceFileRecord) => void;
  onChanged: () => Promise<void> | void;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [files, setFiles] = useState<SourceFileRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const next = await listSourceFiles(sessionId);
      setFiles(next.files);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法读取文件列表");
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function accept(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    if (!canEdit) {
      setError("当前账号为只读角色，无法上传文件。");
      return;
    }
    setError(null);
    for (const file of Array.from(fileList)) {
      const rowId = `${file.name}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      setRows((current) => [
        {
          id: rowId,
          name: file.name,
          state: "uploading",
          percent: 0
        },
        ...current
      ]);
      try {
        const uploaded = await uploadSourceFile({
          sessionId,
          file,
          onProgress: (percent) => {
            setRows((current) =>
              current.map((row) =>
                row.id === rowId ? { ...row, percent } : row
              )
            );
          }
        });
        setRows((current) =>
          current.map((row) =>
            row.id === rowId
              ? {
                  ...row,
                  state: "uploaded",
                  percent: 100,
                  file: uploaded.file,
                  outcome: uploaded.duplicated
                    ? "duplicate"
                    : uploaded.file.parseStatus
                }
              : row
          )
        );
        await load();
        await onChanged();
      } catch (cause) {
        const failure =
          cause instanceof FileIngestionFailedError ? cause : null;
        setRows((current) =>
          current.map((row) =>
            row.id === rowId
              ? {
                  ...row,
                  state: "failed",
                  // Even a refusal can carry the row the server recorded, so the
                  // outcome stays inspectable instead of vanishing.
                  ...(failure?.file ? { file: failure.file } : {}),
                  outcome: failure?.file?.parseStatus ?? "failed",
                  message: fileFailureCodeMessage(
                    failure?.code,
                    cause instanceof Error ? cause.message : "上传失败"
                  )
                }
              : row
          )
        );
        await load();
      }
    }
  }

  async function retry(fileId: string) {
    setBusyId(fileId);
    try {
      await retrySourceFileParse(sessionId, fileId);
      await load();
      await onChanged();
    } catch (cause) {
      const failure = cause instanceof FileIngestionFailedError ? cause : null;
      setError(
        fileFailureCodeMessage(
          failure?.code,
          cause instanceof Error ? cause.message : "重新解析失败"
        )
      );
      await load();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="research-column" data-testid="file-import-panel">
      <section className="research-panel">
        <div className="research-panel-head">
          <span className="research-panel-title">本地文件导入</span>
          <span className="research-muted">{ACCEPTED_HINT}</span>
        </div>
        <p className="research-muted">
          文件会在服务端重新判型（不看扩展名）、记录内容指纹，并把提取出的纯文本保存为来源版本。
          同一份内容重复上传不会重复登记；扫描版 PDF 会被标为“需要 OCR”，绝不假装读取成功。
        </p>
        {canEdit ? (
          <div
            className="research-dropzone"
            data-testid="file-dropzone"
            data-dragging={dragging ? "true" : "false"}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              void accept(event.dataTransfer.files);
            }}
          >
            <p>把文件拖到这里，或</p>
            <button
              type="button"
              className="research-button"
              onClick={() => inputRef.current?.click()}
            >
              选择文件
            </button>
            <input
              ref={inputRef}
              type="file"
              multiple
              className="research-file-input"
              data-testid="file-input"
              onChange={(event) => {
                void accept(event.target.files);
                event.target.value = "";
              }}
            />
          </div>
        ) : (
          <p className="research-muted">当前账号为只读角色，无法上传文件。</p>
        )}
        {error ? (
          <p className="research-error" role="alert">
            {error}
          </p>
        ) : null}
      </section>

      {rows.length > 0 ? (
        <section className="research-panel" data-testid="upload-rows">
          <div className="research-panel-head">
            <span className="research-panel-title">本次上传</span>
          </div>
          <ul className="research-plain-list">
            {rows.map((row) => (
              <li key={row.id} className="research-challenge">
                <div className="research-claim-meta">
                  <strong>{row.name}</strong>
                  {row.state === "uploading" ? (
                    <span className="research-muted">上传中 {row.percent}%</span>
                  ) : row.outcome === "duplicate" ? (
                    <StatusPill tone="research-pill-neutral">
                      内容重复，已指向既有登记
                    </StatusPill>
                  ) : row.outcome ? (
                    <StatusPill tone={fileParseStatusTone(row.outcome)}>
                      {fileParseStatusLabel(row.outcome)}
                    </StatusPill>
                  ) : null}
                </div>
                {row.state === "uploading" ? (
                  <div
                    className="research-progress"
                    role="progressbar"
                    aria-valuenow={row.percent}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <span style={{ width: `${row.percent}%` }} />
                  </div>
                ) : null}
                {row.message ? (
                  <p className="research-error" role="alert">
                    {row.message}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="research-panel">
        <div className="research-panel-head">
          <span className="research-panel-title">
            已导入文件（{files.length}）
          </span>
        </div>
        {files.length === 0 ? (
          <p className="research-muted">还没有导入任何文件。</p>
        ) : (
          <ul className="research-plain-list" data-testid="file-list">
            {files.map((file) => (
              <li key={file.id} className="research-challenge">
                <div className="research-claim-meta">
                  <strong>{file.fileName}</strong>
                  <StatusPill tone={fileParseStatusTone(file.parseStatus)}>
                    {fileParseStatusLabel(file.parseStatus)}
                  </StatusPill>
                  <span className="research-muted">
                    {sourceFileKindLabel(file.detectedKind)} ·{" "}
                    {formatDate(file.createdAt)}
                  </span>
                </div>
                {file.parseError ? (
                  <p className="research-error" role="alert">
                    {file.parseError}
                  </p>
                ) : null}
                {file.parseStatus === "needs_ocr" ? (
                  <p className="research-muted">
                    扫描页无文字层，本系统不做 OCR；请上传带文字层的版本或人工录入。
                  </p>
                ) : null}
                <div className="research-actions">
                  {file.parseStatus === "parsed" ? (
                    <button
                      type="button"
                      className="research-button research-button-secondary"
                      onClick={() => onOpenFile(file)}
                    >
                      打开阅读
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="research-button research-button-secondary"
                      onClick={() => void retry(file.id)}
                      disabled={busyId === file.id || !canEdit}
                    >
                      重新解析
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
