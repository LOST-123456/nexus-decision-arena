"use client";

import type { Claim, Source } from "@nexus/shared";
import { useState } from "react";
import { claimStatusLabel } from "./labels";
import type {
  CreateClaimCommand,
  CreateEvidenceCommand,
  CreateSourceCommand,
  ImportSourceCommand
} from "./api";

const numberField = (value: string, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export function SourceForm({
  onSubmit,
  busy,
  error
}: {
  onSubmit: (command: CreateSourceCommand) => void;
  busy: boolean;
  error: string | null;
}) {
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<CreateSourceCommand["kind"]>("url");
  const [url, setUrl] = useState("");
  const [publisher, setPublisher] = useState("");
  const [author, setAuthor] = useState("");
  const [publishedAt, setPublishedAt] = useState("");
  const [note, setNote] = useState("");

  return (
    <form
      className="research-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({
          title,
          kind,
          ...(url ? { url } : {}),
          ...(publisher ? { publisher } : {}),
          ...(author ? { author } : {}),
          ...(publishedAt ? { publishedAt: new Date(publishedAt).toISOString() } : {}),
          ...(note ? { note } : {})
        });
      }}
    >
      <div className="research-field">
        <label className="research-label" htmlFor="source-title">
          来源标题
        </label>
        <input
          id="source-title"
          className="research-input"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          required
        />
      </div>
      <div className="research-field">
        <label className="research-label" htmlFor="source-kind">
          类型
        </label>
        <select
          id="source-kind"
          className="research-select"
          value={kind}
          onChange={(event) =>
            setKind(event.target.value as CreateSourceCommand["kind"])
          }
        >
          <option value="url">网页</option>
          <option value="document">文档</option>
          <option value="dataset">数据集</option>
          <option value="manual">手工录入</option>
        </select>
      </div>
      <div className="research-field">
        <label className="research-label" htmlFor="source-url">
          链接{kind === "url" ? "（必填）" : ""}
        </label>
        <input
          id="source-url"
          className="research-input"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://"
        />
      </div>
      <div className="research-field">
        <label className="research-label" htmlFor="source-publisher">
          发布机构
        </label>
        <input
          id="source-publisher"
          className="research-input"
          value={publisher}
          onChange={(event) => setPublisher(event.target.value)}
        />
      </div>
      <div className="research-field">
        <label className="research-label" htmlFor="source-author">
          作者 / 责任方
        </label>
        <input
          id="source-author"
          className="research-input"
          value={author}
          onChange={(event) => setAuthor(event.target.value)}
        />
      </div>
      <div className="research-field">
        <label className="research-label" htmlFor="source-published">
          发布日期
        </label>
        <input
          id="source-published"
          className="research-input"
          type="date"
          value={publishedAt}
          onChange={(event) => setPublishedAt(event.target.value)}
        />
      </div>
      <div className="research-field">
        <label className="research-label" htmlFor="source-note">
          可信度说明 / 局限
        </label>
        <textarea
          id="source-note"
          className="research-textarea"
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </div>
      {error ? (
        <p className="research-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="research-actions">
        <button type="submit" className="research-button" disabled={busy}>
          保存来源
        </button>
      </div>
    </form>
  );
}

