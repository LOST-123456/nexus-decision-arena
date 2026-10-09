"use client";

import { useState, type ReactNode } from "react";
import type {
  Claim,
  ClaimVerdict,
  Evidence,
  Source
} from "@nexus/shared";
import {
  directionLabel,
  directionTone,
  evidenceKindLabel,
  formatDate,
  sourceKindLabel,
  verificationLabel,
  verificationTone,
  verdictLabel
} from "./labels";

export function StatusPill({
  tone,
  children
}: {
  tone: string;
  children: ReactNode;
}) {
  return <span className={`research-pill ${tone}`}>{children}</span>;
}

/**
 * The fact-check verdict is shown next to the claim's own business status and
 * the workflow phase, because they answer different questions.
 */
export function VerdictCard({
  verdict,
  claimStatus
}: {
  verdict: ClaimVerdict;
  claimStatus: string;
}) {
  const percent = Math.round(verdict.confidence * 100);
  return (
    <div className="research-verdict">
      <div style={{ flex: 1 }}>
        <div className="research-verdict-status">
          事实核查结论：{verdictLabel(verdict.status)}
        </div>
        <div className="research-verdict-rationale">{verdict.rationale}</div>
        <div className="research-muted" style={{ marginTop: 4 }}>
          主张状态：{claimStatus}
        </div>
        <div className="research-meter" style={{ marginTop: 6 }}>
          <span
            className="research-meter-fill"
            style={{ width: `${percent}%` }}
            role="img"
            aria-label={`结论把握度 ${percent}%，不代表确定性`}
          />
        </div>
        <div className="research-muted">
          把握度 {percent}%（已核实 {verdict.counts.verified} /
          待核实 {verdict.counts.unverified} /
          已驳回 {verdict.counts.rejected}
          {verdict.counts.expired > 0
            ? ` / 超出有效期 ${verdict.counts.expired}`
            : ""}）
        </div>
      </div>
    </div>
  );
}

