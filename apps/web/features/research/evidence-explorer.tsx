"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getEvidenceContext,
  getResearchWorkspace,
  type EvidenceContext,
  type ResearchWorkspace
} from "./api";
import { EvidenceTable, SourceDetail, StatusPill } from "./components";
import {
  claimStatusLabel,
  directionLabel,
  formatDate,
  pendingVerificationLabel,
  sourceKindLabel,
  verificationLabel,
  verdictLabel
} from "./labels";

type Filters = {
  claimId: string;
  direction: string;
  verificationStatus: string;
};

export function EvidenceExplorer({ sessionId }: { sessionId: string }) {
  const [workspace, setWorkspace] = useState<ResearchWorkspace | null>(null);
  const [filters, setFilters] = useState<Filters>({
    claimId: "",
    direction: "",
    verificationStatus: ""
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [context, setContext] = useState<EvidenceContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeColumn, setActiveColumn] = useState<"list" | "detail">("list");

  const reload = useCallback(
    () => getResearchWorkspace(sessionId).then(setWorkspace),
    [sessionId]
  );

  useEffect(() => {
    let cancelled = false;
    getResearchWorkspace(sessionId)
      .then((next) => {
        if (!cancelled) setWorkspace(next);
      })
      .catch((cause) => {
        if (!cancelled) {
          setLoadError(
            cause instanceof Error ? cause.message : "Evidence explorer unavailable"
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useEffect(() => {
    if (!selectedId) {
      setContext(null);
      return;
    }
    let cancelled = false;
    getEvidenceContext(sessionId, selectedId)
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
  }, [sessionId, selectedId]);

  const claimsById = useMemo(
    () => new Map((workspace?.claims ?? []).map((claim) => [claim.id, claim])),
    [workspace]
  );
  const sourcesById = useMemo(
    () => new Map((workspace?.sources ?? []).map((source) => [source.id, source])),
    [workspace]
  );

  const filtered = useMemo(() => {
    const all = workspace?.evidence ?? [];
    return all.filter((item) => {
      if (filters.claimId && !item.claimIds.includes(filters.claimId)) return false;
      if (filters.direction && item.direction !== filters.direction) return false;
      if (
        filters.verificationStatus &&
        item.verificationStatus !== filters.verificationStatus
      ) {
        return false;
      }
      return true;
    });
  }, [workspace, filters]);

  if (loadError) {
    return (
      <div className="research-body">
        <div className="research-column">
          <p className="research-error" role="alert">
            {loadError}
          </p>
        </div>
      </div>
    );
  }

  if (!workspace) {
    return (
      <div className="research-body">
        <div className="research-column">
          <div className="research-empty">正在载入证据库…</div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="research-tabs" role="tablist" aria-label="证据面板">
        <button
          type="button"
          role="tab"
          className="research-tab"
          aria-selected={activeColumn === "list"}
          onClick={() => setActiveColumn("list")}
        >
          证据列表
        </button>
        <button
          type="button"
          role="tab"
          className="research-tab"
          aria-selected={activeColumn === "detail"}
          onClick={() => setActiveColumn("detail")}
        >
          原文与来源
        </button>
      </div>

      <div className="research-body" style={{ gridTemplateColumns: "minmax(0,1fr) 380px" }}>
        <div
          className="research-column"
          data-hidden={activeColumn !== "list"}
          role="tabpanel"
          aria-label="证据列表"
        >
          <section className="research-panel">
            <div className="research-panel-head">
              <span className="research-panel-title">筛选</span>
              <span className="research-muted">
                {pendingVerificationLabel(workspace.summary.unverified)}
              </span>
            </div>
            <div className="research-form" style={{ flexDirection: "row", flexWrap: "wrap" }}>
              <div className="research-field" style={{ minWidth: 200, flex: 1 }}>
                <label className="research-label" htmlFor="filter-claim">
                  主张
                </label>
                <select
                  id="filter-claim"
                  className="research-select"
                  value={filters.claimId}
                  onChange={(event) =>
                    setFilters({ ...filters, claimId: event.target.value })
                  }
                >
                  <option value="">全部主张</option>
                  {workspace.claims.map((claim) => (
                    <option key={claim.id} value={claim.id}>
                      {claim.statement}
                    </option>
                  ))}
                </select>
              </div>
              <div className="research-field" style={{ minWidth: 140 }}>
                <label className="research-label" htmlFor="filter-direction">
                  方向
                </label>
                <select
                  id="filter-direction"
                  className="research-select"
                  value={filters.direction}
                  onChange={(event) =>
                    setFilters({ ...filters, direction: event.target.value })
                  }
                >
                  <option value="">全部</option>
                  <option value="supports">支持</option>
                  <option value="opposes">反对</option>
                  <option value="context">背景</option>
                </select>
              </div>
              <div className="research-field" style={{ minWidth: 140 }}>
                <label className="research-label" htmlFor="filter-status">
                  核实状态
                </label>
                <select
                  id="filter-status"
                  className="research-select"
                  value={filters.verificationStatus}
                  onChange={(event) =>
                    setFilters({ ...filters, verificationStatus: event.target.value })
                  }
                >
                  <option value="">全部</option>
                  <option value="unverified">待核实</option>
                  <option value="verified">已核实</option>
                  <option value="rejected">已驳回</option>
                </select>
              </div>
            </div>
          </section>

          <section className="research-panel">
            <div className="research-panel-head">
              <span className="research-panel-title">
                证据（{filtered.length} / {workspace.evidence.length}）
              </span>
            </div>
            <EvidenceTable
              evidence={filtered}
              claimsById={claimsById}
              sourcesById={sourcesById}
              selectedId={selectedId}
              onSelect={(evidenceId) => {
                setSelectedId(evidenceId);
                setActiveColumn("detail");
              }}
              emptyHint="没有符合筛选条件的证据。"
            />
          </section>

          <section className="research-panel">
            <div className="research-panel-head">
              <span className="research-panel-title">
                来源（{workspace.sources.length}）
              </span>
            </div>
            {workspace.sources.length === 0 ? (
              <p className="research-muted">还没有登记来源。</p>
            ) : (
              <table className="research-table">
                <thead>
                  <tr>
                    <th scope="col">标题</th>
                    <th scope="col">类型</th>
                    <th scope="col">发布机构</th>
                    <th scope="col">发布日期</th>
                  </tr>
                </thead>
                <tbody>
                  {workspace.sources.map((source) => (
                    <tr key={source.id}>
                      <td>
                        {source.url ? (
                          <a href={source.url} target="_blank" rel="noreferrer">
                            {source.title}
                          </a>
                        ) : (
                          source.title
                        )}
                      </td>
                      <td>
                        <StatusPill tone="research-pill-neutral">
                          {sourceKindLabel(source.kind)}
                        </StatusPill>
                      </td>
                      <td className="research-muted">{source.publisher ?? "—"}</td>
                      <td className="research-muted">
                        {formatDate(source.publishedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="research-panel">
            <div className="research-panel-head">
              <span className="research-panel-title">各主张的结论</span>
            </div>
            <table className="research-table">
              <thead>
                <tr>
                  <th scope="col">主张</th>
                  <th scope="col">业务状态</th>
                  <th scope="col">事实核查结论</th>
                </tr>
              </thead>
              <tbody>
                {workspace.claims.map((claim) => {
                  const verdict = workspace.verdicts.find(
                    (item) => item.claimId === claim.id
                  );
                  return (
                    <tr key={claim.id}>
                      <td>{claim.statement}</td>
                      <td className="research-muted">
                        {claimStatusLabel(claim.status)}
                      </td>
                      <td>
                        {verdict ? (
                          <>
                            {verdictLabel(verdict.status)}
                            <div className="research-muted">
                              {verdict.rationale}
                            </div>
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        </div>

        <div data-hidden={activeColumn !== "detail"} role="tabpanel" aria-label="原文与来源">
          {context ? (
            <SourceDetail
              evidence={context.evidence}
              source={context.source}
              claims={context.claims}
              canEdit={false}
              verifying={false}
              error={error}
              onVerify={() => undefined}
            />
          ) : (
            <div className="research-column">
              <section className="research-panel">
                <p className="research-muted">
                  选择一条证据以阅读原文、查看来源元数据和核实记录。核实操作请在
                  研究工作台中进行。
                </p>
              </section>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

export function directionText(direction: string): string {
  return directionLabel(
    direction === "supports" || direction === "opposes" ? direction : "context"
  );
}

export function verificationText(status: string): string {
  return verificationLabel(
    status === "verified" || status === "rejected" ? status : "unverified"
  );
}
