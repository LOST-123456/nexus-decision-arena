import type { Claim } from "@nexus/shared";

const typeRank: Record<Claim["type"], number> = {
  assumption: 0,
  prediction: 1,
  recommendation: 2,
  fact: 3
};

export function selectClaims(claims: Claim[], limit = 5): Claim[] {
  const safeLimit = Math.min(Math.max(limit, 0), 5);
  return [...claims]
    .sort((left, right) => {
      if (left.importance !== right.importance) {
        return right.importance - left.importance;
      }
      if (left.evidenceIds.length !== right.evidenceIds.length) {
        return left.evidenceIds.length - right.evidenceIds.length;
      }
      if (left.confidence !== right.confidence) {
        return left.confidence - right.confidence;
      }
      if (typeRank[left.type] !== typeRank[right.type]) {
        return typeRank[left.type] - typeRank[right.type];
      }
      return left.id.localeCompare(right.id);
    })
    .slice(0, safeLimit);
}
