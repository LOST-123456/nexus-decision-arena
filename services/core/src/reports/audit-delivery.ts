import type { Evidence } from "@nexus/shared";
import type {
  EvidenceCitation,
  FactCheckFinding,
  FactCheckReport
} from "../research/fact-check-report";

/**
 * What an audit package does with material nobody has verified.
 *
 * The product rule this encodes: **unverified material is retained and
 * labelled, never dropped to make a report look cleaner.** A package that
 * silently omitted an unverified excerpt would read as "everything here was
 * checked", which is exactly the false impression the whole verification
 * pipeline exists to prevent.
 *
 * So the default scope is `all`: everything in, every item carrying its own
 * verification status. `verified` exists for the case where an outside reader
 * may only be shown checked excerpts — and it pays for that by reporting, in
 * numbers, what it left out. Neither scope recomputes a single conclusion:
 * verdicts are derived from all the material at report time, and a delivery
 * filter that re-derived them would be inventing a different answer from a
 * partial set.
 */
export const AUDIT_SCOPE_VALUES = ["all", "verified"] as const;
export type AuditScope = (typeof AUDIT_SCOPE_VALUES)[number];

/** `undefined` means "not asked for", which is `all`. Anything else is a 400. */
export function resolveAuditScope(raw: unknown): AuditScope | null {
  if (raw === undefined || raw === "") return "all";
  if (
    typeof raw === "string" &&
    (AUDIT_SCOPE_VALUES as readonly string[]).includes(raw)
  ) {
    return raw as AuditScope;
  }
  return null;
}

/**
 * How well one claim is backed, computed from the statuses already recorded on
 * its citations. No inference: `verified` means every participating excerpt
 * carries `verificationStatus: "verified"`, and nothing else does.
 */
export type VerificationLabel =
  | "verified"
  | "partially_verified"
  | "unverified"
  | "no_material";

export const VERIFICATION_LEGEND: ReadonlyArray<{
  label: VerificationLabel;
  meaning: string;
}> = [
  { label: "verified", meaning: "参与结论的材料全部已核实" },
  { label: "partially_verified", meaning: "部分材料已核实，其余尚未核实" },
  { label: "unverified", meaning: "有材料，但全部未经核实（或已被驳回）" },
  { label: "no_material", meaning: "没有任何与该主张相关的材料" }
];

export type ClaimVerification = {
  claimId: string;
  verification: VerificationLabel;
  verified: number;
  unverified: number;
  rejected: number;
  /** Citations removed from the package by `scope=verified`. */
  withheld: number;
};

export type AuditDisclosure = {
  /**
   * Named as a policy, not a flag: a reader of two packages should be able to
   * tell that both were assembled the same way.
   */
  policy: "retain-and-label";
  scope: AuditScope;
  /** The sentence the package says about itself, in the reader's language. */
  statement: string;
  /** What this scope left out. Zero for `all`, and said so rather than omitted. */
  withheld: { citations: number; materials: number };
  verificationLegend: ReadonlyArray<{ label: VerificationLabel; meaning: string }>;
};

const STATEMENT_ALL =
  "本审计包按「全部保留并标注」交付：未经核实的材料保留在包内，逐条标注核实状态。任何未经核实的材料都不构成结论，也不因出现在包内而被视为已确认。";

function statementVerified(withheld: number): string {
  return [
    `本审计包按「仅已核实材料」交付：${withheld} 条未经核实或已驳回的材料未包含在包内。`,
    "结论仍按全部材料推导，被排除的材料依然存在于研究中 —— 需要完整视图时请使用 scope=all。",
    "未包含不等于不存在：把本包当作全集阅读会高估材料的核实程度。"
  ].join("");
}

export function citationLabel(citation: EvidenceCitation): VerificationLabel {
  return citation.verificationStatus === "verified" ? "verified" : "unverified";
}

/** Claim-level label plus the counts behind it. */
export function claimVerification(finding: FactCheckFinding): ClaimVerification {
  const participating = [
    ...finding.supporting,
    ...finding.opposing,
    ...finding.context
  ];
  const verified = participating.filter(
    (citation) => citation.verificationStatus === "verified"
  ).length;
  const rejected = participating.filter(
    (citation) => citation.verificationStatus === "rejected"
  ).length;
  const unverified = participating.length - verified - rejected;

  let verification: VerificationLabel;
  if (participating.length === 0) verification = "no_material";
  else if (verified === participating.length) verification = "verified";
  else if (verified > 0) verification = "partially_verified";
  else verification = "unverified";

  return {
    claimId: finding.claimId,
    verification,
    verified,
    unverified,
    rejected,
    withheld: 0
  };
}

export type ScopedFactCheckReport = {
  report: FactCheckReport;
  claims: ClaimVerification[];
  disclosure: AuditDisclosure;
};

