"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type Claim,
  type Evidence,
  SOURCE_FILE_PAGE_SEPARATOR,
  type SourceFileKind
} from "@nexus/shared";
import {
  createEvidence,
  FileIngestionFailedError,
  getSourceFileContent,
  type SourceFileContent
} from "./api";
import { StatusPill } from "./components";
import {
  csvColumnTypeLabel,
  fileParseStatusLabel,
  fileParseStatusTone,
  formatDate,
  locatorStatusLabel,
  locatorStatusTone,
  sourceFileKindLabel,
  verificationLabel,
  verificationTone
} from "./labels";

/**
 * The reader for an imported local file.
 *
 * It shows the text the server extracted, and it helps turn a chosen passage
 * into a citation through the existing evidence endpoint. Three things it will
 * not do, and the UI says so where it matters:
 *
 *   - It never claims anything was verified. Every excerpt created here arrives
 *     `unverified`, because the server decides that, not this page.
 *   - It never invents a location. Page numbers, headings and row numbers are
 *     shown because the parser preserved them; when a passage cannot be located
 *     in the stored text, the interface says exactly that.
 *   - It never reads the file itself. What is on screen is the stored capture,
 *     which is why nothing here can execute anything the document contained.
 */

export function FileReader({
  sessionId,
  fileId,
  claims,
  defaultClaimId,
  canEdit,
  onClose,
  onChanged
}: {
  sessionId: string;
  fileId: string;
  claims: Claim[];
  defaultClaimId: string | null;
  canEdit: boolean;
  onClose: () => void;
  onChanged: () => Promise<void> | void;
}) {
  const [content, setContent] = useState<SourceFileContent | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [query, setQuery] = useState("");
  const [anchorText, setAnchorText] = useState("");
  const [title, setTitle] = useState("");
  const [claimId, setClaimId] = useState(defaultClaimId ?? "");
  const [direction, setDirection] =
    useState<"supports" | "opposes" | "context">("supports");
  const [reliability, setReliability] = useState("0.7");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    locatorStatus: Evidence["locatorStatus"];
    locator: string | null;
    verificationStatus: Evidence["verificationStatus"];
  } | null>(null);

  const load = useCallback(async () => {
    try {
      setContent(await getSourceFileContent(sessionId, fileId));
      setLoadError(null);
    } catch (cause) {
      setContent(null);
      setLoadError(
        cause instanceof FileIngestionFailedError || cause instanceof Error
          ? cause.message
          : "无法读取该文件内容"
      );
    }
  }, [sessionId, fileId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setClaimId(defaultClaimId ?? "");
  }, [defaultClaimId]);

  const pages = useMemo(() => {
    const raw = content?.content ?? "";
    if (raw.length === 0) return [];
    return raw.split(SOURCE_FILE_PAGE_SEPARATOR);
  }, [content]);

  if (loadError) {
    return (
      <div className="research-column" data-testid="file-reader">
        <section className="research-panel">
          <p className="research-error" role="alert">
            {loadError}
          </p>
        </section>
      </div>
    );
  }

  if (!content) {
    return (
      <div className="research-column" data-testid="file-reader">
        <div className="research-empty">正在载入文件内容…</div>
      </div>
    );
  }

  const { file, source, snapshot, table } = content;
  const kind: SourceFileKind = file.detectedKind;
  const hasText = content.content.trim().length > 0;

  /** The passage currently under the cursor, so a person does not retype it. */
  function captureSelection() {
    if (typeof window === "undefined") return;
    const selected = window.getSelection()?.toString().trim() ?? "";
    if (selected.length === 0) return;
    setAnchorText(selected);
    setTitle(selected.slice(0, 40));
  }

  async function confirmExcerpt() {
    const excerpt = anchorText.trim();
    if (excerpt.length === 0) {
      setError("请先选中或粘贴原文中的一段连续文字。");
      return;
    }
    if (claimId === "") {
      setError("请选择这条摘录要支持/反对/补充的主张。");
      return;
    }
    if (!file.sourceId) {
      setError("这个文件还没有可用的来源登记，无法登记引用。");
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      // The same endpoint every other citation goes through. Nothing here sets
      // verification: that decision belongs to a person, later, elsewhere.
      const created = await createEvidence(sessionId, {
        kind: "external_reference",
        title: title.trim() === "" ? excerpt.slice(0, 60) : title.trim(),
        content: excerpt,
        description: `引自文件《${file.fileName}》${
          kind === "pdf" && pages.length > 0 ? `（第 ${page + 1} 页）` : ""
        }`,
        sourceId: file.sourceId,
        locatorKind: "quote",
        anchorText: excerpt,
        direction,
        reliability: clampReliability(reliability),
        claimIds: [claimId]
      });
      setResult({
        locatorStatus: created.evidence.locatorStatus,
        locator: created.evidence.locator ?? null,
        verificationStatus: created.evidence.verificationStatus
      });
      setAnchorText("");
      setTitle("");
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "确认摘录失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="research-column" data-testid="file-reader">
      <section className="research-panel">
        <div className="research-panel-head">
          <span className="research-panel-title">{file.fileName}</span>
          <div className="research-actions">
            <StatusPill tone={fileParseStatusTone(file.parseStatus)}>
              {fileParseStatusLabel(file.parseStatus)}
            </StatusPill>
            <span className="research-muted">
              {sourceFileKindLabel(kind)} · {formatBytes(file.byteSize)}
            </span>
            <button
              type="button"
              className="research-button research-button-secondary"
              onClick={onClose}
            >
              关闭
            </button>
          </div>
        </div>
        <dl className="research-facts" style={{ marginTop: 8 }}>
          <dt>内容指纹</dt>
          <dd style={{ overflowWrap: "anywhere" }}>{file.sha256}</dd>
          <dt>来源登记</dt>
          <dd>{source ? source.title : "尚未生成（文件未被读取）"}</dd>
          <dt>导入时间</dt>
          <dd>{formatDate(file.createdAt)}</dd>
        </dl>
        {file.parseError ? (
          <p className="research-error" role="alert" style={{ marginTop: 8 }}>
            {file.parseError}
          </p>
        ) : null}
        {file.parseStatus === "needs_ocr" ? (
          <p className="research-muted" data-testid="needs-ocr-note">
            这是扫描版 PDF：有 {describePages(file)}，但没有文字层，本系统无法 OCR。
            因此没有生成来源，也无法从这里摘录；请提供带文字层的版本或人工录入原文。
          </p>
        ) : null}
      </section>

      {kind === "pdf" && pages.length > 1 ? (
        <section className="research-panel">
          <div className="research-panel-head">
            <span className="research-panel-title">
              第 {page + 1} / {pages.length} 页
            </span>
            <div className="research-actions">
              <button
                type="button"
                className="research-button research-button-secondary"
                onClick={() => setPage((current) => Math.max(0, current - 1))}
                disabled={page === 0}
              >
                上一页
              </button>
              <button
                type="button"
                className="research-button research-button-secondary"
                onClick={() =>
                  setPage((current) => Math.min(pages.length - 1, current + 1))
                }
                disabled={page >= pages.length - 1}
              >
                下一页
              </button>
            </div>
          </div>
          <div className="research-field" style={{ marginTop: 8 }}>
            <label className="research-label" htmlFor="file-search">
              在全文搜索
            </label>
            <input
              id="file-search"
              className="research-input"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="输入关键词，命中的页会列出"
            />
          </div>
          {query.trim().length > 0 ? (
            <ul className="research-plain-list" data-testid="file-search-hits">
              {pages
                .map((text, index) => ({ text, index }))
                .filter((entry) => entry.text.includes(query.trim()))
                .map((entry) => (
                  <li key={entry.index}>
                    <button
                      type="button"
                      className="research-button research-button-secondary"
                      onClick={() => setPage(entry.index)}
                    >
                      第 {entry.index + 1} 页
                    </button>
                  </li>
                ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      {hasText ? (
        <section className="research-panel">
          <div className="research-panel-head">
            <span className="research-panel-title">原文文本</span>
            <span className="research-muted">
              {snapshot ? `${snapshot.charCount} 字` : ""}
              {source?.contentHash
                ? ` · 版本 ${source.contentHash.slice(0, 8)}`
                : ""}
            </span>
          </div>
          <p className="research-muted">
            以下是服务器提取并保存的纯文本（不执行任何文档内容）。选中一段文字后点
            “取用选中文字”，填写主张与方向，即可登记为引用。
          </p>

          {kind === "csv" && table ? (
            <div className="research-table-wrap" data-testid="csv-table">
              <table className="research-table">
                <thead>
                  <tr>
                    <th>行号</th>
                    {table.columns.map((column, index) => (
                      <th key={column}>
                        {column}
                        <span className="research-muted">
                          {" "}
                          · {csvColumnTypeLabel(table.columnTypes[index] ?? "text")}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {table.rows.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {/* Row numbers are what a citation can point at when the
                          columns themselves carry no page or paragraph. */}
                      <td>{rowIndex + 2}</td>
                      {row.map((cell, cellIndex) => (
                        <td key={cellIndex}>{cell}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {table.rowCount > table.rows.length ? (
                <p className="research-muted">
                  仅预览前 {table.rows.length} 行，共 {table.rowCount} 行。
                </p>
              ) : null}
            </div>
          ) : (
            <pre
              data-testid="file-content"
              onMouseUp={captureSelection}
              onKeyUp={captureSelection}
              style={{
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
                maxHeight: 420,
                overflowY: "auto",
                margin: "8px 0 0",
                padding: 10,
                borderRadius: 8,
                background: "var(--wb-surface-subtle, rgba(0,0,0,0.03))",
                font: "inherit",
                fontSize: 13,
                lineHeight: 1.6
              }}
            >
              {kind === "pdf" ? (pages[page] ?? "") : content.content}
            </pre>
          )}
        </section>
      ) : file.parseStatus === "parsed" ? (
        <section className="research-panel">
          <p className="research-muted" data-testid="no-text-note">
            这个文件没有可读正文，可能是扫描件或未包含文字层。
          </p>
        </section>
      ) : null}

      <section className="research-panel">
        <div className="research-panel-head">
          <span className="research-panel-title">登记引用摘录</span>
          <span className="research-muted">
            服务器会在保存的原文中定位，并给出定位结果
          </span>
        </div>
        {canEdit && file.sourceId ? (
          <>
            <div className="research-field">
              <label className="research-label" htmlFor="file-excerpt">
                原文摘录（必须是原文中的连续文字）
              </label>
              <textarea
                id="file-excerpt"
                className="research-textarea"
                rows={3}
                value={anchorText}
                onChange={(event) => setAnchorText(event.target.value)}
              />
              <button
                type="button"
                className="research-button research-button-secondary"
                onClick={captureSelection}
              >
                取用选中文字
              </button>
            </div>
            <div className="research-field">
              <label className="research-label" htmlFor="file-excerpt-title">
                引用标题（可选）
              </label>
              <input
                id="file-excerpt-title"
                className="research-input"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </div>
            <div className="research-form" style={{ flexDirection: "row", flexWrap: "wrap" }}>
              <div className="research-field" style={{ minWidth: 200, flex: 1 }}>
                <label className="research-label" htmlFor="file-excerpt-claim">
                  关联主张
                </label>
                <select
                  id="file-excerpt-claim"
                  className="research-select"
                  value={claimId}
                  onChange={(event) => setClaimId(event.target.value)}
                >
                  <option value="">请选择主张</option>
                  {claims.map((claim) => (
                    <option key={claim.id} value={claim.id}>
                      {claim.statement}
                    </option>
                  ))}
                </select>
              </div>
              <div className="research-field" style={{ minWidth: 120 }}>
                <label className="research-label" htmlFor="file-excerpt-direction">
                  方向
                </label>
                <select
                  id="file-excerpt-direction"
                  className="research-select"
                  value={direction}
                  onChange={(event) =>
                    setDirection(
                      event.target.value as "supports" | "opposes" | "context"
                    )
                  }
                >
                  <option value="supports">支持</option>
                  <option value="opposes">反对</option>
                  <option value="context">背景</option>
                </select>
              </div>
              <div className="research-field" style={{ minWidth: 120 }}>
                <label className="research-label" htmlFor="file-excerpt-reliability">
                  可靠度 0–1
                </label>
                <input
                  id="file-excerpt-reliability"
                  className="research-input"
                  value={reliability}
                  onChange={(event) => setReliability(event.target.value)}
                />
              </div>
            </div>
            {error ? (
              <p className="research-error" role="alert">
                {error}
              </p>
            ) : null}
            {result ? (
              <div
                className="research-panel"
                data-testid="file-excerpt-result"
                style={{ marginTop: 8 }}
              >
                <div className="research-claim-meta">
                  <StatusPill tone={locatorStatusTone(result.locatorStatus)}>
                    {locatorStatusLabel(result.locatorStatus)}
                  </StatusPill>
                  <StatusPill tone={verificationTone(result.verificationStatus)}>
                    {verificationLabel(result.verificationStatus)}
                  </StatusPill>
                  <span className="research-muted">
                    定位：{result.locator ?? "—"}
                  </span>
                </div>
                <p className="research-muted" style={{ marginTop: 6 }}>
                  {result.locatorStatus === "anchored"
                    ? "已在保存的原文中定位到这段文字。引用已登记，仍未核实——核实是独立的动作。"
                    : result.locatorStatus === "missing"
                      ? "这段文字没有出现在当前保存的原文中，无法定位：可能改动过文件，或摘录不连续。"
                      : "该文件没有可核对的原文，无法定位；引用已登记但仍未核实。"}
                </p>
              </div>
            ) : null}
            <div className="research-actions" style={{ marginTop: 8 }}>
              <button
                type="button"
                className="research-button"
                onClick={() => void confirmExcerpt()}
                disabled={busy}
              >
                定位并确认引用
              </button>
            </div>
          </>
        ) : file.sourceId ? (
          <p className="research-muted">当前账号为只读角色，无法登记引用。</p>
        ) : (
          <p className="research-muted">
            这个文件没有被读取成来源，因此无法登记引用。请先重新解析或上传带文字层的版本。
          </p>
        )}
      </section>
    </div>
  );
}

function clampReliability(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0.7;
  return Math.min(Math.max(parsed, 0), 1);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** How many pages were counted, said in the file's own terms. */
function describePages(file: { parseStats: unknown }): string {
  const stats = file.parseStats as
    | { kind?: string; pageCount?: number }
    | null
    | undefined;
  const count = stats?.pageCount ?? 0;
  return `${count} 页`;
}
