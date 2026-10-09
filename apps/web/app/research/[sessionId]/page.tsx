import { ResearchWorkspace } from "../../../features/research/research-workspace";

export default async function ResearchWorkspacePage({
  params
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  return <ResearchWorkspace sessionId={sessionId} />;
}
