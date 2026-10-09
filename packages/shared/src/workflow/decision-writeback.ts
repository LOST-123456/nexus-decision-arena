import type { Claim, ClaimStatus } from "../domain/claim";
import type { Conflict, ConflictStatus } from "../domain/conflict";
import { evidenceCoversClaim, type Evidence } from "../domain/evidence";
import type { HumanDecision } from "../domain/human-decision";
import {
  canTransitionConflict,
  nextConflictStatusForDecision
} from "./conflict-state-machine";

/**
 * Terminal claim status implied by a human ruling.
 *
 * A ruling on a conflict between claims must leave a trace on the claims
 * themselves, otherwise the decision data keeps contradicting the recorded
 * audit trail.
 */
export const CLAIM_STATUS_BY_ACTION = {
  accept_challenge: "rejected",
  uphold_claim: "accepted",
  request_more_analysis: "contested"
} as const satisfies Record<HumanDecision["action"], ClaimStatus>;

/**
 * `assertClaimInvariants` forbids `accepted` on important claims without
 * verified evidence.
 */
export const VERIFIED_EVIDENCE_IMPORTANCE = 4;

export type DecisionWritebackReason =
  | "challenge_accepted"
  | "claim_upheld"
  | "claim_upheld_without_verified_evidence"
  | "supplement_requested";

export type DecisionClaimUpdate = {
  claimId: string;
  status: ClaimStatus;
  reason: DecisionWritebackReason;
};

export type DecisionWritebackPlan = {
  conflictId: string;
  conflictStatus: ConflictStatus;
  claimUpdates: DecisionClaimUpdate[];
};

export class DecisionWritebackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecisionWritebackError";
  }
}

export function hasVerifiedEvidence(
  claimId: string,
  evidence: readonly Evidence[]
): boolean {
  return evidence.some(
    (item) =>
      evidenceCoversClaim(item, claimId) && item.verificationStatus === "verified"
  );
}

/**
 * A human ruling cannot manufacture evidence. When an important claim has no
 * verified evidence the ruling is recorded as `supported` so the persisted
 * status stays consistent with the claim invariants.
 */
export function resolveUpheldClaimStatus(
  claim: Pick<Claim, "id" | "importance">,
  evidence: readonly Evidence[]
): ClaimStatus {
  if (
    claim.importance >= VERIFIED_EVIDENCE_IMPORTANCE &&
    !hasVerifiedEvidence(claim.id, evidence)
  ) {
    return "supported";
  }
  return "accepted";
}

/**
 * Pure projection of a recorded human decision onto the decision artefacts.
 * The caller owns persistence; this function only decides what must change and
 * fails closed when the requested change would contradict the conflict
 * lifecycle.
 */
export function decisionWritebackPlan(input: {
  action: HumanDecision["action"];
  conflict: Pick<Conflict, "id" | "status" | "claimIds">;
  claims: readonly Claim[];
  evidence: readonly Evidence[];
}): DecisionWritebackPlan {
  const conflictStatus = nextConflictStatusForDecision(input.action);
  if (
    conflictStatus !== input.conflict.status &&
    !canTransitionConflict(input.conflict.status, conflictStatus)
  ) {
    throw new DecisionWritebackError(
      `Conflict ${input.conflict.id} cannot move from ${input.conflict.status} to ${conflictStatus}`
    );
  }

  const conflictClaimIds = [...new Set(input.conflict.claimIds)];
  const claimUpdates: DecisionClaimUpdate[] = [];

  if (input.action === "request_more_analysis") {
    for (const claimId of conflictClaimIds) {
      claimUpdates.push({
        claimId,
        status: CLAIM_STATUS_BY_ACTION.request_more_analysis,
        reason: "supplement_requested"
      });
    }
    return { conflictId: input.conflict.id, conflictStatus, claimUpdates };
  }

  // A terminal ruling is unambiguous only when the conflict names a single
  // claim. A contradiction conflict ("A contradicts B") does not record which
  // side the human endorsed, so no claim is flipped and only the conflict is
  // closed.
  if (conflictClaimIds.length !== 1) {
    return { conflictId: input.conflict.id, conflictStatus, claimUpdates };
  }

  const [claimId] = conflictClaimIds as [string];
  const claim = input.claims.find((item) => item.id === claimId);
  if (!claim) {
    throw new DecisionWritebackError(
      `Claim ${claimId} referenced by conflict ${input.conflict.id} is not part of the decision session`
    );
  }

  if (input.action === "accept_challenge") {
    claimUpdates.push({
      claimId,
      status: CLAIM_STATUS_BY_ACTION.accept_challenge,
      reason: "challenge_accepted"
    });
    return { conflictId: input.conflict.id, conflictStatus, claimUpdates };
  }

  const status = resolveUpheldClaimStatus(claim, input.evidence);
  claimUpdates.push({
    claimId,
    status,
    reason:
      status === "accepted"
        ? "claim_upheld"
        : "claim_upheld_without_verified_evidence"
  });
  return { conflictId: input.conflict.id, conflictStatus, claimUpdates };
}