function keep(citation: EvidenceCitation, scope: AuditScope): boolean {
  return scope === "all" || citation.verificationStatus === "verified";
}

/**
 * The same report, with its excerpts filtered to the delivery scope.
 *
 * Only the citation arrays and the per-claim counts change. `summary`,
 * `findings[].verdict` and every count derived from the verdict stay exactly as
 * they were generated: a conclusion is a fact about all the material, and
 * redrawing it from the subset a recipient is allowed to see would be a
 * different, invented conclusion.
 */
export function scopeFactCheckReport(
  report: FactCheckReport,
  scope: AuditScope
): ScopedFactCheckReport {
  let withheldCitations = 0;

  const claims: ClaimVerification[] = report.findings.map(claimVerification);

  const findings = report.findings.map((finding) => {
    const filterCitations = (
      citations: EvidenceCitation[]
    ): EvidenceCitation[] => {
      const kept = citations.filter((citation) => keep(citation, scope));
      if (scope === "verified") withheldCitations += citations.length - kept.length;
      return kept;
    };

    return {
      ...finding,
      supporting: filterCitations(finding.supporting),
      opposing: filterCitations(finding.opposing),
      context: filterCitations(finding.context),
      // `excluded` is material that was deliberately kept out of the verdict;
      // under `verified` the unverified ones go too, and the count is reported.
      excluded: filterCitations(finding.excluded)
    };
  });

  if (scope === "verified") {
    const withheldPerClaim = new Map<string, number>();
    report.findings.forEach((finding, index) => {
      const before =
        finding.supporting.length +
        finding.opposing.length +
        finding.context.length +
        finding.excluded.length;
      const after =
        (findings[index]?.supporting.length ?? 0) +
        (findings[index]?.opposing.length ?? 0) +
        (findings[index]?.context.length ?? 0) +
        (findings[index]?.excluded.length ?? 0);
      withheldPerClaim.set(finding.claimId, before - after);
    });
    for (const claim of claims) {
      claim.withheld = withheldPerClaim.get(claim.claimId) ?? 0;
    }
  }

  return {
    report: { ...report, findings },
    claims,
    disclosure: {
      policy: "retain-and-label",
      scope,
      statement:
        scope === "all" ? STATEMENT_ALL : statementVerified(withheldCitations),
      withheld: { citations: withheldCitations, materials: 0 },
      verificationLegend: VERIFICATION_LEGEND
    }
  };
}

/* ------------------------------------------------------------------ */
/* The decision arena: its audit package carried no material at all.    */
/* ------------------------------------------------------------------ */

const MATERIAL_LABEL: Record<Evidence["verificationStatus"], string> = {
  verified: "已核实",
  unverified: "待核实",
  rejected: "已驳回"
};

export type ArenaAuditMaterial = {
  evidenceId: string;
  /** One excerpt can bear on several claims, so this is the whole list. */
  claimIds: string[];
  title: string;
  direction: Evidence["direction"];
  verificationStatus: Evidence["verificationStatus"];
  /** The label a reader sees, so the package explains itself without a legend. */
  verificationLabel: string;
  reliability: number;
  verifiedBy: string | null;
  verificationNote: string | null;
  sourceId: string | null;
  excerpt: string;
};

export function toAuditMaterial(evidence: Evidence): ArenaAuditMaterial {
  return {
    evidenceId: evidence.id,
    claimIds: [...evidence.claimIds],
    title: evidence.title,
    direction: evidence.direction,
    verificationStatus: evidence.verificationStatus,
    verificationLabel: MATERIAL_LABEL[evidence.verificationStatus],
    reliability: evidence.reliability,
    verifiedBy: evidence.verifiedBy ?? null,
    verificationNote: evidence.verificationNote ?? null,
    sourceId: evidence.sourceId ?? null,
    excerpt: evidence.content
  };
}

export type ScopedArenaMaterials = {
  materials: ArenaAuditMaterial[];
  disclosure: AuditDisclosure;
};

/**
 * The decision report's material, labelled, and filtered only when asked.
 *
 * Before this the arena audit package held a report and an event log but not
 * one row of the evidence the report was decided on — a reader outside the
 * workspace could see the verdict and could not see a single excerpt behind
 * it, verified or not.
 */
export function scopeArenaMaterials(
  evidence: readonly Evidence[],
  scope: AuditScope
): ScopedArenaMaterials {
  const all = evidence.map(toAuditMaterial);
  const materials =
    scope === "all"
      ? all
      : all.filter((item) => item.verificationStatus === "verified");

  return {
    materials,
    disclosure: {
      policy: "retain-and-label",
      scope,
      statement:
        scope === "all"
          ? STATEMENT_ALL
          : statementVerified(all.length - materials.length),
      withheld: { citations: 0, materials: all.length - materials.length },
      verificationLegend: VERIFICATION_LEGEND
    }
  };
}
