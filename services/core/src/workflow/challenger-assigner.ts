import type { AgentRole, AgentRoleKey, Claim } from "@nexus/shared";

const preferredChallenger: Record<Claim["type"], AgentRoleKey[]> = {
  fact: ["risk_auditor", "review_moderator"],
  assumption: [
    "finance_analyst",
    "risk_auditor",
    "market_analyst",
    "technical_expert"
  ],
  prediction: [
    "market_analyst",
    "technical_expert",
    "finance_analyst",
    "risk_auditor"
  ],
  recommendation: [
    "risk_auditor",
    "review_moderator",
    "finance_analyst",
    "technical_expert"
  ]
};

export function assignChallengers(
  claim: Claim,
  roles: AgentRole[],
  limit = 2
): AgentRole[] {
  const safeLimit = Math.min(Math.max(limit, 0), 2);
  const preferred = preferredChallenger[claim.type];
  const seen = new Set<AgentRoleKey>();
  return roles
    .filter((role) => {
      if (role.id === claim.roleId || seen.has(role.key)) {
        return false;
      }
      seen.add(role.key);
      return true;
    })
    .sort((left, right) => {
      const leftRank = preferred.indexOf(left.key);
      const rightRank = preferred.indexOf(right.key);
      const normalizedLeft = leftRank === -1 ? Number.MAX_SAFE_INTEGER : leftRank;
      const normalizedRight =
        rightRank === -1 ? Number.MAX_SAFE_INTEGER : rightRank;
      return normalizedLeft - normalizedRight || left.id.localeCompare(right.id);
    })
    .slice(0, safeLimit);
}
