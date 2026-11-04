import { describe, expect, it } from "vitest";
import { newId } from "@nexus/shared";

import { parseAgentRoles } from "./domain-mapper";

function roleRow(overrides: Record<string, unknown> = {}) {
  return {
    id: newId(),
    key: "risk_auditor",
    name: "Risk auditor",
    goal: "Challenge the assumptions",
    perspective: "Skeptical",
    evaluationCriteria: ["evidence"],
    evidenceRequired: ["source"],
    conflictPreference: ["evidence_gap"],
    lenses: ["risk"],
    promptVersionId: newId(),
    ...overrides
  };
}

// `agent_roles` is a **global** template table read in full by
// `DecisionSessionRepository.getView`, which backs `GET /api/sessions/:id`.
// Anything able to write to the database — a seed script, another test suite,
// manual SQL — can add a row whose `key` is outside `AgentRoleKeySchema`.
// Parsing the table as a single array made one such row throw inside zod and
// turn the detail endpoint of *every* session into a 500.
describe("parseAgentRoles", () => {
  it("returns every role when the roster is clean", () => {
    const rows = [roleRow(), roleRow({ key: "market_analyst" })];

    expect(parseAgentRoles(rows).map((role) => role.key)).toEqual([
      "risk_auditor",
      "market_analyst"
    ]);
  });

  it("drops a row with an unknown key instead of throwing", () => {
    const rows = [roleRow(), roleRow({ key: `challenger-${newId()}` })];

    expect(() => parseAgentRoles(rows)).not.toThrow();
    expect(parseAgentRoles(rows).map((role) => role.key)).toEqual([
      "risk_auditor"
    ]);
  });

  it("drops a row that is missing required fields", () => {
    const rows = [roleRow(), roleRow({ name: "" }), roleRow({ lenses: [] })];

    expect(parseAgentRoles(rows).map((role) => role.key)).toEqual([
      "risk_auditor"
    ]);
  });

  it("returns an empty roster rather than throwing when nothing parses", () => {
    expect(parseAgentRoles([roleRow({ key: "unknown_role" })])).toEqual([]);
    expect(parseAgentRoles([])).toEqual([]);
  });
});
