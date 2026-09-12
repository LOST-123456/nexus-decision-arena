import { render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it } from "vitest";
import { newId } from "@nexus/shared";
import { AgentPanel } from "./agent-panel";

describe("AgentPanel", () => {
  it("uses noninteractive list semantics for agent status rows", () => {
    render(
      <AgentPanel
        roles={[
          {
            id: newId(),
            key: "market_analyst",
            name: "Market Analyst",
            goal: "Validate demand",
            perspective: "Market evidence",
            evaluationCriteria: ["demand"],
            evidenceRequired: ["pipeline"],
            conflictPreference: ["evidence_gap"],
            lenses: ["market"],
            promptVersionId: newId(),
            status: "running"
          }
        ]}
      />
    );

    expect(screen.queryByRole("button")).toBeNull();
    expect(
      screen.getByRole("listitem", { name: /Market Analyst/ })
    ).toBeTruthy();
  });
});