export function EvidenceTable({
  evidence,
  claimsById,
  sourcesById,
  selectedId,
  onSelect,
  emptyHint
}: {
  evidence: Evidence[];
  claimsById: Map<string, Claim>;
  sourcesById: Map<string, Source>;
  selectedId: string | null;
  onSelect: (evidenceId: string) => void;
  emptyHint: string;
}) {
  if (evidence.length === 0) {
    return <div className="research-empty">{emptyHint}</div>;
  }

  return (
    <table className="research-table" data-testid="evidence-table">
      <caption className="research-muted" style={{ textAlign: "left", paddingBottom: 6 }}>
        共 {evidence.length} 条证据材料；只有「已核实」的材料参与结论。
      </caption>
      <thead>
        <tr>
          <th scope="col">方向</th>
          <th scope="col">材料</th>
          <th scope="col">来源</th>
          <th scope="col">定位</th>
          <th scope="col">可靠性</th>
          <th scope="col">核实</th>
        </tr>
      </thead>
      <tbody>
        {evidence.map((item) => {
          const source = item.sourceId ? sourcesById.get(item.sourceId) : undefined;
          const claimStatements = item.claimIds.map((claimId) => {
            const claim = claimsById.get(claimId);
            return claim ? claim.statement : "（未知主张）";
          });
          return (
            <tr key={item.id} aria-selected={selectedId === item.id}>
              <td>
                <StatusPill tone={directionTone(item.direction)}>
                  {directionLabel(item.direction)}
                </StatusPill>
              </td>
              <td>
                <button
                  type="button"
                  className="research-row-button"
                  onClick={() => onSelect(item.id)}
                  aria-expanded={selectedId === item.id}
                >
                  {item.title}
                </button>
                <div className="research-excerpt">{item.content}</div>
                <div className="research-muted">
                  {evidenceKindLabel(item.kind)}
                  {claimStatements.length > 0
                    ? ` · 关联：${claimStatements.join("；")}`
                    : ""}
                </div>
              </td>
              <td>
                {source ? (
                  <span>{source.title}</span>
                ) : item.sourceRef ? (
                  <a href={item.sourceRef} target="_blank" rel="noreferrer">
                    {item.sourceRef}
                  </a>
                ) : (
                  <span className="research-muted">未记录</span>
                )}
              </td>
              <td className="research-muted">{item.locator ?? "—"}</td>
              <td>{item.reliability.toFixed(2)}</td>
              <td>
                <StatusPill tone={verificationTone(item.verificationStatus)}>
                  {verificationLabel(item.verificationStatus)}
                </StatusPill>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function SourceDetail({
  evidence,
  source,
  claims,
  onVerify,
  verifying,
  error,
  canEdit
}: {
  evidence: Evidence;
  source: Source | null;
  claims: Claim[];
  onVerify: (status: "verified" | "rejected" | "unverified", note: string) => void;
  verifying: boolean;
  error: string | null;
  canEdit: boolean;
}) {
  return (
    <div className="research-column" data-testid="source-detail">
      <section className="research-panel">
        <div className="research-panel-head">
          <span className="research-panel-title">原文摘录</span>
          <StatusPill tone={verificationTone(evidence.verificationStatus)}>
            {verificationLabel(evidence.verificationStatus)}
          </StatusPill>
        </div>
        <blockquote className="research-quote">{evidence.content}</blockquote>
        <p className="research-muted" style={{ marginTop: 8 }}>
          {evidence.description}
        </p>
        {evidence.verifiedBy ? (
          <dl className="research-facts" style={{ marginTop: 10 }}>
            <dt>核实人</dt>
            <dd>{evidence.verifiedBy}</dd>
            <dt>核实时间</dt>
            <dd>{formatDate(evidence.verifiedAt)}</dd>
            <dt>核实理由</dt>
            <dd>{evidence.verificationNote}</dd>
          </dl>
        ) : null}
      </section>

      <section className="research-panel">
        <div className="research-panel-head">
          <span className="research-panel-title">来源详情</span>
          {source ? (
            <StatusPill tone="research-pill-neutral">
              {sourceKindLabel(source.kind)}
            </StatusPill>
          ) : null}
        </div>
        {source ? (
          <>
            <div className="research-source-title">{source.title}</div>
            <dl className="research-facts" style={{ marginTop: 8 }}>
              <dt>发布机构</dt>
              <dd>{source.publisher ?? "—"}</dd>
              <dt>作者</dt>
              <dd>{source.author ?? "—"}</dd>
              <dt>发布日期</dt>
              <dd>{formatDate(source.publishedAt)}</dd>
              <dt>链接</dt>
              <dd>
                {source.url ? (
                  <a href={source.url} target="_blank" rel="noreferrer">
                    {source.url}
                  </a>
                ) : (
                  "—"
                )}
              </dd>
              <dt>备注</dt>
              <dd>{source.note ?? "—"}</dd>
            </dl>
          </>
        ) : (
          <p className="research-muted">
            该材料没有关联来源记录{evidence.sourceRef ? `，仅有链接 ${evidence.sourceRef}` : ""}。
            缺少来源的摘录无法复核。
          </p>
        )}
      </section>

      <section className="research-panel">
        <div className="research-panel-head">
          <span className="research-panel-title">关联主张</span>
          <span className="research-muted">{claims.length} 条</span>
        </div>
        {claims.length === 0 ? (
          <p className="research-muted">尚未关联任何主张。</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {claims.map((claim) => (
              <li key={claim.id} style={{ marginBottom: 4 }}>
                {claim.statement}
              </li>
            ))}
          </ul>
        )}
      </section>

      {canEdit ? (
        <section className="research-panel">
          <div className="research-panel-head">
            <span className="research-panel-title">核实</span>
          </div>
          <VerificationForm
            current={evidence.verificationStatus}
            onSubmit={onVerify}
            busy={verifying}
          />
          {error ? (
            <p className="research-error" style={{ marginTop: 8 }} role="alert">
              {error}
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

export function VerificationForm({
  current,
  onSubmit,
  busy
}: {
  current: Evidence["verificationStatus"];
  onSubmit: (status: "verified" | "rejected" | "unverified", note: string) => void;
  busy: boolean;
}) {
  const [note, setNote] = useState("");
  const options: Array<{
    status: "verified" | "rejected" | "unverified";
    label: string;
  }> = [
    { status: "verified", label: "标记为已核实" },
    { status: "rejected", label: "标记为已驳回" },
    { status: "unverified", label: "退回待核实" }
  ];

  return (
    <div className="research-form">
      <div className="research-field">
        <label className="research-label" htmlFor="verification-note">
          核实理由（必填，写入审计记录）
        </label>
        <textarea
          id="verification-note"
          className="research-textarea"
          name="verificationNote"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="例如：与报告第 14 页表格逐字核对一致。"
        />
      </div>
      <div className="research-actions">
        {options
          .filter((option) => option.status !== current)
          .map((option) => (
            <button
              key={option.status}
              type="button"
              className={
                option.status === "verified"
                  ? "research-button"
                  : "research-button research-button-secondary"
              }
              disabled={busy}
              onClick={() => onSubmit(option.status, note)}
            >
              {option.label}
            </button>
          ))}
      </div>
      <p className="research-muted">
        核实人取自当前登录身份，不能由页面指定；模型输出不会自动进入已核实状态。
      </p>
    </div>
  );
}
