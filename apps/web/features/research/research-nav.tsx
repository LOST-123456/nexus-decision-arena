"use client";

import { usePathname } from "next/navigation";
import { AppSubNav } from "../../components/app-nav";

/**
 * Route-level links for the research surface.
 *
 * The global app bar already owns brand, product-wide destinations, the theme
 * switch and the account badge, so this bar only carries what is specific to
 * research: the section roots plus the contextual pages of the open session.
 */

/**
 * Segments under /research that name a fixed destination rather than a session.
 * Reading "library" as a session id would make the bar claim session-scoped
 * links for a page that has no session, so the list is checked explicitly.
 */
const STATIC_SEGMENTS = new Set(["new", "library"]);

export function ResearchNav() {
  const pathname = usePathname() ?? "/research";
  const segments = pathname.split("/").filter(Boolean);
  const sessionId =
    segments[0] === "research" &&
    segments[1] &&
    !STATIC_SEGMENTS.has(segments[1])
      ? segments[1]
      : null;

  const links: Array<{ href: string; label: string }> = [
    { href: "/research", label: "研究首页" },
    { href: "/research/library", label: "资料库" }
  ];
  if (sessionId) {
    links.push(
      { href: `/research/${sessionId}`, label: "研究工作台" },
      { href: `/research/${sessionId}/evidence`, label: "证据地图" },
      { href: `/research/${sessionId}/report`, label: "事实核查报告" },
      { href: `/sessions/${sessionId}`, label: "质询视图" },
      { href: `/sessions/${sessionId}/report`, label: "决策报告" }
    );
  }

  return <AppSubNav label="研究导航" links={links} />;
}
