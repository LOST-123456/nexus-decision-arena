import { z } from "zod";
import { IdSchema, TimestampSchema } from "../ids";
import type { Claim } from "../domain/claim";
import { evidenceCoversClaim, type Evidence } from "../domain/evidence";
import { applyReviewToStatus } from "./review-outcome";

/**
 * Fact-check verdict — deliberately NOT the same thing as:
 *   - session phase / operationalStatus   (workflow state)
 *   - evidence.verificationStatus         (status of one excerpt)
 *   - claim.status                        (business status inside the debate)
 *   - ClaimReview.outcome                 (a human ruling on the conclusion)
 *
 * A verdict answers "what can we responsibly conclude about this claim given
 * the evidence we actually verified and the cross-examination we actually ran".
 * It is computed, never typed in by hand, and it can express doubt: absence of
 * opposing evidence is not proof, unverified material can never produce a
 * positive conclusion, and an unresolved challenge blocks a directional
 * conclusion even when several agents agree.
 */
export const ClaimVerdictStatusSchema = z.enum([
  /** Nothing was recorded for this claim. */
  "unsupported",
  /** Evidence exists but none of it has been verified yet. */
  "insufficient_evidence",
  /** Only background material was verified. */
  "context_only",
  /** Verified support, no verified opposition, no open challenge against it. */
  "supported",
  /** Verified opposition, no verified support, no open challenge against it. */
  "refuted",
  /** Verified material points both ways. */
  "mixed_evidence",
  /**
   * Verified material points one way, but cross-examination left a
   * high-severity challenge open, so no direction can be asserted.
   */
  "inconclusive"
]);

export type ClaimVerdictStatus = z.infer<typeof ClaimVerdictStatusSchema>;

/**
 * Which rule produced the verdict. A conclusion has to be explainable without
 * re-reading prose, so every verdict records the rule it fired; nothing is
 * inferred by a consumer from the status string alone.
 */
export const ClaimVerdictRuleSchema = z.enum([
  /** No material is attached at all. */
  "no_evidence",
  /** Material exists but not one excerpt has been verified. */
  "no_verified_evidence",
  /** Verified support and verified opposition both exist. */
  "verified_support_and_opposition",
  /** Verified support exists, but an unresolved severe challenge blocks it. */
  "support_blocked_by_open_challenge",
  /** Verified opposition exists, but an unresolved severe challenge blocks it. */
  "opposition_blocked_by_open_challenge",
  /** Verified support only, nothing opposing, no blocking challenge. */
  "verified_support_only",
  /** Verified opposition only, nothing supporting, no blocking challenge. */
  "verified_opposition_only",
  /** Only verified background material. */
  "verified_context_only"
]);

export type ClaimVerdictRule = z.infer<typeof ClaimVerdictRuleSchema>;

/** Why one excerpt did not take part in the verdict. */
export const ClaimVerdictExclusionSchema = z.object({
  evidenceId: IdSchema,
  reason: z.enum(["unverified", "rejected", "expired", "not_yet_effective"])
});

export type ClaimVerdictExclusion = z.infer<typeof ClaimVerdictExclusionSchema>;

/** Minimal shape of a cross-examination challenge the verdict rules consume. */
export type VerdictChallengeSignal = {
  /**
   * Only used to explain *which* challenge blocked a conclusion. Callers that
   * cannot supply ids still get a correct verdict, just a less specific
   * explanation.
   */
  id?: string;
  targetClaimId: string;
  status: "open" | "answered" | "validating" | "resolved" | "unresolved";
  severity: number;
  question: string;
  requiredEvidence: readonly string[];
  resolutionStrategy:
    | "provide_evidence"
    | "revise_claim"
    | "withdraw_claim"
    | "human_decision";
  createdAt?: string;
};

/** Minimal shape of a human ruling the verdict rules consume. */
export type VerdictReviewSignal = {
  claimId: string;
  outcome: "confirmed" | "rejected" | "needs_more_evidence";
  rationale: string;
  reviewer: string;
  evidenceIds?: readonly string[];
  sourceIds?: readonly string[];
  verdictStatusAtReview: ClaimVerdictStatus;
  verdictConfidenceAtReview: number;
  createdAt: string;
};

