import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppDependencies } from "../../app";
import {
  ResearchTranslationService,
  TranslationBudgetError,
  TranslationSnapshotNotFoundError
} from "../../research/research-translation-service";
import { LanguageDetectionService } from "../../research/language-detection-service";
import { UnavailableTranslationProvider } from "../../research/translation-provider";
import {
  hashIdempotencyRequest,
  IdempotencyConflictError,
  IdempotencyLeaseLostError,
  IdempotencyTimeoutError,
  type IdempotencyStore
} from "../plugins/idempotency";

/**
 * Routes for multilingual research and cross-language evidence verification.
 *
 * Every operation keeps the translation an *auxiliary* reading aid. Creating a
 * translation never verifies an Evidence row, never changes a claim review or a
 * verdict, and never auto-marks a translation as fact. Reviews record what a
 * person decided about a translation — nothing more.
 */

const LANGUAGE_CODES = [
  "zh-Hans",
  "zh-Hant",
  "en",
  "ja",
  "ko",
  "fr",
  "de",
  "es"
] as const;

const CreateTranslationSchema = z.object({
  sourceSnapshotId: z.string().min(1),
  targetLanguage: z.enum(LANGUAGE_CODES),
  segmentIds: z.array(z.string().min(1)).optional()
});

const ReviewTranslationSchema = z.object({
  action: z.enum(["approve", "flag", "request-retranslation", "add-correction"]),
  reviewStatus: z.enum([
    "pending",
    "approved",
    "flagged",
    "needs-retranslation",
    "corrected"
  ]),
  correctionText: z.string().optional(),
  note: z.string().optional()
});

const UpsertTerminologySchema = z.object({
  sourceTerm: z.string().min(1),
  suggestedTranslation: z.string().optional(),
  confirmedTranslation: z.string().optional(),
  language: z.enum([...LANGUAGE_CODES, "unknown", "mixed", "undetermined"]),
  context: z.string().optional()
});

function getIdempotencyKey(request: FastifyRequest): string | null {
  const key = request.headers["idempotency-key"];
  return typeof key === "string" && key.length > 0 ? key : null;
}

function actorOf(request: FastifyRequest, dependencies: Pick<AppDependencies, "auth">) {
  return dependencies.auth?.userFromRequest(request) ?? null;
}

function actorName(user: { displayName: string; username: string } | null): string {
  return user ? `${user.displayName} (${user.username})` : "unattributed";
}

type MultilingualRouteDependencies = Pick<
  AppDependencies,
  "auth" | "evidence" | "translations" | "terminology" | "translationProvider"
>;

function translationService(
  dependencies: MultilingualRouteDependencies
): ResearchTranslationService | null {
  if (!dependencies.translations || !dependencies.evidence) {
    return null;
  }
  return new ResearchTranslationService({
    translations: dependencies.translations,
    evidence: dependencies.evidence,
    provider: dependencies.translationProvider ?? new UnavailableTranslationProvider(),
    language: new LanguageDetectionService()
  });
}

function notConfigured(
  reply: { code: (c: number) => { send: (b: unknown) => unknown } }
) {
  return reply.code(501).send({ error: "Multilingual research is not configured" });
}

function mapServiceError(
  reply: { code: (c: number) => { send: (b: unknown) => unknown } },
  error: unknown
): boolean {
  if (error instanceof TranslationSnapshotNotFoundError) {
    reply.code(404).send({ error: "Source snapshot not found", code: "snapshot_not_found" });
    return true;
  }
  if (error instanceof TranslationBudgetError) {
    reply.code(422).send({ error: error.message, code: error.code });
    return true;
  }
  if (
    error instanceof IdempotencyConflictError ||
    error instanceof IdempotencyTimeoutError ||
    error instanceof IdempotencyLeaseLostError
  ) {
    reply.code(409).send({ error: error.message });
    return true;
  }
  return false;
}

