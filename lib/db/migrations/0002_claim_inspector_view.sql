CREATE OR REPLACE VIEW claim_inspector_view AS
SELECT
  c.id AS claim_id,
  to_jsonb(c) AS claim,
  COALESCE(
    (
      SELECT jsonb_agg(to_jsonb(e) ORDER BY e.reliability DESC)
      FROM evidence e
      WHERE e.claim_id = c.id
    ),
    '[]'::jsonb
  ) AS evidence,
  COALESCE(
    (
      SELECT jsonb_agg(to_jsonb(ch) ORDER BY ch.created_at)
      FROM challenges ch
      WHERE ch.target_claim_id = c.id
         OR ch.response_claim_id = c.id
    ),
    '[]'::jsonb
  ) AS challenges,
  COALESCE(
    (
      SELECT jsonb_agg(to_jsonb(cf) ORDER BY cf.severity DESC)
      FROM conflicts cf
      WHERE cf.claim_ids ? c.id::text
    ),
    '[]'::jsonb
  ) AS conflicts
FROM claims c;