export const ClaimVerdictSchema = z.object({
  claimId: IdSchema,
  /** Derived from evidence + cross-examination. Never typed in by a human. */
  status: ClaimVerdictStatusSchema,
  /** 0..1, deliberately capped below 1 — a verdict is never certainty. */
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1),
  counts: z.object({
    total: z.number().int().min(0),
    verified: z.number().int().min(0),
    unverified: z.number().int().min(0),
    rejected: z.number().int().min(0),
    expired: z.number().int().min(0),
    notYetEffective: z.number().int().min(0),
    verifiedSupporting: z.number().int().min(0),
    verifiedOpposing: z.number().int().min(0),
    verifiedContext: z.number().int().min(0)
  }),
  /** True when material exists that could still change the verdict. */
  needsWork: z.boolean(),
  /**
   * Which excerpts actually took part, split by the direction they were counted
   * in. A verdict that cannot name its inputs cannot be audited.
   */
  basis: z.object({
    supportingEvidenceIds: z.array(IdSchema).default([]),
    opposingEvidenceIds: z.array(IdSchema).default([]),
    contextEvidenceIds: z.array(IdSchema).default([])
  }),
  /**
   * Excerpts that were deliberately left out, each with the reason. Material
   * does not disappear silently: an omission is recorded.
   */
  excluded: z.array(ClaimVerdictExclusionSchema).default([]),
  /** The rules that fired, most significant first. Never empty. */
  ruleHits: z.array(ClaimVerdictRuleSchema).min(1),
  /**
   * How the confidence number was produced. This is an evidence-weight
   * heuristic, NOT a calibrated probability, and never a model's self-report.
   */
  confidenceBasis: z.array(z.string()).default([]),
  /** Challenge questions that cross-examination left unanswered. */
  openQuestions: z.array(z.string()).default([]),
  /** Why the conclusion cannot be stated more broadly. */
  limits: z.array(z.string()).default([]),
  /** What cross-examination contributed. */
  crossReview: z
    .object({
      challenges: z.number().int().min(0),
      unresolved: z.number().int().min(0),
      severeUnresolved: z.number().int().min(0),
      unresolvedChallengeIds: z.array(IdSchema).default([]),
      severeUnresolvedChallengeIds: z.array(IdSchema).default([]),
      lastReviewedAt: TimestampSchema.nullable().default(null)
    })
    .default({
      challenges: 0,
      unresolved: 0,
      severeUnresolved: 0,
      unresolvedChallengeIds: [],
      severeUnresolvedChallengeIds: [],
      lastReviewedAt: null
    }),
  /** Latest human ruling, if any. The full history is kept separately. */
  review: z
    .object({
      outcome: z.enum(["confirmed", "rejected", "needs_more_evidence"]),
      reviewer: z.string().min(1),
      rationale: z.string().min(1),
      createdAt: TimestampSchema,
      evidenceIds: z.array(IdSchema).default([]),
      sourceIds: z.array(IdSchema).default([])
    })
    .nullable()
    .default(null),
  /**
   * What downstream surfaces should present: the derived status, overridden by
   * a human ruling when one exists. Both stay visible so the derived status
   * cannot be quietly replaced by a person's decision.
   */
  effectiveStatus: ClaimVerdictStatusSchema
});

export type ClaimVerdict = z.infer<typeof ClaimVerdictSchema>;

const MAX_CONFIDENCE = 0.95;
/** A challenge this severe that stays open blocks a directional conclusion. */
export const SEVERE_CHALLENGE_THRESHOLD = 4;
/** Ceiling applied once an open severe challenge blocks a conclusion. */
const INCONCLUSIVE_CONFIDENCE = 0.4;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Evidence whose declared validity window has closed no longer supports a
 * conclusion about the present, so it is excluded from the verdict and counted
 * separately.
 */
export function isEvidenceExpired(
  item: Pick<Evidence, "validityPeriod">,
  now = new Date()
): boolean {
  const to = item.validityPeriod?.to;
  if (!to) {
    return false;
  }
  const end = new Date(to).getTime();
  return Number.isFinite(end) && end < now.getTime();
}

