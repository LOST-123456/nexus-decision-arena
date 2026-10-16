import "./globals.css";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { AppNav } from "../components/app-nav";

export const metadata: Metadata = {
  title: "Nexus Decision Arena",
  description: "AI 决策质询与事实核查工作台",
  applicationName: "Nexus Decision Arena"
};

/**
 * `themeColor` paints the browser's own chrome (mobile address bar, task
 * switcher) with the navigation surface rather than white, so the frame does
 * not flash bright above a dark canvas. It follows the operating system's
 * preference because the browser reads this before any page script runs; the
 * in-app toggle cannot reach it. Both values are the `--surface-nav` token of
 * their theme, kept in sync with `globals.css` by hand.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0a1725" },
    { media: "(prefers-color-scheme: light)", color: "#13253d" }
  ]
};

/**
 * Applied before hydration so the very first paint already matches the stored
 * preference (no white flash when the user chose dark, no dark flash when the
 * user chose light). It is intentionally tiny and dependency free; without a
 * stored choice the OS preference decides.
 */
const THEME_BOOTSTRAP = `(function(){try{var k="nexus-theme";var s=window.localStorage.getItem(k);var t=s==="light"||s==="dark"?s:(window.matchMedia("(prefers-color-scheme: light)").matches?"light":"dark");document.documentElement.dataset.theme=t;}catch(e){document.documentElement.dataset.theme="dark";}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body>
        {/*
          First focusable element on every route. A keyboard user should be able
          to step past the app bar in one keystroke instead of tabbing through
          its links on every navigation; it stays off-canvas until focused.
        */}
        <a className="skip-link" href="#main">
          跳到主要内容
        </a>
        <AppNav />
        {children}
      </body>
    </html>
  );
}
