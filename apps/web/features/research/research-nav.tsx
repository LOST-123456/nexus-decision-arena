"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Deep-navy navigation for the research surface. Every entry points at a page
 * that really exists; contextual entries only appear once a session is open.
 */
export function ResearchNav() {
  const pathname = usePathname() ?? "/research";
  const segments = pathname.split("/").filter(Boolean);
  const sessionId =
    segments[0] === "research" && segments[1] && segments[1] !== "new"
      ? segments[1]
      : null;

  const links: Array<{ href: string; label: string }> = [
    { href: "/research", label: "Research Home" }
  ];
  if (sessionId) {
    links.push(
      { href: `/research/${sessionId}`, label: "Research Workspace" },
      { href: `/research/${sessionId}/evidence`, label: "Evidence Explorer" },
      { href: `/sessions/${sessionId}`, label: "Arena View" },
      { href: `/sessions/${sessionId}/report`, label: "Fact Check Report" }
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