/**
 * Evidence whose validity window has not opened yet does not describe the
 * present either; it is excluded and surfaced as a scope limit instead.
 */
export function isEvidenceNotYetEffective(
  item: Pick<Evidence, "validityPeriod">,
  now = new Date()
): boolean {
  const from = item.validityPeriod?.from;
  if (!from) {
    return false;
  }
  const start = new Date(from).getTime();
  return Number.isFinite(start) && start > now.getTime();
}

function reliabilityTotal(items: readonly Evidence[]): number {
  return items.reduce((sum, item) => sum + clamp01(item.reliability), 0);
}

export function evidenceForClaim(
  evidence: readonly Evidence[],
  claimId: string
): Evidence[] {
  return evidence.filter((item) => evidenceCoversClaim(item, claimId));
}

export function summarizeVerification(evidence: readonly Evidence[]) {
  let verified = 0;
  let unverified = 0;
  let rejected = 0;
  for (const item of evidence) {
    if (item.verificationStatus === "verified") {
      verified += 1;
    } else if (item.verificationStatus === "rejected") {
      rejected += 1;
    } else {
      unverified += 1;
    }
  }
  return { verified, unverified, rejected, total: evidence.length };
}

export function challengesForClaim(
  challenges: readonly VerdictChallengeSignal[],
  claimId: string
): VerdictChallengeSignal[] {
  return challenges.filter((challenge) => challenge.targetClaimId === claimId);
}

export type CrossReviewSummary = {
  challenges: number;
  unresolved: number;
  severeUnresolved: number;
  unresolvedChallengeIds: string[];
  severeUnresolvedChallengeIds: string[];
  lastReviewedAt: string | null;
  openQuestions: string[];
};

/**
 * A challenge counts as unresolved while it is not `resolved`. `answered` and
 * `validating` are still in flight: the challenger asked and nobody has shown
 * the question to be irrelevant.
 */
export function summarizeCrossReview(
  challenges: readonly VerdictChallengeSignal[]
): CrossReviewSummary {
  const unresolved = challenges.filter(
    (challenge) => challenge.status !== "resolved"
  );
  const severeUnresolved = unresolved.filter(
    (challenge) => challenge.severity >= SEVERE_CHALLENGE_THRESHOLD
  );
  const timestamps = challenges
    .map((challenge) => challenge.createdAt)
    .filter((value): value is string => typeof value === "string")
    .sort();
  const idsOf = (items: readonly VerdictChallengeSignal[]): string[] =>
    items
      .map((challenge) => challenge.id)
      .filter((value): value is string => typeof value === "string")
      .sort();

  return {
    challenges: challenges.length,
    unresolved: unresolved.length,
    severeUnresolved: severeUnresolved.length,
    unresolvedChallengeIds: idsOf(unresolved),
    severeUnresolvedChallengeIds: idsOf(severeUnresolved),
    lastReviewedAt: timestamps.length > 0 ? timestamps[timestamps.length - 1]! : null,
    openQuestions: unresolved
      .slice()
      .sort((left, right) => right.severity - left.severity)
      .slice(0, 5)
      .map((challenge) => challenge.question)
  };
}

function pickLatestReview(
  reviews: readonly VerdictReviewSignal[]
): VerdictReviewSignal | null {
  let latest: VerdictReviewSignal | null = null;
  for (const review of reviews) {
    if (!latest || review.createdAt > latest.createdAt) {
      latest = review;
    }
  }
  return latest;
}

export type DeriveClaimVerdictOptions = {
  now?: Date;
  /** Cross-examination challenges recorded for the session. */
  challenges?: readonly VerdictChallengeSignal[];
  /** Human rulings recorded for the session. */
  reviews?: readonly VerdictReviewSignal[];
};

/**
 * Deterministic projection from claim + evidence + cross-examination + human
 * rulings to a fact-check verdict. Pure: no I/O, and the only clock is `now`.
 */
