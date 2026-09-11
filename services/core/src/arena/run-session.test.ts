import { describe, expect, it } from "vitest";
import { AgentRoleSchema, newId, type AgentRole } from "@nexus/shared";
import type { AgentAnalysis } from "./agent-runner";
import { RunSessionService } from "./run-session";

const role = (key: AgentRole["key"]): AgentRole =>
  AgentRoleSchema.parse({
    id: newId(),
    key,
    name: key,
    goal: "Analyze",
    perspective: "Evidence",
    evaluationCriteria: ["evidence"],
    evidenceRequired: ["source"],
    conflictPreference: ["evidence_gap"],
    lenses: [key],
    promptVersionId: newId()
  });

describe("run session service", () => {
  it("continues after failures and emits one AGENT_RUN_FAILED per rejection", async () => {
    const winner = role("market_analyst");
    const firstFailure = role("risk_auditor");
    const secondFailure = role("technical_expert");
    const emitted: string[] = [];

    const service = new RunSessionService({
      run: async (agent): Promise<AgentAnalysis> => {
        if (agent.key !== "market_analyst") {
          throw new Error(`failure:${agent.key}`);
        }
        return { claims: [], evidence: [] };
      }
    });

    const result = await service.runAnalysis(
      [winner, firstFailure, secondFailure],
      { project: "demo" },
      (event) => emitted.push(event.type as string)
    );

    expect(result.analyses).toHaveLength(1);
    expect(result.failures.map((item) => item.role.id)).toEqual([
      firstFailure.id,
      secondFailure.id
    ]);
    expect(emitted.filter((type) => type === "AGENT_RUN_FAILED")).toHaveLength(
      2
    );
  });
});
