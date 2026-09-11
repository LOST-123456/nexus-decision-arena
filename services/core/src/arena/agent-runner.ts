import type { AgentRole, Claim, Evidence } from "@nexus/shared";

export type AgentAnalysis = {
  claims: Claim[];
  evidence: Evidence[];
};

export interface AgentRunner {
  run(role: AgentRole, projectInput: unknown): Promise<AgentAnalysis>;
}
