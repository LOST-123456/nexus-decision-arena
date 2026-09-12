import type { Challenge, Claim, Evidence } from "../index";

export function assertClaimInvariants(
  claim: Claim,
  evidence: Evidence[],
  challenges: Challenge[] = []
): void {
  if (claim.rootClaimId === claim.id && claim.revision !== 1) {
    throw new Error("Root claim revision must be 1");
  }

  if (claim.rootClaimId !== claim.id && claim.revision <= 1) {
    throw new Error("A revision must have revision greater than 1");
  }

  if (claim.revision > 1 && !claim.revisionOfClaimId) {
    throw new Error("A revision must reference its predecessor");
  }

  if (
    claim.status === "accepted" &&
    claim.importance >= 4 &&
    !evidence.some(
      (item) =>
        item.claimId === claim.id &&
        item.verificationStatus === "verified"
    )
  ) {
    throw new Error(
      "Accepted important claims require verified evidence"
    );
  }

  if (
    claim.status === "accepted" &&
    claim.importance >= 4 &&
    challenges.some(
      (challenge) =>
        challenge.targetClaimId === claim.id &&
        challenge.severity >= 4 &&
        challenge.status !== "resolved"
    )
  ) {
    throw new Error(
      "Accepted important claims cannot have unresolved severe challenges"
    );
  }

  const ids = new Set(claim.evidenceIds);
  if (evidence.some((item) => !ids.has(item.id))) {
    throw new Error("Evidence references must be declared on the claim");
  }
}
