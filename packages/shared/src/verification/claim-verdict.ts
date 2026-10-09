import { z } from "zod";
import { IdSchema } from "../ids";
import type { Claim } from "../domain/claim";
import { evidenceCoversClaim, type Evidence } from "../domain/evidence";

/**
 * Fact-check verdict — deliberately NOT the same thing as:
 *   - session phase / operationalStatus   (workflow state)
 *   - evidence.verificationStatus         (status of one excerpt)
 *   - claim.status                        (business status inside the debate)
 *
 * A verdict answers "what can we responsibly conclude about this claim given
 * the evidence we actually verified". It is computed, never typed in by hand,
 * and it can express doubt: absence of opposing evidence is not proof, and
 * unverified material can never produce a positive conclusion.
 */
export const ClaimVerdictStatusSchema = z.enum([
  /** Nothing was recorded for this claim. */
  "unsupported",
  /** Evidence exists but none of it has been verified yet. */
  "insufficient_evidence",
  /** Only background material was verified. */
  "context_only",
  /** Verified support, no verified opposition. */
  "supported",
  /** Verified opposition, no verified support. */
  "refuted",
  /** Verified material points both ways. */
  "mixed_evidence"
]);

export type ClaimVerdictStatus = z.infer<typeof ClaimVerdictStatusSchema>;

export const ClaimVerdictSchema = z.object({
  claimId: IdSchema,
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
    verifiedSupporting: z.number().int().min(0),
    verifiedOpposing: z.number().int().min(0),
    verifiedContext: z.number().int().min(0)
  }),
  /** True when material exists that could still change the verdict. */
  needsWork: z.boolean()
});

export type ClaimVerdict = z.infer<typeof ClaimVerdictSchema>;

const MAX_CONFIDENCE = 0.95;

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

/**
 * Deterministic projection from claim + evidence to a fact-check verdict.
 * Pure: no I/O, no clock injected by callers except through `now`.
 */
export function deriveClaimVerdict(
  claim: Pick<Claim, "id">,
  evidence: readonly Evidence[],
  options: { now?: Date } = {}
): ClaimVerdict {
  const now = options.now ?? new Date();
  const related = evidenceForClaim(evidence, claim.id);
  const live = related.filter((item) => !isEvidenceExpired(item, now));
  const expired = related.length - live.length;

  const verified = live.filter((item) => item.verificationStatus === "verified");
  const supports = verified.filter((item) => item.direction === "supports");
  const opposes = verified.filter((item) => item.direction === "opposes");
  const context = verified.filter((item) => item.direction === "context");

  const counts = {
    total: related.length,
    verified: verified.length,
    unverified: live.filter((item) => item.verificationStatus === "unverified")
      .length,
    rejected: live.filter((item) => item.verificationStatus === "rejected")
      .length,
    expired,
    verifiedSupporting: supports.length,
    verifiedOpposing: opposes.length,
    verifiedContext: context.length
  };

  const unverifiedPending = counts.unverified > 0;
  const expiredNote =
    expired > 0
      ? ` ${expired} item(s) fell outside their validity window and were excluded.`
      : "";
  const pendingNote = unverifiedPending
    ? ` ${counts.unverified} item(s) are still unverified and cannot be counted.`
    : "";

  const base = {
    claimId: claim.id,
    counts,
    needsWork:
      related.length === 0 ||
      verified.length === 0 ||
      unverifiedPending ||
      expired > 0
  };

  if (related.length === 0) {
    return ClaimVerdictSchema.parse({
      ...base,
      status: "unsupported",
      confidence: 0,
      rationale:
        "No evidence is attached to this claim, so no conclusion can be drawn."
    });
  }

  if (verified.length === 0) {
    return ClaimVerdictSchema.parse({
      ...base,
      status: "insufficient_evidence",
      confidence: 0,
      rationale:
        `${related.length} evidence item(s) are attached but none is verified, ` +
        "so the claim stays unresolved." + expiredNote + pendingNote
    });
  }

  const supportWeight = reliabilityTotal(supports);
  const opposeWeight = reliabilityTotal(opposes);

  if (supports.length > 0 && opposes.length > 0) {
    const spread =
      Math.abs(supportWeight - opposeWeight) /
      Math.max(0.0001, supportWeight + opposeWeight);
    return ClaimVerdictSchema.parse({
      ...base,
      status: "mixed_evidence",
      confidence: clamp01(Math.min(0.6, 0.2 + 0.3 * spread)),
      rationale:
        `${supports.length} verified item(s) support and ${opposes.length} oppose ` +
        "this claim; the disagreement is unresolved." + expiredNote + pendingNote
    });
  }

  if (supports.length > 0) {
    const depth = Math.min(1, supportWeight / 2);
    const breadth = Math.min(1, supports.length / 2);
    return ClaimVerdictSchema.parse({
      ...base,
      status: "supported",
      confidence: clamp01(
        Math.min(MAX_CONFIDENCE, 0.35 + 0.4 * depth + 0.2 * breadth)
      ),
      rationale:
        `${supports.length} verified item(s) support this claim and none opposes it.` +
        expiredNote +
        pendingNote
    });
  }

  if (opposes.length > 0) {
    const depth = Math.min(1, opposeWeight / 2);
    const breadth = Math.min(1, opposes.length / 2);
    return ClaimVerdictSchema.parse({
      ...base,
      status: "refuted",
      confidence: clamp01(
        Math.min(MAX_CONFIDENCE, 0.35 + 0.4 * depth + 0.2 * breadth)
      ),
      rationale:
        `${opposes.length} verified item(s) contradict this claim and none supports it.` +
        expiredNote +
        pendingNote
    });
  }

  return ClaimVerdictSchema.parse({
    ...base,
    status: "context_only",
    confidence: 0.1,
    rationale:
      `Only background material (${context.length} verified item(s)) was found; ` +
      "it neither supports nor contradicts the claim." + expiredNote + pendingNote
  });
}

export function deriveClaimVerdicts(
  claims: readonly Pick<Claim, "id">[],
  evidence: readonly Evidence[],
  options: { now?: Date } = {}
): ClaimVerdict[] {
  return claims.map((claim) => deriveClaimVerdict(claim, evidence, options));
}
