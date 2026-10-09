import { FactCheckReportView } from "../../../../features/research/fact-check-report-view";

export default async function FactCheckReportPage({
  params
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  return <FactCheckReportView sessionId={sessionId} />;
}