export function deriveClaimVerdict(
  claim: Pick<Claim, "id">,
  evidence: readonly Evidence[],
  options: DeriveClaimVerdictOptions = {}
): ClaimVerdict {
  const now = options.now ?? new Date();
  const related = evidenceForClaim(evidence, claim.id);
  const live = related.filter(
    (item) =>
      !isEvidenceExpired(item, now) && !isEvidenceNotYetEffective(item, now)
  );
  const expired = related.filter((item) => isEvidenceExpired(item, now)).length;
  const notYetEffective = related.filter((item) =>
    isEvidenceNotYetEffective(item, now)
  ).length;

  const verified = live.filter((item) => item.verificationStatus === "verified");
  const supports = verified.filter((item) => item.direction === "supports");
  const opposes = verified.filter((item) => item.direction === "opposes");
  const context = verified.filter((item) => item.direction === "context");

  const crossReview = summarizeCrossReview(
    challengesForClaim(options.challenges ?? [], claim.id)
  );
  const review = pickLatestReview(
    (options.reviews ?? []).filter((item) => item.claimId === claim.id)
  );

  const counts = {
    total: related.length,
    verified: verified.length,
    unverified: live.filter((item) => item.verificationStatus === "unverified")
      .length,
    rejected: live.filter((item) => item.verificationStatus === "rejected")
      .length,
    expired,
    notYetEffective,
    verifiedSupporting: supports.length,
    verifiedOpposing: opposes.length,
    verifiedContext: context.length
  };

  const limits: string[] = [];
  if (expired > 0) {
    limits.push(`${expired} 条材料已超出有效期，未参与本结论。`);
  }
  if (notYetEffective > 0) {
    limits.push(`${notYetEffective} 条材料的有效期尚未开始，未参与本结论。`);
  }
  if (counts.unverified > 0) {
    limits.push(`${counts.unverified} 条材料尚未核实，不能作为结论依据。`);
  }
  if (crossReview.severeUnresolved > 0) {
    limits.push(
      `存在 ${crossReview.severeUnresolved} 项高严重度未解决质询，结论只在本轮审查范围内成立。`
    );
  }

  const base = {
    claimId: claim.id,
    counts,
    limits,
    openQuestions: crossReview.openQuestions,
    basis: {
      supportingEvidenceIds: supports.map((item) => item.id).sort(),
      opposingEvidenceIds: opposes.map((item) => item.id).sort(),
      contextEvidenceIds: context.map((item) => item.id).sort()
    },
    excluded: related
      .map((item) => {
        if (isEvidenceExpired(item, now)) {
          return { evidenceId: item.id, reason: "expired" as const };
        }
        if (isEvidenceNotYetEffective(item, now)) {
          return { evidenceId: item.id, reason: "not_yet_effective" as const };
        }
        if (item.verificationStatus === "rejected") {
          return { evidenceId: item.id, reason: "rejected" as const };
        }
        if (item.verificationStatus === "unverified") {
          return { evidenceId: item.id, reason: "unverified" as const };
        }
        return null;
      })
      .filter((entry): entry is ClaimVerdictExclusion => entry !== null)
      .sort((left, right) => left.evidenceId.localeCompare(right.evidenceId)),
    crossReview: {
      challenges: crossReview.challenges,
      unresolved: crossReview.unresolved,
      severeUnresolved: crossReview.severeUnresolved,
      unresolvedChallengeIds: crossReview.unresolvedChallengeIds,
      severeUnresolvedChallengeIds: crossReview.severeUnresolvedChallengeIds,
      lastReviewedAt: crossReview.lastReviewedAt
    },
    review: review
      ? {
          outcome: review.outcome,
          reviewer: review.reviewer,
          rationale: review.rationale,
          createdAt: review.createdAt,
          evidenceIds: [...(review.evidenceIds ?? [])],
          sourceIds: [...(review.sourceIds ?? [])]
        }
      : null
  };

  const derived = deriveBaseStatus(
    { counts },
    {
      related: related.length,
      supports,
      opposes,
      context,
      crossReview,
      expired,
      notYetEffective
    }
  );

  return ClaimVerdictSchema.parse({
    ...base,
    status: derived.status,
    confidence: derived.confidence,
    rationale: derived.rationale,
    ruleHits: derived.ruleHits,
    confidenceBasis: derived.confidenceBasis,
    needsWork:
      related.length === 0 ||
      verified.length === 0 ||
      counts.unverified > 0 ||
      expired > 0 ||
      notYetEffective > 0 ||
      crossReview.severeUnresolved > 0 ||
      (review?.outcome ?? null) === "needs_more_evidence",
    effectiveStatus: applyReviewToStatus(derived.status, review?.outcome ?? null)
  });
}