export function registerMultilingualRoutes(
  app: FastifyInstance,
  dependencies: MultilingualRouteDependencies,
  idempotency: IdempotencyStore
): void {
  /* Creates (or reuses) an auxiliary translation of a source snapshot. */
  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/translations",
    async (request, reply) => {
      const user = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      if (user?.role === "viewer") {
        return reply.code(403).send({ error: "Reviewer role required" });
      }
      const service = translationService(dependencies);
      if (!service) {
        return notConfigured(reply);
      }
      const key = getIdempotencyKey(request);
      if (!key) {
        return reply.code(400).send({ error: "Idempotency-Key header is required" });
      }
      const parsed = CreateTranslationSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "Invalid translation request",
          details: parsed.error.flatten()
        });
      }

      const sessionId = request.params.id;
      const requestHash = hashIdempotencyRequest({
        operation: "translation-create",
        sessionId,
        body: parsed.data
      });

      try {
        const result = await idempotency.execute(key, requestHash, () =>
          service.translateSnapshot({
            sessionId,
            sourceSnapshotId: parsed.data.sourceSnapshotId,
            targetLanguage: parsed.data.targetLanguage,
            segmentIds: parsed.data.segmentIds,
            createdBy: actorName(user)
          })
        );
        const { translation, fidelity } = result.response;
        if (translation.status === "unavailable") {
          return reply.code(503).send({
            translation,
            code: translation.failureCode ?? "provider_unavailable"
          });
        }
        if (translation.status === "failed") {
          return reply
            .code(422)
            .send({ translation, code: translation.failureCode ?? "translation_failed" });
        }
        return reply.code(201).send({ translation, fidelity });
      } catch (error) {
        if (mapServiceError(reply, error)) return undefined;
        throw error;
      }
    }
  );

  /* Lists stored translations for a session, optionally scoped to a snapshot. */
  app.get<{ Params: { id: string }; Querystring: { sourceSnapshotId?: string } }>(
    "/api/sessions/:id/translations",
    async (request, reply) => {
      const user = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      if (!dependencies.translations) {
        return notConfigured(reply);
      }
      const snapshotId = request.query.sourceSnapshotId;
      const translations = snapshotId
        ? await dependencies.translations.listTranslationsForSnapshot(
            request.params.id,
            snapshotId
          )
        : await dependencies.translations.listSessionTranslations(request.params.id);
      return { translations };
    }
  );

  /* Reads one translation; cross-session access is not found. */
  app.get<{ Params: { id: string; translationId: string } }>(
    "/api/sessions/:id/translations/:translationId",
    async (request, reply) => {
      const user = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      if (!dependencies.translations) {
        return notConfigured(reply);
      }
      const translation = await dependencies.translations.getTranslation(
        request.params.id,
        request.params.translationId
      );
      if (!translation) {
        return reply.code(404).send({ error: "Translation not found" });
      }
      const reviews = await dependencies.translations.listReviews(
        request.params.id,
        request.params.translationId
      );
      return { translation, reviews };
    }
  );

  /* Records a human review of a translation. Never changes any Evidence state. */
  app.post<{ Params: { id: string; translationId: string } }>(
    "/api/sessions/:id/translations/:translationId/review",
    async (request, reply) => {
      const user = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      if (user?.role === "viewer") {
        return reply.code(403).send({ error: "Reviewer role required" });
      }
      if (!dependencies.translations) {
        return notConfigured(reply);
      }
      const key = getIdempotencyKey(request);
      if (!key) {
        return reply.code(400).send({ error: "Idempotency-Key header is required" });
      }
      const parsed = ReviewTranslationSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "Invalid translation review",
          details: parsed.error.flatten()
        });
      }
      const sessionId = request.params.id;
      const translationId = request.params.translationId;
      const existing = await dependencies.translations.getTranslation(
        sessionId,
        translationId
      );
      if (!existing) {
        return reply.code(404).send({ error: "Translation not found" });
      }

      const requestHash = hashIdempotencyRequest({
        operation: "translation-review",
        sessionId,
        translationId,
        body: parsed.data
      });

      try {
        const result = await idempotency.execute(key, requestHash, () =>
          dependencies.translations!.recordReview({
            sessionId,
            translationId,
            reviewedBy: actorName(user),
            action: parsed.data.action,
            reviewStatus: parsed.data.reviewStatus,
            correctionText: parsed.data.correctionText,
            note: parsed.data.note,
            event: {
              type: "TRANSLATION_REVIEWED",
              correlationId: sessionId,
              payload: {
                translationId,
                action: parsed.data.action,
                reviewStatus: parsed.data.reviewStatus
              }
            }
          })
        );
        return reply.code(201).send({ review: result.response.review });
      } catch (error) {
        if (mapServiceError(reply, error)) return undefined;
        throw error;
      }
    }
  );

  /* Detects the language of a source's current capture (read-only, on demand). */
  app.get<{ Params: { id: string; sourceId: string } }>(
    "/api/sessions/:id/sources/:sourceId/languages",
    async (request, reply) => {
      const user = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      if (!dependencies.evidence) {
        return notConfigured(reply);
      }
      const snapshot = await dependencies.evidence.getCurrentSnapshot(
        request.params.id,
        request.params.sourceId
      );
      if (!snapshot) {
        return reply.code(404).send({ error: "Source has no readable capture" });
      }
      const detection = new LanguageDetectionService().detect(snapshot.content);
      return {
        sourceId: request.params.sourceId,
        sourceSnapshotId: snapshot.id,
        detection,
        storedSourceLanguage: snapshot.sourceLanguage ?? null
      };
    }
  );

  /* Lists the session-scoped terminology glossary. */
  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id/terminology",
    async (request, reply) => {
      const user = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      if (!dependencies.terminology) {
        return notConfigured(reply);
      }
      const entries = await dependencies.terminology.listTerminology(request.params.id);
      return { entries };
    }
  );

  /* Upserts a glossary entry (suggested and/or confirmed translation). */
  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/terminology",
    async (request, reply) => {
      const user = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      if (user?.role === "viewer") {
        return reply.code(403).send({ error: "Reviewer role required" });
      }
      if (!dependencies.terminology) {
        return notConfigured(reply);
      }
      const key = getIdempotencyKey(request);
      if (!key) {
        return reply.code(400).send({ error: "Idempotency-Key header is required" });
      }
      const parsed = UpsertTerminologySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "Invalid terminology entry",
          details: parsed.error.flatten()
        });
      }
      const sessionId = request.params.id;
      const requestHash = hashIdempotencyRequest({
        operation: "terminology-upsert",
        sessionId,
        body: parsed.data
      });

      try {
        const result = await idempotency.execute(key, requestHash, () =>
          dependencies.terminology!.upsertTerminology({
            sessionId,
            sourceTerm: parsed.data.sourceTerm,
            suggestedTranslation: parsed.data.suggestedTranslation,
            confirmedTranslation: parsed.data.confirmedTranslation,
            language: parsed.data.language,
            context: parsed.data.context,
            reviewedBy: actorName(user),
            event: {
              type: "TERMINOLOGY_RECORDED",
              correlationId: sessionId,
              payload: {
                sourceTerm: parsed.data.sourceTerm,
                language: parsed.data.language
              }
            }
          })
        );
        return reply.code(201).send({ entry: result.response.entry });
      } catch (error) {
        if (mapServiceError(reply, error)) return undefined;
        throw error;
      }
    }
  );
}
