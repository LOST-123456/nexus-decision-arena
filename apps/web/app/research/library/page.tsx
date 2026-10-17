import { AppBreadcrumbs } from "../../../components/app-breadcrumbs";
import { SourceLibraryPanel } from "../../../features/research/source-library";

/**
 * The cross-research library as a page of its own.
 *
 * This is not an "all sources" view: the panel behind it only ever returns the
 * researches this account owns or was explicitly granted, an id it may not see
 * answers 404, and copying material never copies a human verification with it.
 * The page exists so sharing can be administered without opening a research
 * first; when a session is passed in, it is preselected as the copy target.
 *
 * It carries the same breadcrumb trail as every other page below a family
 * root: this is reachable straight from the global bar, and without a trail
 * the only way back to /research is the bar itself.
 */
export default async function ResearchLibraryPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const sessionId =
    typeof query.sessionId === "string" && query.sessionId.length > 0
      ? query.sessionId
      : undefined;

  return (
    <>
      <AppBreadcrumbs />
      <main
        id="main"
        tabIndex={-1}
        className="research-body"
        data-testid="research-body"
        data-mode="analyze"
      >
        <SourceLibraryPanel {...(sessionId ? { currentSessionId: sessionId } : {})} />
      </main>
    </>
  );
}
