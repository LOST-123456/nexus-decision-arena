import "./globals.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AppNav } from "../components/app-nav";

export const metadata: Metadata = {
  title: "Nexus Decision Arena",
  description: "AI 决策质询与事实核查工作台"
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
        <AppNav />
        {children}
      </body>
    </html>
  );
}
