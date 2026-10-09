import { z } from "zod";
import { IdSchema } from "../ids";
import type { Evidence } from "../domain/evidence";

/**
 * Evidence verification is a human act, separate from:
 *   - the session phase (workflow state),
 *   - claim.status (the claim's standing inside the debate),
 *   - the fact-check verdict (what can be concluded overall).
 *
 * These rules are pure so that the API, the repository and the UI all apply
 * exactly the same gate.
 */

export const EVIDENCE_VERIFICATION_STATUSES = [
  "unverified",
  "verified",
  "rejected"
] as const;

export const EvidenceVerificationStatusSchema = z.enum(
  EVIDENCE_VERIFICATION_STATUSES
);

export type EvidenceVerificationStatus = z.infer<
  typeof EvidenceVerificationStatusSchema
>;

export class EvidenceVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceVerificationError";
  }
}

/** Body the client may send. `verifiedBy` is deliberately absent: it comes
 *  from the authenticated actor so it cannot be forged. */
export const EvidenceVerificationRequestSchema = z.object({
  status: EvidenceVerificationStatusSchema,
  /** Why the excerpt was accepted, rejected, or sent back for checking. */
  verificationNote: z.string().trim().min(1).max(2000)
});

export type EvidenceVerificationRequest = z.infer<
  typeof EvidenceVerificationRequestSchema
>;

export type EvidenceVerificationPatch = {
  verificationStatus: EvidenceVerificationStatus;
  verifiedBy: string;
  verifiedAt: string;
  verificationNote: string;
};

export type EvidenceVerificationPlan = {
  evidenceId: string;
  from: EvidenceVerificationStatus;
  to: EvidenceVerificationStatus;
  patch: EvidenceVerificationPatch;
};

/**
 * Validates one verification transition and produces the column patch.
 * Throws `EvidenceVerificationError` when the transition is not allowed.
 *
 * The `verifiedBy` value is supplied by the caller from the authenticated
 * session, never from request input.
 */
export function planEvidenceVerification(input: {
  evidence: Pick<Evidence, "id" | "kind" | "verificationStatus">;
  status: EvidenceVerificationStatus;
  verifiedBy: string;
  verificationNote: string;
  now?: Date;
}): EvidenceVerificationPlan {
  const from = input.evidence.verificationStatus;
  const to = input.status;

  if (from === to) {
    throw new EvidenceVerificationError(
      `Evidence is already ${from}; a verification change must move to a different state.`
    );
  }

  const actor = input.verifiedBy.trim();
  if (actor === "") {
    throw new EvidenceVerificationError(
      "Verification requires an identified reviewer."
    );
  }

  const note = input.verificationNote.trim();
  if (note === "") {
    // Reverting to unverified also has to say why, otherwise the audit trail
    // would lose the reason a previously verified excerpt stopped counting.
    throw new EvidenceVerificationError(
      "A verification change requires a recorded reason."
    );
  }

  if (to === "verified" && input.evidence.kind === "assumption") {
    throw new EvidenceVerificationError(
      "Assumptions cannot be verified; they are not sourced material."
    );
  }

  return {
    evidenceId: input.evidence.id,
    from,
    to,
    patch: {
      verificationStatus: to,
      verifiedBy: actor,
      verifiedAt: (input.now ?? new Date()).toISOString(),
      verificationNote: note
    }
  };
}

/** True when the excerpt currently counts towards a conclusion. */
export function isVerifiedEvidence(
  item: Pick<Evidence, "verificationStatus">
): boolean {
  return item.verificationStatus === "verified";
}

export const EvidenceClaimLinkSchema = z.object({
  claimIds: z.array(IdSchema).min(1)
});

export type EvidenceClaimLink = z.infer<typeof EvidenceClaimLinkSchema>;
