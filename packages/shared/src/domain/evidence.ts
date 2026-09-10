import { z } from "zod";
import { IdSchema, TimestampSchema } from "../ids";

export const EvidenceSchema = z
  .object({
    id: IdSchema,
    sessionId: IdSchema,
    claimId: IdSchema,
    kind: z.enum([
      "project_input",
      "calculation",
      "external_reference",
      "assumption"
    ]),
    title: z.string().min(1),
    content: z.string().min(1),
    description: z.string().min(1),
    sourceRef: z.string().url().optional(),
    direction: z.enum(["supports", "opposes"]),
    reliability: z.number().min(0).max(1),
    verificationStatus: z.enum(["unverified", "verified", "rejected"]),
    validityPeriod: z
      .object({
        from: TimestampSchema.optional(),
        to: TimestampSchema.optional()
      })
      .optional(),
    retrievedAt: TimestampSchema,
    createdBy: z.enum(["system", "agent", "human"]),
    agentRunId: IdSchema.optional()
  })
  .superRefine((value, context) => {
    if (value.kind === "external_reference" && !value.sourceRef) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sourceRef"],
        message: "External references require a source"
      });
    }

    if (
      value.kind === "assumption" &&
      value.verificationStatus === "verified"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["verificationStatus"],
        message: "Assumptions cannot be verified"
      });
    }
  });

export type Evidence = z.infer<typeof EvidenceSchema>;
