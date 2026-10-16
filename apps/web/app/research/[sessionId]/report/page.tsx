import { FactCheckReportView } from "../../../../features/research/fact-check-report-view";

export default async function FactCheckReportPage({
  params
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  return (
    <main id="main" tabIndex={-1}>
      <FactCheckReportView sessionId={sessionId} />
    </main>
  );
}