function deriveBaseStatus(
  base: {
    counts: ClaimVerdict["counts"];
  },
  input: {
    related: number;
    supports: readonly Evidence[];
    opposes: readonly Evidence[];
    context: readonly Evidence[];
    crossReview: CrossReviewSummary;
    expired: number;
    notYetEffective: number;
  }
): {
  status: ClaimVerdictStatus;
  confidence: number;
  rationale: string;
  ruleHits: ClaimVerdictRule[];
  confidenceBasis: string[];
} {
  const { counts } = base;
  const excludedParts: string[] = [];
  if (input.expired > 0) {
    excludedParts.push(
      `${input.expired} item(s) fell outside their validity window and were excluded.`
    );
  }
  if (input.notYetEffective > 0) {
    excludedParts.push(
      `${input.notYetEffective} item(s) are not effective yet and were excluded.`
    );
  }
  const excludedNote =
    excludedParts.length > 0 ? ` ${excludedParts.join(" ")}` : "";
  const pendingNote =
    counts.unverified > 0
      ? ` ${counts.unverified} item(s) are still unverified and cannot be counted.`
      : "";

  if (input.related === 0) {
    return {
      status: "unsupported",
      confidence: 0,
      rationale:
        "No evidence is attached to this claim, so no conclusion can be drawn.",
      ruleHits: ["no_evidence"],
      confidenceBasis: ["没有任何关联材料参与判断，把握度为 0。"]
    };
  }

  if (counts.verified === 0) {
    return {
      status: "insufficient_evidence",
      confidence: 0,
      rationale:
        `${input.related} evidence item(s) are attached but none is verified, ` +
        "so the claim stays unresolved." +
        excludedNote +
        pendingNote,
      ruleHits: ["no_verified_evidence"],
      confidenceBasis: [
        `已核实材料 0 条，无法形成方向性结论；${input.related} 条材料中有 ${counts.unverified} 条尚未核实。`,
        "Agent 之间是否一致不参与本条判定。"
      ]
    };
  }

  const supportWeight = reliabilityTotal(input.supports);
  const opposeWeight = reliabilityTotal(input.opposes);

  if (input.supports.length > 0 && input.opposes.length > 0) {
    const spread =
      Math.abs(supportWeight - opposeWeight) /
      Math.max(0.0001, supportWeight + opposeWeight);
    return {
      status: "mixed_evidence",
      confidence: clamp01(Math.min(0.6, 0.2 + 0.3 * spread)),
      rationale:
        `${input.supports.length} verified item(s) support and ${input.opposes.length} oppose ` +
        "this claim; the disagreement is unresolved." +
        excludedNote +
        pendingNote,
      ruleHits: ["verified_support_and_opposition"],
      confidenceBasis: [
        `已核实支持 ${input.supports.length} 条（可靠度合计 ${supportWeight.toFixed(2)}）与已核实反对 ${input.opposes.length} 条（合计 ${opposeWeight.toFixed(2)}）并存。`,
        `把握度 = min(0.6, 0.2 + 0.3 × 权重差比 ${spread.toFixed(2)})，上限 0.6；这是证据权重的启发式，不是统计概率。`
      ]
    };
  }

  if (input.supports.length > 0) {
    const depth = Math.min(1, supportWeight / 2);
    const breadth = Math.min(1, input.supports.length / 2);
    const confidence = clamp01(
      Math.min(MAX_CONFIDENCE, 0.35 + 0.4 * depth + 0.2 * breadth)
    );
    const formula =
      `把握度 = min(0.95, 0.35 + 0.4 × 深度 ${depth.toFixed(2)} + 0.2 × 广度 ${breadth.toFixed(2)}) = ${confidence.toFixed(2)}；` +
      "由已核实证据的可靠度与条数推导，不是模型自报的概率。";
    if (input.crossReview.severeUnresolved > 0) {
      return {
        status: "inconclusive",
        confidence: clamp01(Math.min(INCONCLUSIVE_CONFIDENCE, confidence)),
        rationale:
          `${input.supports.length} verified item(s) support this claim, but ` +
          `${input.crossReview.severeUnresolved} high-severity challenge(s) from cross-examination ` +
          "are still open, so the support cannot be asserted." +
          excludedNote +
          pendingNote,
        ruleHits: [
          "support_blocked_by_open_challenge",
          "verified_support_only"
        ],
        confidenceBasis: [
          formula,
          `存在 ${input.crossReview.severeUnresolved} 项严重度 ≥ ${SEVERE_CHALLENGE_THRESHOLD} 且未解决的质询，把握度被压到 ${INCONCLUSIVE_CONFIDENCE} 以下。`
        ]
      };
    }
    return {
      status: "supported",
      confidence,
      rationale:
        `${input.supports.length} verified item(s) support this claim and none opposes it.` +
        excludedNote +
        pendingNote,
      ruleHits: ["verified_support_only"],
      confidenceBasis: [formula]
    };
  }

  if (input.opposes.length > 0) {
    const depth = Math.min(1, opposeWeight / 2);
    const breadth = Math.min(1, input.opposes.length / 2);
    const confidence = clamp01(
      Math.min(MAX_CONFIDENCE, 0.35 + 0.4 * depth + 0.2 * breadth)
    );
    const formula =
      `把握度 = min(0.95, 0.35 + 0.4 × 深度 ${depth.toFixed(2)} + 0.2 × 广度 ${breadth.toFixed(2)}) = ${confidence.toFixed(2)}；` +
      "由已核实证据的可靠度与条数推导，不是模型自报的概率。";
    if (input.crossReview.severeUnresolved > 0) {
      return {
        status: "inconclusive",
        confidence: clamp01(Math.min(INCONCLUSIVE_CONFIDENCE, confidence)),
        rationale:
          `${input.opposes.length} verified item(s) contradict this claim, but ` +
          `${input.crossReview.severeUnresolved} high-severity challenge(s) are still open, ` +
          "so the contradiction cannot be asserted." +
          excludedNote +
          pendingNote,
        ruleHits: [
          "opposition_blocked_by_open_challenge",
          "verified_opposition_only"
        ],
        confidenceBasis: [
          formula,
          `存在 ${input.crossReview.severeUnresolved} 项严重度 ≥ ${SEVERE_CHALLENGE_THRESHOLD} 且未解决的质询，把握度被压到 ${INCONCLUSIVE_CONFIDENCE} 以下。`
        ]
      };
    }
    return {
      status: "refuted",
      confidence,
      rationale:
        `${input.opposes.length} verified item(s) contradict this claim and none supports it.` +
        excludedNote +
        pendingNote,
      ruleHits: ["verified_opposition_only"],
      confidenceBasis: [formula]
    };
  }

  return {
    status: "context_only",
    confidence: 0.1,
    rationale:
      `Only background material (${input.context.length} verified item(s)) was found; ` +
      "it neither supports nor contradicts the claim." +
      excludedNote +
      pendingNote,
    ruleHits: ["verified_context_only"],
    confidenceBasis: [
      "只有背景材料参与判断，不构成支持或反对；固定给最低把握度 0.1。"
    ]
  };
}

export function deriveClaimVerdicts(
  claims: readonly Pick<Claim, "id">[],
  evidence: readonly Evidence[],
  options: DeriveClaimVerdictOptions = {}
): ClaimVerdict[] {
  return claims.map((claim) => deriveClaimVerdict(claim, evidence, options));
}

/** Recounts `needsWork` after a caller narrows the input set. */
export function countOpenVerdicts(verdicts: readonly ClaimVerdict[]): number {
  return verdicts.filter((verdict) => verdict.needsWork).length;
}
