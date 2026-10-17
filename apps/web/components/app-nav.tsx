"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { AppNavHeightObserver } from "./app-nav-height";
import { AppNavDrawer } from "./app-nav-drawer";
import { AuthUserBadge } from "./auth-user-badge";
import { ThemeToggle } from "./theme-toggle";

/**
 * One navigation model for the whole product.
 *
 * Every destination named here is a route that really exists, and the labels
 * are Chinese throughout so the arena surface and the research surface stop
 * speaking two different languages. When a route owns a contextual cluster
 * (runtime mode, correlation id, session id) it passes it through `context`
 * instead of rebuilding its own header.
 */
const PRIMARY_LINKS: ReadonlyArray<{ href: string; label: string }> = [
  { href: "/history", label: "最近会话" },
  { href: "/sessions/new", label: "新建评审" },
  { href: "/sessions/demo", label: "固定演示" },
  { href: "/research", label: "研究与事实核查" },
  { href: "/research/library", label: "资料库" },
  { href: "/security", label: "安全治理" }
];

/**
 * Longest-prefix match: `/research/library` must win over `/research`, and a
 * session route must not light up two entries at once.
 */
export function activeHref(
  pathname: string,
  links: ReadonlyArray<{ href: string }>
): string | null {
  let best: string | null = null;
  for (const { href } of links) {
    const matches = pathname === href || pathname.startsWith(`${href}/`);
    if (matches && (best === null || href.length > best.length)) {
      best = href;
    }
  }
  return best;
}

export function AppNav({ context }: { context?: ReactNode }) {
  const pathname = usePathname() ?? "/";
  const current = activeHref(pathname, PRIMARY_LINKS);
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <header className="app-nav" data-testid="app-nav">
      <AppNavHeightObserver />

      <Link className="app-nav-brand" href="/">
        <span className="brand-mark" aria-hidden="true">
          N
        </span>
        <span className="app-nav-brand-copy">
          <strong>Nexus Decision Arena</strong>
          <small>决策质询与事实核查工作台</small>
        </span>
      </Link>

      {/*
        Below 768px this strip is display:none and the drawer carries the same
        links instead; the button is the other way round. Both stay in the DOM
        so the active-destination logic has one source and neither variant has
        to re-derive it.
      */}
      <button
        type="button"
        className="app-nav-menu-button"
        aria-expanded={drawerOpen}
        aria-haspopup="dialog"
        data-testid="app-nav-menu-button"
        onClick={() => setDrawerOpen(true)}
      >
        菜单
      </button>

      <nav className="app-nav-links" aria-label="主导航">
        {PRIMARY_LINKS.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className="app-nav-link"
            aria-current={current === link.href ? "page" : undefined}
          >
            {link.label}
          </Link>
        ))}
      </nav>

      <div className="app-nav-actions">
        {context}
        <ThemeToggle />
        <AuthUserBadge />
      </div>

      <AppNavDrawer
        open={drawerOpen}
        pathname={pathname}
        links={PRIMARY_LINKS}
        onClose={() => setDrawerOpen(false)}
      />
    </header>
  );
}

/**
 * Secondary bar for route-level links that only make sense inside a section
 * (research has a session-scoped set). It deliberately sits under the global
 * bar rather than replacing it.
 */
export function AppSubNav({
  label,
  links
}: {
  label: string;
  links: ReadonlyArray<{ href: string; label: string }>;
}) {
  const pathname = usePathname() ?? "/";
  const current = activeHref(pathname, links);

  if (links.length === 0) {
    return null;
  }

  return (
    <nav className="app-subnav" aria-label={label} data-testid="app-subnav">
      {links.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          className="app-subnav-link"
          aria-current={current === link.href ? "page" : undefined}
        >
          {link.label}
        </Link>
      ))}
    </nav>
  );
}
