"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Where the reader is, spelled out above the page they are looking at.
 *
 * The app has three route families (`/`, `/sessions/*`, `/research/*`) and a
 * session id in the middle of two of them. Without a trail, a reader who
 * arrives from a report link or a shared URL has to reverse-engineer the
 * hierarchy from the URL, and the only way back to the family root is the
 * global bar — which says where you *could* go, not where you *are*.
 *
 * The labels for static segments live here; the ones for dynamic segments
 * (a session id) are passed in by the page that knows the real name, because
 * only that page has loaded it. A segment with no label falls back to itself
 * rather than disappearing: a missing crumb is a lie about the path.
 */

const SEGMENT_LABELS: Record<string, string> = {
  history: "最近会话",
  sessions: "评审",
  new: "新建评审",
  demo: "固定演示",
  report: "报告",
  research: "研究与事实核查",
  library: "资料库",
  evidence: "证据地图",
  security: "安全治理",
  login: "登录"
};

export interface AppBreadcrumbsProps {
  /** Display names for dynamic segments, keyed by the raw path segment. */
  labels?: Record<string, string>;
}

export function AppBreadcrumbs({ labels = {} }: AppBreadcrumbsProps) {
  const pathname = usePathname() ?? "/";
  const segments = pathname.split("/").filter(Boolean);

  // The home page has nothing to descend from; a trail of one item is noise.
  if (segments.length === 0) return null;

  const crumbs: Array<{ href: string; label: string }> = [
    { href: "/", label: "首页" }
  ];
  let accumulated = "";
  for (const segment of segments) {
    accumulated += `/${segment}`;
    crumbs.push({
      href: accumulated,
      label: labels[segment] ?? SEGMENT_LABELS[segment] ?? segment
    });
  }

  return (
    <nav className="app-breadcrumbs" aria-label="面包屑" data-testid="app-breadcrumbs">
      <ol>
        {crumbs.map((crumb, index) => {
          const isLast = index === crumbs.length - 1;
          return (
            <li key={crumb.href}>
              {isLast ? (
                <span aria-current="page">{crumb.label}</span>
              ) : (
                <>
                  <Link href={crumb.href}>{crumb.label}</Link>
                  <span className="app-breadcrumbs-sep" aria-hidden="true">
                    /
                  </span>
                </>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
