import { ResearchWorkspace } from "../../../features/research/research-workspace";

const GAP_ACTIONS = [
  "record_source",
  "verify_evidence",
  "add_supporting_evidence",
  "add_opposing_evidence",
  "add_primary_source",
  "run_cross_review"
] as const;

type GapAction = (typeof GAP_ACTIONS)[number];

function isGapAction(value: string | undefined): value is GapAction {
  return (GAP_ACTIONS as readonly string[]).includes(value ?? "");
}

export default async function ResearchWorkspacePage({
  params,
  searchParams
}: {
  params: Promise<{ sessionId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { sessionId } = await params;
  const query = await searchParams;
  const intent = typeof query.intent === "string" ? query.intent : undefined;
  const claimId = typeof query.claimId === "string" ? query.claimId : undefined;
  const evidenceId =
    typeof query.evidenceId === "string" ? query.evidenceId : undefined;

  // A gap action in the report links here carrying the action it wants. Only a
  // known action paired with a claim is honoured; anything else is ignored
  // rather than guessed at.
  const initialIntent =
    isGapAction(intent) && claimId
      ? {
          action: intent,
          claimId,
          evidenceIds: evidenceId ? [evidenceId] : []
        }
      : null;

  return (
    <main id="main" tabIndex={-1}>
      <ResearchWorkspace sessionId={sessionId} initialIntent={initialIntent} />
    </main>
  );
}
