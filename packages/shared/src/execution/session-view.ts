import type { AgentRole } from "../domain/agent";
import type { Challenge } from "../domain/challenge";
import type { Claim } from "../domain/claim";
import type { Conflict } from "../domain/conflict";
import type { Evidence } from "../domain/evidence";
import type { HumanDecision } from "../domain/human-decision";
import type { SessionPhase } from "../workflow/state-machine";

export type SessionView = {
  sessionId: string;
  phase: SessionPhase;
  operationalStatus: "ACTIVE" | "PAUSED" | "FAILED" | "COMPLETED";
  agents: AgentRole[];
  claims: Claim[];
  evidence: Evidence[];
  challenges: Challenge[];
  conflicts: Conflict[];
  humanDecisions: HumanDecision[];
  currentConclusion: string | null;
};
