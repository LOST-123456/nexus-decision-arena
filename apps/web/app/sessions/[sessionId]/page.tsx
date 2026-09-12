import { SessionWorkspace } from "../../../features/arena/session-workspace";

export default async function SessionPage({
  params
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  return <SessionWorkspace sessionId={sessionId} />;
}
