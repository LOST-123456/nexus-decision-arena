"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Deep-navy navigation for the research surface. Every entry points at a page
 * that really exists; contextual entries only appear once a session is open.
 */

/**
 * Segments under /research that name a fixed destination rather than a session.
 * Reading "library" as a session id would make the nav claim session-scoped
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
    { href: "/research", label: "Research Home" },
    { href: "/research/library", label: "资料库" }
  ];
  if (sessionId) {
    links.push(
      { href: `/research/${sessionId}`, label: "Research Workspace" },
      { href: `/research/${sessionId}/evidence`, label: "Evidence Explorer" },
      { href: `/research/${sessionId}/report`, label: "Fact Check Report" },
      { href: `/sessions/${sessionId}`, label: "Arena View" },
      { href: `/sessions/${sessionId}/report`, label: "Decision Report" }
    );
  }

  return (
    <nav className="research-nav" aria-label="Research navigation">
      <span className="research-nav-brand">Nexus · Research &amp; Fact Check</span>
      <div className="research-nav-links">
        {links.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className="research-nav-link"
            aria-current={pathname === link.href ? "page" : undefined}
          >
            {link.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}
