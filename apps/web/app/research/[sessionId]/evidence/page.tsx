import { EvidenceExplorer } from "../../../../features/research/evidence-explorer";

export default async function EvidenceExplorerPage({
  params
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  return <EvidenceExplorer sessionId={sessionId} />;
}
