import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

/**
 * Evidence is linked to claims through a jsonb array of claim ids, so the
 * lookup has to be an array containment test rather than an equality.
 */
export function evidenceCoversClaim(
  claimIdsColumn: SQLWrapper,
  claimId: string
): SQL {
  return sql`${claimIdsColumn} @> ${JSON.stringify([claimId])}::jsonb`;
}

export function evidenceCoversAnyClaim(
  claimIdsColumn: SQLWrapper,
  claimIds: readonly string[]
): SQL {
  const ids = [...new Set(claimIds)].filter(Boolean);
  if (ids.length === 0) {
    return sql`false`;
  }
  const clauses = ids.map((claimId) =>
    evidenceCoversClaim(claimIdsColumn, claimId)
  );
  return sql`(${sql.join(clauses, sql` OR `)})`;
}
