import type { ReactNode } from "react";
import { ResearchNav } from "../../features/research/research-nav";
import "./research.css";

export default function ResearchLayout({ children }: { children: ReactNode }) {
  return (
    <div className="research-root">
      <ResearchNav />
      {children}
    </div>
  );
}
