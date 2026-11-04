import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuthService } from "../../auth";
import {
  ModelConfigStore,
  ModelSettingsError,
  validateModelSettings
} from "../../llm/model-config-store";
import {
  ModelNotConfiguredError,
  ModelRuntime,
  probeModelEndpoint
} from "../../llm/model-runtime";

/**
 * Reading and writing the model configuration.
 *
 * Two things are deliberately absent from every response: the API key, and any
 * upstream error body. The key is stored on this machine only, and the only
 * thing this API will ever say about it is its last four characters.
 *
 * Every handler is Owner-only. A Reviewer who could rewrite the endpoint would
 * be able to redirect the whole arena's prompts to a host they control, which
 * is a far bigger capability than "start a review".
 */

export type ModelConfigDependencies = {
  store: ModelConfigStore;
  runtime: ModelRuntime;
  auth: AuthService;
  /**
   * Whether analysis may run at all right now. Supplied by the assembly so the
   * settings page and `/api/runtime` answer the same question the same way —
   * two independent notions of "configured" is exactly how a UI ends up
   * offering a button the backend refuses.
   */
  canRunAnalysis?: () => boolean;
};

function requireOwner(auth: AuthService, request: FastifyRequest) {
  const user = auth.userFromRequest(request);
  return user?.role === "owner" ? user : null;
}

export function registerModelConfigRoutes(
  app: FastifyInstance,
  dependencies: ModelConfigDependencies
): void {
  const { store, runtime, auth } = dependencies;
  const canRunAnalysis = () =>
    dependencies.canRunAnalysis?.() ?? runtime.isConfigured();

  const state = () => ({
    ...store.describe(),
    /**
     * Whether a review or an extraction may be started right now. The web UI
     * gates its primary buttons on this, so that an operator never gets five
     * plausible-looking claims about a project no model has read.
     */
    canRunAnalysis: canRunAnalysis()
  });

  app.get("/api/model-config", async (request, reply) => {
    if (!requireOwner(auth, request)) {
      return reply.code(403).send({ error: "Owner role required" });
    }
    return state();
  });

  /**
   * The only endpoint that accepts a key. `verify` defaults to true: an
   * unverified key that is saved and only fails during a run is the worst of
   * both worlds, because by then part of a session already exists.
   */
  app.put("/api/model-config", async (request, reply) => {
    if (!requireOwner(auth, request)) {
      return reply.code(403).send({ error: "Owner role required" });
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    let settings;
    try {
      settings = validateModelSettings(body);
    } catch (cause) {
      if (cause instanceof ModelSettingsError) {
        return reply
          .code(400)
          .send({ code: cause.code, error: "模型配置无效", message: cause.message });
      }
      throw cause;
    }

    if (body.verify !== false) {
      const probe = await probeModelEndpoint(settings);
      if (!probe.ok) {
        // Nothing is written on a failed probe. Half-saving a configuration
        // that cannot answer would leave the UI claiming `configured: true`
        // while every run failed at the first request.
        return reply.code(422).send({
          code: "PROBE_FAILED",
          error: "模型配置未通过连通性检查",
          message: probe.message,
          probe
        });
      }
    }

    const view = store.save(settings);
    return { ...view, canRunAnalysis: canRunAnalysis() };
  });

  /**
   * Checks a candidate configuration without storing it. This is what the
   * "测试连接" button calls, so an operator can iterate on a base URL without
   * the settings file being rewritten four times.
   */
  app.post("/api/model-config/test", async (request, reply) => {
    if (!requireOwner(auth, request)) {
      return reply.code(403).send({ error: "Owner role required" });
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    let settings;
    try {
      settings = validateModelSettings(body);
    } catch (cause) {
      if (cause instanceof ModelSettingsError) {
        return reply
          .code(400)
          .send({ code: cause.code, error: "模型配置无效", message: cause.message });
      }
      throw cause;
    }
    const probe = await probeModelEndpoint(settings);
    return reply.code(probe.ok ? 200 : 502).send({ ...probe });
  });

  app.delete("/api/model-config", async (request, reply) => {
    if (!requireOwner(auth, request)) {
      return reply.code(403).send({ error: "Owner role required" });
    }
    store.clear();
    return { ...store.describe(), canRunAnalysis: canRunAnalysis() };
  });

  /**
   * Lets the arena answer "which model produced this" without touching the
   * settings file, and gives the start routes something to throw when nothing
   * is configured.
   */
  app.get("/api/model-config/effective", async (request, reply) => {
    if (!requireOwner(auth, request)) {
      return reply.code(403).send({ error: "Owner role required" });
    }
    try {
      return { ...runtime.extractionDescriptor(), configured: true };
    } catch (cause) {
      if (cause instanceof ModelNotConfiguredError) {
        return reply
          .code(409)
          .send({ code: cause.code, error: "尚未配置模型", message: cause.message });
      }
      throw cause;
    }
  });
}
