"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getEvents } from "./api";
import {
  createEvidence,
  createResearchClaim,
  createSource,
  getEvidenceContext,
  getResearchWorkspace,
  setVerification,
  type EvidenceContext,
  type ResearchWorkspace
} from "./api";
import { getCurrentUser, type AuthUser } from "../arena/api-client";
import { EvidenceTable, SourceDetail, StatusPill, VerdictCard } from "./components";
import { ClaimForm, EvidenceForm, SourceForm } from "./forms";
import {
  claimStatusLabel,
  pendingVerificationLabel,
  verificationLabel,
  verificationTone,
  verdictLabel,
  workflowLabel
} from "./labels";

type Panel = "claims" | "content" | "detail";

const PANELS: Array<{ id: Panel; label: string }> = [
  { id: "claims", label: "主张" },
  { id: "content", label: "研究内容" },
  { id: "detail", label: "来源详情" }
];

export function ResearchWorkspace({ sessionId }: { sessionId: string }) {
  const [workspace, setWorkspace] = useState<ResearchWorkspace | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [selectedClaimId, setSelectedClaimId] = useState<string | null>(null);
  const [selectedEvidenceId, setSelectedEvidenceId] = useState<string | null>(null);
  const [context, setContext] = useState<EvidenceContext | null>(null);
  const [panel, setPanel] = useState<Panel>("content");
  const [openForm, setOpenForm] = useState<"none" | "claim" | "source" | "evidence">(
    "none"
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);

  const reload = useCallback(async () => {
    const next = await getResearchWorkspace(sessionId);
    setWorkspace(next);
    return next;
  }, [sessionId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [next, currentUser, events] = await Promise.all([
          getResearchWorkspace(sessionId),
          getCurrentUser().catch(() => null),
          getEvents(sessionId).catch(() => [])
        ]);
        if (cancelled) return;
        setWorkspace(next);
        setUser(currentUser);
        setHistory(
          events
            .filter(
              (event) =>
                event.type === "EVIDENCE_RECORDED" ||
                event.type === "EVIDENCE_VERIFICATION_CHANGED" ||
                event.type === "CLAIM_CREATED"
            )
            .slice(-8)
            .reverse()
            .map((event) => `#${event.sequence} ${event.type}`)
        );
      } catch (cause) {
        if (!cancelled) {
          setLoadError(
            cause instanceof Error ? cause.message : "Research workspace unavailable"
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useEffect(() => {
    if (!selectedEvidenceId) {
      setContext(null);
      return;
    }
    let cancelled = false;
    getEvidenceContext(sessionId, selectedEvidenceId)
      .then((next) => {
        if (!cancelled) setContext(next);
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Failed to load detail");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, selectedEvidenceId]);

  const claimsById = useMemo(
    () => new Map((workspace?.claims ?? []).map((claim) => [claim.id, claim])),
    [workspace]
  );
  const sourcesById = useMemo(
    () => new Map((workspace?.sources ?? []).map((source) => [source.id, source])),
    [workspace]
  );
  const verdictByClaimId = useMemo(
    () => new Map((workspace?.verdicts ?? []).map((verdict) => [verdict.claimId, verdict])),
    [workspace]
  );

  const visibleEvidence = useMemo(() => {
    const all = workspace?.evidence ?? [];
    if (!selectedClaimId) return all;
    return all.filter((item) => item.claimIds.includes(selectedClaimId));
  }, [workspace, selectedClaimId]);

  const canEdit = user === null || user.role !== "viewer";

  async function run(action: () => Promise<unknown>, failureHint: string) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await reload();
      return true;
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : `${failureHint} failed`
      );
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (loadError) {
    return (
      <div className="research-body">
        <div className="research-column">
          <section className="research-panel">
            <p className="research-error" role="alert">
              {loadError}
            </p>
            <p className="research-muted" style={{ marginTop: 8 }}>
              无法读取研究工作台。请确认后端已启动并完成 0005 迁移。
            </p>
          </section>
        </div>
      </div>
    );
  }

  if (!workspace) {
    return (
      <div className="research-body">
        <div className="research-column">
          <div className="research-empty">正在载入研究工作台…</div>
        </div>
      </div>
    );
  }

  const selectedClaim = selectedClaimId ? claimsById.get(selectedClaimId) : undefined;
  const selectedVerdict = selectedClaimId
    ? verdictByClaimId.get(selectedClaimId)
    : undefined;

  return (
    <>
      <div
        className="research-tabs"
        role="tablist"
        aria-label="研究面板"
        data-testid="research-tabs"
      >
        {PANELS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            className="research-tab"
            aria-selected={panel === item.id}
            onClick={() => setPanel(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="research-body" data-testid="research-body">
        {/* ---------- left: claims and flow ---------- */}
        <div
          className="research-column"
          data-hidden={panel !== "claims"}
          role="tabpanel"
          aria-label="主张导航"
        >
          <section className="research-panel">
            <div className="research-panel-head">
              <span className="research-panel-title">研究问题</span>
              <StatusPill tone="research-pill-neutral">
                {workflowLabel(workspace.session.phase)}
              </StatusPill>
            </div>
            <p className="research-question">
              {workspace.session.researchQuestion ?? "（未填写研究问题）"}
            </p>
            <p className="research-muted" style={{ marginTop: 6 }}>
              {pendingVerificationLabel(workspace.summary.unverified)} ·{" "}
              {workspace.summary.openVerdicts} 条主张仍有待处理材料
            </p>
          </section>

          <section className="research-panel">
            <div className="research-panel-head">
              <span className="research-panel-title">
                主张目录（{workspace.claims.length}）
              </span>
              <button
                type="button"
                className="research-button research-button-secondary"
                onClick={() => setOpenForm(openForm === "claim" ? "none" : "claim")}
              >
                {openForm === "claim" ? "收起" : "添加主张"}
              </button>
            </div>
            {openForm === "claim" ? (
              <ClaimForm
                busy={busy}
                error={error}
                onSubmit={async (command) => {
                  const ok = await run(
                    () => createResearchClaim(sessionId, command),
                    "Create claim"
                  );
                  if (ok) setOpenForm("none");
                }}
              />
            ) : null}
            {workspace.claims.length === 0 ? (
              <p className="research-muted">
                还没有主张。先写下一条可核查的原子主张，再为它收集证据。
              </p>
            ) : (
              <ul className="research-claim-list" data-testid="claim-list">
                <li className="research-claim-item">
                  <button
                    type="button"
                    className="research-claim-button"
                    aria-pressed={selectedClaimId === null}
                    onClick={() => setSelectedClaimId(null)}
                  >
                    <span className="research-claim-statement">全部主张</span>
                    <span className="research-claim-meta">
                      <span className="research-muted">
                        {workspace.evidence.length} 条材料
                      </span>
                    </span>
                  </button>
                </li>
                {workspace.claims.map((claim) => {
                  const verdict = verdictByClaimId.get(claim.id);
                  return (
                    <li key={claim.id} className="research-claim-item">
                      <button
                        type="button"
                        className="research-claim-button"
                        aria-pressed={selectedClaimId === claim.id}
                        onClick={() => setSelectedClaimId(claim.id)}
                      >
                        <span className="research-claim-statement">
                          {claim.statement}
                        </span>
                        <span className="research-claim-meta">
                          <StatusPill tone="research-pill-neutral">
                            {claimStatusLabel(claim.status)}
                          </StatusPill>
                          {verdict ? (
                            <StatusPill
                              tone={
                                verdict.status === "supported"
                                  ? "research-pill-verified"
                                  : verdict.status === "refuted"
                                    ? "research-pill-rejected"
                                    : verdict.status === "mixed_evidence"
                                      ? "research-pill-unverified"
                                      : "research-pill-neutral"
                              }
                            >
                              {verdictLabel(verdict.status)}
                            </StatusPill>
                          ) : null}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>

        {/* ---------- center: research content ---------- */}
        <div
          className="research-column"
          data-hidden={panel !== "content"}
          role="tabpanel"
          aria-label="研究内容"
        >
          {selectedClaim && selectedVerdict ? (
            <section className="research-panel">
              <div className="research-panel-head">
                <span className="research-panel-title">当前主张的结论</span>
              </div>
              <p className="research-question">{selectedClaim.statement}</p>
              <div style={{ marginTop: 8 }}>
                <VerdictCard
                  verdict={selectedVerdict}
                  claimStatus={claimStatusLabel(selectedClaim.status)}
                />
              </div>
            </section>
          ) : null}

          <section className="research-panel">
            <div className="research-panel-head">
              <span className="research-panel-title">
                证据材料（{visibleEvidence.length}）
              </span>
              <div className="research-actions">
                <button
                  type="button"
                  className="research-button research-button-secondary"
                  onClick={() =>
                    setOpenForm(openForm === "source" ? "none" : "source")
                  }
                >
                  {openForm === "source" ? "收起来源" : "添加来源"}
                </button>
                <button
                  type="button"
                  className="research-button"
                  onClick={() =>
                    setOpenForm(openForm === "evidence" ? "none" : "evidence")
                  }
                >
                  {openForm === "evidence" ? "收起" : "录入证据"}
                </button>
              </div>
            </div>

            {openForm === "source" ? (
              <SourceForm
                busy={busy}
                error={error}
                onSubmit={async (command) => {
                  const ok = await run(
                    () => createSource(sessionId, command),
                    "Create source"
                  );
                  if (ok) setOpenForm("none");
                }}
              />
            ) : null}

            {openForm === "evidence" ? (
              <EvidenceForm
                claims={workspace.claims}
                sources={workspace.sources}
                defaultClaimId={selectedClaimId}
                busy={busy}
                error={error}
                onSubmit={async (command) => {
                  const ok = await run(
                    () => createEvidence(sessionId, command),
                    "Create evidence"
                  );
                  if (ok) setOpenForm("none");
                }}
              />
            ) : null}

            <EvidenceTable
              evidence={visibleEvidence}
              claimsById={claimsById}
              sourcesById={sourcesById}
              selectedId={selectedEvidenceId}
              onSelect={(evidenceId) => {
                setSelectedEvidenceId(evidenceId);
                setPanel("detail");
              }}
              emptyHint={
                selectedClaimId
                  ? "该主张还没有任何证据材料。"
                  : "还没有证据材料。先添加来源，再录入原文摘录。"
              }
            />
          </section>

          <section className="research-panel">
            <div className="research-panel-head">
              <span className="research-panel-title">最近操作</span>
              <Link className="research-muted" href={`/research/${sessionId}/evidence`}>
                打开 Evidence Explorer →
              </Link>
            </div>
            {history.length === 0 ? (
              <p className="research-muted">暂无证据相关操作记录。</p>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {history.map((entry) => (
                  <li key={entry} className="research-muted">
                    {entry}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        {/* ---------- right: source detail ---------- */}
        <div data-hidden={panel !== "detail"} role="tabpanel" aria-label="来源详情">
          {context ? (
            <SourceDetail
              evidence={context.evidence}
              source={context.source}
              claims={context.claims}
              canEdit={canEdit}
              verifying={busy}
              error={error}
              onVerify={async (status, note) => {
                if (note.trim() === "") {
                  setError("请填写核实理由。");
                  return;
                }
                await run(
                  () =>
                    setVerification(sessionId, context.evidence.id, {
                      status,
                      verificationNote: note
                    }),
                  "Verification"
                );
              }}
            />
          ) : (
            <div className="research-column">
              <section className="research-panel">
                <p className="research-muted">
                  选择一条证据材料即可查看原文、来源元数据与核实记录。
                </p>
                <p className="research-muted" style={{ marginTop: 8 }}>
                  当前已核实 {workspace.summary.verified} 条，待核实{" "}
                  {workspace.summary.unverified} 条，已驳回{" "}
                  {workspace.summary.rejected} 条。
                </p>
              </section>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

export function verificationSummary(status: string): string {
  return verificationLabel(
    status === "verified" || status === "rejected" ? status : "unverified"
  );
}

export function verificationPillTone(status: string): string {
  return verificationTone(
    status === "verified" || status === "rejected" ? status : "unverified"
  );
}