export function EvidenceForm({
  claims,
  sources,
  defaultClaimId,
  onSubmit,
  busy,
  error
}: {
  claims: Claim[];
  sources: Source[];
  defaultClaimId: string | null;
  onSubmit: (command: CreateEvidenceCommand) => void;
  busy: boolean;
  error: string | null;
}) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [description, setDescription] = useState("");
  const [kind, setKind] =
    useState<CreateEvidenceCommand["kind"]>("external_reference");
  const [direction, setDirection] =
    useState<CreateEvidenceCommand["direction"]>("supports");
  const [reliability, setReliability] = useState("0.6");
  const [locator, setLocator] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [sourceRef, setSourceRef] = useState("");
  const [claimIds, setClaimIds] = useState<string[]>(
    defaultClaimId ? [defaultClaimId] : []
  );
  const [claimFilter, setClaimFilter] = useState("");

  const toggleClaim = (claimId: string) => {
    setClaimIds((current) =>
      current.includes(claimId)
        ? current.filter((id) => id !== claimId)
        : [...current, claimId]
    );
  };

  return (
    <form
      className="research-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({
          title,
          content,
          description,
          kind,
          direction,
          reliability: numberField(reliability, 0.5),
          claimIds,
          ...(sourceId ? { sourceId } : {}),
          ...(sourceRef ? { sourceRef } : {}),
          ...(locator ? { locator } : {})
        });
      }}
    >
      <div className="research-field">
        <label className="research-label" htmlFor="evidence-title">
          材料标题
        </label>
        <input
          id="evidence-title"
          className="research-input"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          required
        />
      </div>
      <div className="research-field">
        <label className="research-label" htmlFor="evidence-content">
          原文摘录
        </label>
        <textarea
          id="evidence-content"
          className="research-textarea"
          value={content}
          onChange={(event) => setContent(event.target.value)}
          required
        />
      </div>
      <div className="research-field">
        <label className="research-label" htmlFor="evidence-description">
          这条材料说明了什么
        </label>
        <textarea
          id="evidence-description"
          className="research-textarea"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          required
        />
      </div>
      <div className="research-field">
        <label className="research-label" htmlFor="evidence-kind">
          材料类型
        </label>
        <select
          id="evidence-kind"
          className="research-select"
          value={kind}
          onChange={(event) =>
            setKind(event.target.value as CreateEvidenceCommand["kind"])
          }
        >
          <option value="external_reference">外部来源</option>
          <option value="calculation">推算</option>
          <option value="project_input">项目输入</option>
          <option value="assumption">假设</option>
        </select>
      </div>
      <div className="research-field">
        <label className="research-label" htmlFor="evidence-direction">
          对主张的关系
        </label>
        <select
          id="evidence-direction"
          className="research-select"
          value={direction}
          onChange={(event) =>
            setDirection(event.target.value as CreateEvidenceCommand["direction"])
          }
        >
          <option value="supports">支持</option>
          <option value="opposes">反对</option>
          <option value="context">背景 / 上下文</option>
        </select>
      </div>
      <div className="research-field">
        <label className="research-label" htmlFor="evidence-source">
          来源记录
        </label>
        <select
          id="evidence-source"
          className="research-select"
          value={sourceId}
          onChange={(event) => setSourceId(event.target.value)}
        >
          <option value="">不关联（需填写链接）</option>
          {sources.map((source) => (
            <option key={source.id} value={source.id}>
              {source.title}
            </option>
          ))}
        </select>
      </div>
      <div className="research-field">
        <label className="research-label" htmlFor="evidence-source-ref">
          来源链接
        </label>
        <input
          id="evidence-source-ref"
          className="research-input"
          value={sourceRef}
          onChange={(event) => setSourceRef(event.target.value)}
          placeholder="https://"
        />
      </div>
      <div className="research-field">
        <label className="research-label" htmlFor="evidence-locator">
          摘录定位（页码 / 段落 / 行号）
        </label>
        <input
          id="evidence-locator"
          className="research-input"
          value={locator}
          onChange={(event) => setLocator(event.target.value)}
        />
      </div>
      <div className="research-field">
        <label className="research-label" htmlFor="evidence-reliability">
          可靠性（0–1）
        </label>
        <input
          id="evidence-reliability"
          className="research-input"
          type="number"
          min="0"
          max="1"
          step="0.05"
          value={reliability}
          onChange={(event) => setReliability(event.target.value)}
        />
      </div>
      <fieldset className="research-field" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="research-label">关联主张（至少一条）</legend>
        {claims.length === 0 ? (
          <p className="research-muted">还没有主张，请先添加一条待核查主张。</p>
        ) : (
          <>
            {/*
              主张一多，勾选就成了找针。
              一个研究跑到几十条主张很常见，而这一栏决定"这条材料算谁的"——
              挑错一条，材料就挂在不相关的主张上，报告里那条主张仍然是"证据不足"，
              用户却以为材料已经录完了。所以：勾选数量摆在明面上，超过一屏给搜索框，
              没被搜索命中的已选项仍然保留（筛掉不等于取消）。
            */}
            <div
              className="research-actions"
              style={{ justifyContent: "space-between", marginBottom: 4 }}
            >
              <span className="research-muted" data-testid="evidence-claim-count">
                已勾选 {claimIds.length} 条 · 共 {claims.length} 条
              </span>
              {claims.length > 6 ? (
                <input
                  className="research-input"
                  style={{ maxWidth: 280 }}
                  placeholder="搜索主张内容"
                  value={claimFilter}
                  onChange={(event) => setClaimFilter(event.target.value)}
                  aria-label="搜索要关联的主张"
                  data-testid="evidence-claim-filter"
                />
              ) : null}
            </div>
            {claims
              .filter((claim) =>
                claimFilter.trim() === ""
                  ? true
                  : claim.statement
                      .toLowerCase()
                      .includes(claimFilter.trim().toLowerCase())
              )
              .map((claim) => (
                <label
                  key={claim.id}
                  style={{ display: "flex", gap: 8, alignItems: "flex-start" }}
                >
                  <input
                    type="checkbox"
                    checked={claimIds.includes(claim.id)}
                    onChange={() => toggleClaim(claim.id)}
                  />
                  <span>
                    {claim.statement}
                    <span className="research-muted">
                      （{claimStatusLabel(claim.status)}）
                    </span>
                  </span>
                </label>
              ))}
            {claimFilter.trim() !== "" &&
            claims.every(
              (claim) =>
                !claim.statement
                  .toLowerCase()
                  .includes(claimFilter.trim().toLowerCase())
            ) ? (
              <p className="research-muted" data-testid="evidence-claim-no-match">
                没有匹配「{claimFilter.trim()}」的主张。清空搜索框可以看到全部。
              </p>
            ) : null}
          </>
        )}
      </fieldset>
      {error ? (
        <p className="research-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="research-actions">
        <button
          type="submit"
          className="research-button"
          disabled={busy || claimIds.length === 0}
        >
          保存为待核实材料
        </button>
        <span className="research-muted">
          新录入的材料一律进入「待核实」，不会自动成为结论依据。
        </span>
      </div>
    </form>
  );
}

