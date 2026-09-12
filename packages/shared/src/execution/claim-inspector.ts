import type { Challenge } from "../domain/challenge";
import type { Claim } from "../domain/claim";
import type { Conflict } from "../domain/conflict";
import type { Evidence } from "../domain/evidence";

export type ClaimInspectorAgentRun = {
  id: string;
  sessionId: string;
  roleId: string;
  promptVersionId: string;
  status: string;
  [key: string]: unknown;
};

export type ClaimInspectorPromptVersion = {
  id: string;
  name: string;
  version: string;
  content: string;
  createdAt: string;
  [key: string]: unknown;
};

export type ClaimInspectorDTO = {
  claim: Claim;
  evidence: Evidence[];
  challenges: Array<{
    challenge: Challenge;
    responseClaim?: Claim;
  }>;
  conflicts: Conflict[];
  provenance: {
    agentRun: ClaimInspectorAgentRun | undefined;
    promptVersion: ClaimInspectorPromptVersion | undefined;
  };
  decisionRationale: {
    outcome: "accepted" | "rejected" | "contested" | "needs_human";
    summary: string;
    decisiveChallengeIds: string[];
    evidenceIds: string[];
    humanDecisionId?: string;
  };
};
