import { loadEnvFile } from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  OpenAiCompatibleProvider,
  type LlmProvider
} from "@nexus/llm";
import { DEFAULT_AGENT_ROLES } from "../services/core/src/arena/default-roles";
import { ProviderAgentRunner } from "../services/core/src/arena/provider-agent-runner";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadEnvFile(resolve(repositoryRoot, ".env"));

const baseUrl = process.env.LLM_BASE_URL;
const apiKey = process.env.LLM_API_KEY;
const model = process.env.LLM_MODEL;
if (!baseUrl || !apiKey || !model) {
  throw new Error("LLM_BASE_URL, LLM_API_KEY and LLM_MODEL are required");
}

const provider: LlmProvider = new OpenAiCompatibleProvider({
  baseUrl,
  apiKey,
  model
});
const runner = new ProviderAgentRunner(provider);
const role = DEFAULT_AGENT_ROLES[0];
if (!role) {
  throw new Error("No default agent role is configured");
}

async function main(): Promise<void> {
  const started = Date.now();
  const analysis = await runner.run(role, {
    sessionId: "0198f0a2-1234-7abc-8def-1234567890ab",
    agentRunId: "0198f0a2-1234-7abc-8def-1234567890ac",
    projectInput: {
      name: "社区养老智能调度平台",
      summary: "使用 AI 预测护理需求并优化护理员调度",
      targetUsers: "社区养老服务中心",
      businessModel: "按服务站点年度订阅",
      expectedData: "12 个月覆盖 50 个站点"
    }
  });

  console.log(
    JSON.stringify(
      {
        provider: "OpenAI-compatible",
        model,
        role: role.name,
        durationMs: Date.now() - started,
        claimCount: analysis.claims.length,
        evidenceCount: analysis.evidence.length,
        claims: analysis.claims.map((claim) => claim.statement)
      },
      null,
      2
    )
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