export function ClaimForm({
  onSubmit,
  busy,
  error
}: {
  onSubmit: (command: CreateClaimCommand) => void;
  busy: boolean;
  error: string | null;
}) {
  const [statement, setStatement] = useState("");
  const [type, setType] = useState<CreateClaimCommand["type"]>("fact");
  const [stance, setStance] = useState<CreateClaimCommand["stance"]>("neutral");
  const [importance, setImportance] = useState("3");
  const [lens, setLens] = useState("");

  return (
    <form
      className="research-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({
          statement,
          type,
          stance,
          importance: Math.round(numberField(importance, 3)),
          ...(lens ? { lens } : {})
        });
      }}
    >
      <div className="research-field">
        <label className="research-label" htmlFor="claim-statement">
          待核查主张（写成一句话，可验证）
        </label>
        <textarea
          id="claim-statement"
          className="research-textarea"
          value={statement}
          onChange={(event) => setStatement(event.target.value)}
          required
        />
      </div>
      <div className="research-field">
        <label className="research-label" htmlFor="claim-type">
          类型
        </label>
        <select
          id="claim-type"
          className="research-select"
          value={type}
          onChange={(event) =>
            setType(event.target.value as CreateClaimCommand["type"])
          }
        >
          <option value="fact">事实</option>
          <option value="assumption">假设</option>
          <option value="prediction">预测</option>
          <option value="recommendation">建议</option>
        </select>
      </div>
      <div className="research-field">
        <label className="research-label" htmlFor="claim-stance">
          立场
        </label>
        <select
          id="claim-stance"
          className="research-select"
          value={stance}
          onChange={(event) =>
            setStance(event.target.value as CreateClaimCommand["stance"])
          }
        >
          <option value="neutral">中立</option>
          <option value="support">支持</option>
          <option value="oppose">反对</option>
        </select>
      </div>
      <div className="research-field">
        <label className="research-label" htmlFor="claim-importance">
          重要性（1–5）
        </label>
        <input
          id="claim-importance"
          className="research-input"
          type="number"
          min="1"
          max="5"
          value={importance}
          onChange={(event) => setImportance(event.target.value)}
        />
      </div>
      {error ? (
        <p className="research-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="research-actions">
        <button type="submit" className="research-button" disabled={busy}>
          添加主张
        </button>
      </div>
    </form>
  );
}

/**
 * Registers one or more pages by url, asking the server to read them.
 *
 * Distinct from `SourceForm` on purpose: that form records a citation a
 * researcher already has in hand, while this one asks the server to go and get
 * the text. Keeping them separate means a slow or refused retrieval can never
 * be mistaken for a manual registration that simply succeeded.
 *
 * Addresses are submitted one per line and read one at a time, so each url gets
 * its own outcome. A batch that reported one aggregate result would hide which
 * of five addresses actually failed.
 */
export function ImportSourceForm({
  onSubmit,
  busy,
  error,
  onInvalid
}: {
  onSubmit: (commands: ImportSourceCommand[]) => void;
  busy: boolean;
  error: string | null;
  /** 校验没通过时把原因交回去。没有它，空提交看起来就像按钮坏了。 */
  onInvalid?: (message: string) => void;
}) {
  const [input, setInput] = useState("");
  const [title, setTitle] = useState("");

  const urls = input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  // A single label only makes sense for a single page: applying it to a batch
  // would give several different sources the same title.
  const canUseTitle = urls.length === 1 && title.trim().length > 0;

  return (
    <form
      className="research-form"
      data-testid="import-source-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (urls.length === 0) {
          onInvalid?.("请至少填写一个网页地址，每行一个。");
          return;
        }
        onSubmit(
          urls.map((url) => ({ url, ...(canUseTitle ? { title: title.trim() } : {}) }))
        );
      }}
    >
      <div className="research-field">
        <label className="research-label" htmlFor="import-url">
          网页地址（每行一个，可一次导入多个）
        </label>
        <textarea
          id="import-url"
          className="research-textarea"
          rows={3}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder={"https://\nhttps://"}
          required
        />
      </div>
      <div className="research-field">
        <label className="research-label" htmlFor="import-title">
          标题（可选；留空采用网页标题，仅在只填一个地址时生效）
        </label>
        <input
          id="import-title"
          className="research-input"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </div>
      <p className="research-muted">
        服务器逐个读取这些公网 http/https 文本页面；内网、本机与云元数据地址一律拒绝。
        每个地址的处理结果与失败原因都会记录在对应来源上——导入成功不代表内容已被核实。
      </p>
      {error ? (
        <p className="research-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="research-actions">
        <button type="submit" className="research-button" disabled={busy}>
          {urls.length > 1 ? `导入 ${urls.length} 个网页` : "导入网页"}
        </button>
      </div>
    </form>
  );
}
