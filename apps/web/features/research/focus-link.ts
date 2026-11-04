/**
 * The one vocabulary for "link me to a row in the workspace".
 *
 * A fact-check report is read to be acted on, so a citation in it links back to
 * the excerpt it quotes. Two halves have to agree for that to work: the page
 * that *writes* the link (`fact-check-report-body`) and the page that *reads*
 * the query string (`app/research/[sessionId]`). Keeping the target names in
 * one module is what stops them drifting into a link that silently opens
 * nothing.
 *
 * Deliberately separate from the gap-action intent: an intent names a form to
 * open and needs a claim; a focus just puts the row in front of the reader.
 */

export const FOCUS_TARGETS = ["claim", "evidence"] as const;

export type FocusTarget = (typeof FOCUS_TARGETS)[number];

export function isFocusTarget(value: string | undefined): value is FocusTarget {
  return (FOCUS_TARGETS as readonly string[]).includes(value ?? "");
}

/**
 * A href that opens one row.
 *
 * The id is always carried for the target that was asked for and never for the
 * other one, so a link can only ever mean one thing.
 */
export function workspaceFocusHref(
  sessionId: string,
  target: { kind: "claim"; claimId: string } | { kind: "evidence"; evidenceId: string }
): string {
  const query = new URLSearchParams({ focus: target.kind });
  if (target.kind === "claim") {
    query.set("claimId", target.claimId);
  } else {
    query.set("evidenceId", target.evidenceId);
  }
  return `/research/${sessionId}?${query.toString()}`;
}
