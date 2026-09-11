import {
  newId,
  type AgentRole,
  type ExecutionEvent
} from "@nexus/shared";
import type { AgentAnalysis, AgentRunner } from "./agent-runner";

export type RunSessionEmit = (
  event: Partial<ExecutionEvent> & { type: ExecutionEvent["type"] }
) => void;

export type RunAnalysisResult = {
  analyses: AgentAnalysis[];
  failures: Array<{ role: AgentRole; reason: unknown }>;
};

export class RunSessionService {
  constructor(private readonly agentRunner: AgentRunner) {}

  async runAnalysis(
    roles: AgentRole[],
    projectInput: unknown,
    emit: RunSessionEmit
  ): Promise<RunAnalysisResult> {
    const settled = await Promise.allSettled(
      roles.map((role) => this.agentRunner.run(role, projectInput))
    );

    const analyses: AgentAnalysis[] = [];
    const failures: Array<{ role: AgentRole; reason: unknown }> = [];

    settled.forEach((result, index) => {
      const role = roles[index];
      if (result.status === "fulfilled") {
        analyses.push(result.value);
        return;
      }

      if (!role) {
        return;
      }

      failures.push({ role, reason: result.reason });
      emit({
        type: "AGENT_RUN_FAILED",
        payload: {
          roleId: role.id,
          message:
            result.reason instanceof Error
              ? result.reason.message
              : "Unknown agent failure"
        },
        correlationId: newId()
      });
    });

    return { analyses, failures };
  }

  async start(sessionId: string): Promise<void> {
    throw new Error(
      `RunSessionService.start(${sessionId}) must be wired before demo execution`
    );
  }
}
