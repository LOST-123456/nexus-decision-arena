import { z } from "zod";
import { IdSchema } from "../ids";
import type { Challenge } from "../domain/challenge";
import type { Claim } from "../domain/claim";
import type { Evidence } from "../domain/evidence";
import type { Source } from "../domain/source";
import type { ClaimVerdict } from "./claim-verdict";

/**
 * Evidence-gap diagnostics.
 *
 * A conclusion of "insufficient evidence" is not a useful end state for a
 * researcher: it says what is *not* known but not what to go and get. This
 * module turns the persisted research state into a list of concrete gaps, each
 * pointing at the actual rows that produced it and at the actions that would
 * close it.
 *
 * Every diagnosis is a rule over persisted data — never a guess, never a
 * model's opinion. Candidate search directions are allowed, but they are
 * carried in `suggestions` with a hard-coded `status: "suggested"`: nothing
 * here has been searched, and no suggestion is a found source.
 */
export const EvidenceGapKindSchema = z.enum([
  /** Nothing verified supports the claim yet. */
  "no_verified_support",
  /** Material exists but nobody has checked it against the source. */
  "unverified_material",
  /** Support exists but nobody has looked for evidence against it. */
  "no_counter_check",
  /** No first-hand source backs the numbers or the time range. */
  "missing_primary_source",
  /** Verified-time failure: material is outside its validity window. */
  "source_expired",
  "source_not_yet_effective",
  /** A source exists but its publication date is unknown. */
  "unknown_publication_date",
  /** Several excerpts may trace back to one origin. */
  "source_independence_unverified",
  /** A quote cannot be located inside its source. */
  "excerpt_not_locatable",
  /** Cross-examination left a specific dispute open. */
  "unresolved_dispute",
  /** A challenger asked for material that is not registered anywhere. */
  "unmapped_reference",
  /** A human reviewer explicitly asked for more evidence. */
  "review_requires_more_evidence",
  /** The claim is stated more broadly than any evidence could establish. */
  "overbroad_claim",
  /** Time range, scope or causal wording the material does not establish. */
  "insufficient_time_or_scope_evidence"
]);

export type EvidenceGapKind = z.infer<typeof EvidenceGapKindSchema>;

export const EvidenceGapSeveritySchema = z.enum([
  /** The conclusion cannot stand until this is closed. */
  "blocking",
  /** The conclusion is weaker than it looks. */
  "important",
  /** Worth doing, does not change the current conclusion. */
  "advisory"
]);

export type EvidenceGapSeverity = z.infer<typeof EvidenceGapSeveritySchema>;

export const EvidenceGapActionSchema = z.enum([
  "record_source",
  "verify_evidence",
  "add_supporting_evidence",
  "add_opposing_evidence",
  "add_primary_source",
  "run_cross_review"
]);

export type EvidenceGapAction = z.infer<typeof EvidenceGapActionSchema>;

/** A direction worth looking in. Never something that was already found. */
export const EvidenceGapSuggestionSchema = z.object({
  label: z.string().min(1),
  /**
   * Fixed to "suggested" on purpose. If a suggestion ever becomes a real
   * source, it must be registered as a Source and stop being a suggestion.
   */
  status: z.literal("suggested")
});

export const EvidenceGapSchema = z.object({
  /** Deterministic: the same state always yields the same id. */
  id: z.string().min(1),
  claimId: IdSchema,
  kind: EvidenceGapKindSchema,
  severity: EvidenceGapSeveritySchema,
  /** What is missing, in one line. */
  message: z.string().min(1),
  /** The persisted facts this diagnosis reads, so it can be checked. */
  detail: z.array(z.string()).default([]),
  /** Rows this gap is about. */
  evidenceIds: z.array(IdSchema).default([]),
  challengeIds: z.array(IdSchema).default([]),
  /** Operations that would close the gap; each maps to a real UI action. */
  actions: z.array(EvidenceGapActionSchema).min(1),
  suggestions: z.array(EvidenceGapSuggestionSchema).default([])
});

export type EvidenceGap = z.infer<typeof EvidenceGapSchema>;

/**
 * A challenge's `requiredEvidence` is free text written by an agent. It counts
 * as satisfied only when a registered evidence record actually matches it;
 * anything else is reported as an unverified reference and must never be
 * presented as if a source had been recorded.
 *
 * Shared so the report and the gap diagnosis cannot disagree about it.
 */
export function matchRequiredEvidence(
  required: readonly string[],
  registered: readonly Pick<Evidence, "title" | "content" | "description">[]
): { matched: string[]; unverifiedReferences: string[] } {
  const haystack = registered
    .map((item) => `${item.title} ${item.content} ${item.description}`.toLowerCase())
    .join("\n");
  const matched: string[] = [];
  const unverifiedReferences: string[] = [];
  for (const entry of required) {
    const needle = entry.trim().toLowerCase();
    if (needle.length === 0) {
      continue;
    }
    if (haystack.includes(needle)) {
      matched.push(entry);
    } else {
      unverifiedReferences.push(entry);
    }
  }
  return { matched, unverifiedReferences };
}

const suggestion = (label: string) => ({ label, status: "suggested" as const });

export type DiagnoseEvidenceGapsInput = {
  claim: Pick<Claim, "id" | "statement" | "type">;
  verdict: ClaimVerdict;
  /** Evidence attached to this claim. */
  evidence: readonly Evidence[];
  /** Sources registered in this research task. */
  sources: readonly Source[];
  /** Challenges aimed at this claim. */
  challenges: readonly Challenge[];
};

function sourceOf(
  item: Evidence,
  sourcesById: Map<string, Source>
): Source | undefined {
  return item.sourceId ? sourcesById.get(item.sourceId) : undefined;
}

/**
 * Pure: the same persisted state always produces the same gaps.
 */
export function diagnoseEvidenceGaps(
  input: DiagnoseEvidenceGapsInput
): EvidenceGap[] {
  const { claim, verdict } = input;
  const sourcesById = new Map(input.sources.map((item) => [item.id, item]));
  const byId = new Map(input.evidence.map((item) => [item.id, item]));

  const verified = input.evidence.filter(
    (item) => item.verificationStatus === "verified"
  );
  const supporting = verified.filter((item) => item.direction === "supports");
  const opposing = verified.filter((item) => item.direction === "opposes");

  const unresolved = input.challenges.filter(
    (challenge) => challenge.status !== "resolved"
  );
  const severeUnresolved = unresolved.filter(
    (challenge) => challenge.severity >= 4
  );
  const hasCounterCheck = input.challenges.some(
    (challenge) => challenge.type === "contradiction"
  );

  const unmappedByChallenge = input.challenges
    .map((challenge) => ({
      challenge,
      unmatched: matchRequiredEvidence(challenge.requiredEvidence, input.evidence)
        .unverifiedReferences
    }))
    .filter((entry) => entry.unmatched.length > 0);

  const gaps: EvidenceGap[] = [];
  const push = (gap: Omit<EvidenceGap, "claimId" | "id">, idSuffix = ""): void => {
    gaps.push({
      ...gap,
      claimId: claim.id,
      id: `${gap.kind}:${claim.id}${idSuffix}`
    });
  };

  // --- 1. nothing verified supports this claim ----------------------------
  if (supporting.length === 0 && verdict.counts.verified === 0) {
    push({
      kind: "no_verified_support",
      severity: "blocking",
      message: "尚无已核实的直接支持证据，当前无法得出支持该主张的结论。",
      detail: [
        `关联材料 ${verdict.counts.total} 条，其中已核实 ${verdict.counts.verified} 条。`,
        `命中的判定规则：${verdict.ruleHits.join("、")}。`
      ],
      evidenceIds: verdict.excluded
        .filter((entry) => entry.reason === "unverified")
        .map((entry) => entry.evidenceId),
      challengeIds: [],
      actions: ["record_source", "add_supporting_evidence", "run_cross_review"],
      suggestions: [
        suggestion(
          "查找能直接支持该表述的一手材料或原始数据（建议方向，未执行检索）"
        )
      ]
    });
  }

  // --- 2. material nobody has checked ------------------------------------
  const unverifiedIds = verdict.excluded
    .filter((entry) => entry.reason === "unverified")
    .map((entry) => entry.evidenceId);
  if (unverifiedIds.length > 0) {
    push({
      kind: "unverified_material",
      severity: "important",
      message: `${unverifiedIds.length} 条材料尚未核实，不能作为结论依据。`,
      detail: [
        `未核实材料：${unverifiedIds.length} 条；已核实 ${verdict.counts.verified} 条。`
      ],
      evidenceIds: unverifiedIds,
      challengeIds: [],
      actions: ["verify_evidence"],
      suggestions: [
        suggestion(
          "逐条对照来源原文，记录核实人与核实理由（建议动作，尚未执行）"
        )
      ]
    });
  }

  // --- 3. support without any attempt at a counter-check -----------------
  if (supporting.length > 0 && opposing.length === 0 && !hasCounterCheck) {
    push({
      kind: "no_counter_check",
      severity: "important",
      message: "已有支持证据，但没有针对该主张的反向检查记录。",
      detail: [
        `已核实支持 ${supporting.length} 条、已核实反对 0 条，且没有 contradiction 类型质询。`,
        "没有发现反例不等于该主张已被证明。"
      ],
      evidenceIds: supporting.map((item) => item.id),
      challengeIds: [],
      actions: ["add_opposing_evidence", "run_cross_review"],
      suggestions: [
        suggestion(
          "检索是否存在相反结论的研究、案例或数据（建议方向，未执行检索）"
        )
      ]
    });
  }

  // --- 4. no first-hand source behind the verified support --------------
  if (supporting.length > 0) {
    const withoutSource = supporting.filter(
      (item) => sourceOf(item, sourcesById) === undefined
    );
    if (withoutSource.length > 0) {
      push({
        kind: "missing_primary_source",
        severity: "important",
        message: `${withoutSource.length} 条支持证据没有登记来源，无法核对关键数字或时间范围。`,
        detail: withoutSource.map(
          (item) =>
            `「${item.title}」类型 ${item.kind}，来源：${
              item.sourceRef ? `仅有链接 ${item.sourceRef}` : "无来源记录"
            }。`
        ),
        evidenceIds: withoutSource.map((item) => item.id),
        challengeIds: [],
        actions: ["add_primary_source", "record_source"],
        suggestions: [
          suggestion(
            "定位发布该数字的原始报告或数据集，并登记为来源（建议方向，未执行检索）"
          )
        ]
      });
    }
  }

  // --- 5. material outside its validity window ---------------------------
  const expiredIds = verdict.excluded
    .filter((entry) => entry.reason === "expired")
    .map((entry) => entry.evidenceId);
  if (expiredIds.length > 0) {
    push({
      kind: "source_expired",
      severity: "important",
      message: `${expiredIds.length} 条材料已超出有效期，被排除在结论之外。`,
      detail: expiredIds.map((id) => {
        const item = byId.get(id);
        return item
          ? `「${item.title}」有效期至 ${item.validityPeriod?.to ?? "未记录"}。`
          : `材料 ${id} 已过期。`;
      }),
      evidenceIds: expiredIds,
      challengeIds: [],
      actions: ["add_primary_source"],
      suggestions: [
        suggestion("查找覆盖当前时间范围的更新版本（建议方向，未执行检索）")
      ]
    });
  }

  const notYetIds = verdict.excluded
    .filter((entry) => entry.reason === "not_yet_effective")
    .map((entry) => entry.evidenceId);
  if (notYetIds.length > 0) {
    push({
      kind: "source_not_yet_effective",
      severity: "advisory",
      message: `${notYetIds.length} 条材料的有效期尚未开始，暂不参与结论。`,
      detail: notYetIds.map((id) => {
        const item = byId.get(id);
        return item
          ? `「${item.title}」自 ${item.validityPeriod?.from ?? "未记录"} 起生效。`
          : `材料 ${id} 尚未生效。`;
      }),
      evidenceIds: notYetIds,
      challengeIds: [],
      actions: ["add_primary_source"],
      suggestions: []
    });
  }

  // --- 6. publication date unknown ---------------------------------------
  const unknownDateIds = verified
    .filter((item) => {
      const source = sourceOf(item, sourcesById);
      return source !== undefined && !source.publishedAt;
    })
    .map((item) => item.id);
  if (unknownDateIds.length > 0) {
    push({
      kind: "unknown_publication_date",
      severity: "advisory",
      message: `${unknownDateIds.length} 条已核实材料所引用的来源没有发布时间。`,
      detail: unknownDateIds.map((id) => {
        const item = byId.get(id);
        const source = item ? sourceOf(item, sourcesById) : undefined;
        return `「${item?.title ?? id}」的来源「${source?.title ?? "未命名"}」缺少 publishedAt。`;
      }),
      evidenceIds: unknownDateIds,
      challengeIds: [],
      actions: ["record_source"],
      suggestions: [
        suggestion("补齐来源的发布日期或版本号（建议动作，尚未执行）")
      ]
    });
  }

  // --- 7. independence of multiple sources not established ---------------
  if (verified.length >= 2) {
    const byPublisher = new Map<string, Evidence[]>();
    for (const item of verified) {
      const source = sourceOf(item, sourcesById);
      const key = source?.publisher ?? source?.id;
      if (!key) continue;
      byPublisher.set(key, [...(byPublisher.get(key) ?? []), item]);
    }
    const clustered = [...byPublisher.values()].filter(
      (group) => group.length >= 2
    );
    if (clustered.length > 0) {
      push({
        kind: "source_independence_unverified",
        severity: "advisory",
        message: `${clustered.length} 组材料可能来自同一发布方，来源独立性未确认。`,
        detail: clustered.map((group) => {
          const source = sourceOf(group[0]!, sourcesById);
          return `发布方「${source?.publisher ?? source?.title ?? "未知"}」下有多条材料：${group
            .map((item) => item.title)
            .join("、")}。`;
        }),
        evidenceIds: clustered.flat().map((item) => item.id),
        challengeIds: [],
        actions: ["add_primary_source"],
        suggestions: [
          suggestion(
            "确认这些材料是否引用同一个原始出处，必要时补充独立来源（建议方向，未执行检索）"
          )
        ]
      });
    }
  }

  // --- 8. quotes that cannot be re-checked -------------------------------
  const unlocatableIds = verified
    .filter((item) => !item.locator)
    .map((item) => item.id);
  if (unlocatableIds.length > 0) {
    push({
      kind: "excerpt_not_locatable",
      severity: "advisory",
      message: `${unlocatableIds.length} 条已核实材料没有记录原文定位，无法重新定位核对。`,
      detail: unlocatableIds.map(
        (id) =>
          `「${byId.get(id)?.title ?? id}」缺少 locator（页码 / 段落 / 行号）。`
      ),
      evidenceIds: unlocatableIds,
      challengeIds: [],
      actions: ["record_source"],
      suggestions: [suggestion("补充页码、段落或表行号（建议动作，尚未执行）")]
    });
  }

  // --- 9. an open dispute from cross-examination -------------------------
  if (severeUnresolved.length > 0) {
    push({
      kind: "unresolved_dispute",
      severity: "blocking",
      message: `交叉审查仍有 ${severeUnresolved.length} 项高严重度争议未解决，结论不能超出本轮审查范围。`,
      detail: severeUnresolved.map(
        (challenge) =>
          `[严重度 ${challenge.severity}] ${challenge.question}（解决方式：${challenge.resolutionStrategy}）`
      ),
      evidenceIds: [],
      challengeIds: severeUnresolved.map((challenge) => challenge.id).sort(),
      actions: ["run_cross_review", "add_supporting_evidence"],
      suggestions: severeUnresolved.flatMap((challenge) =>
        challenge.requiredEvidence
          .slice(0, 3)
          .map((entry) =>
            suggestion(`${entry}（挑战者提出的方向，未登记为证据，未执行检索）`)
          )
      )
    });
  }

  // --- 10. challenger references that map to nothing ---------------------
  if (unmappedByChallenge.length > 0) {
    const unmatched = unmappedByChallenge.flatMap((entry) => entry.unmatched);
    push({
      kind: "unmapped_reference",
      severity: "important",
      message: `交叉审查提到 ${unmatched.length} 项材料，但它们没有登记为证据。`,
      detail: [
        ...unmatched.map((entry) => `未登记为证据：${entry}`),
        "这些条目只是挑战者的自述，不能当作已核实证据参与结论。"
      ],
      evidenceIds: [],
      challengeIds: unmappedByChallenge
        .map((entry) => entry.challenge.id)
        .sort(),
      actions: ["record_source", "add_supporting_evidence"],
      suggestions: unmatched
        .slice(0, 5)
        .map((entry) =>
          suggestion(`${entry}（建议补充方向，未登记为证据，未执行检索）`)
        )
    });
  }

  // --- 11. a human explicitly asked for more material --------------------
  if (verdict.review?.outcome === "needs_more_evidence") {
    push({
      kind: "review_requires_more_evidence",
      severity: "blocking",
      message: `人工复核要求补充证据：${verdict.review.reviewer}。`,
      detail: [
        `复核理由：${verdict.review.rationale}`,
        `复核时间：${verdict.review.createdAt}`,
        verdict.review.evidenceIds.length > 0
          ? `复核引用材料 ${verdict.review.evidenceIds.length} 条。`
          : "复核未引用具体材料。"
      ],
      evidenceIds: [...verdict.review.evidenceIds],
      challengeIds: [],
      actions: ["add_supporting_evidence", "run_cross_review", "record_source"],
      suggestions: []
    });
  }

  // --- 12. a claim stated wider than any evidence could reach -------------
  // A single report cannot establish "所有", "必然" or "从来". The gap is
  // about the wording, so it is raised on the statement itself and points at
  // the material that would have to cover the whole range.
  const absoluteWording =
    /(所有|全部|任何|一律|总是|从来|永远|必然|一定|毫无|完全|普遍|绝不|\ball\b|\bevery\b|\bnever\b|\balways\b)/i;
  if (absoluteWording.test(claim.statement)) {
    push({
      kind: "overbroad_claim",
      severity: "important",
      message: "主张使用了全称或绝对化措辞，现有材料无法支撑这一范围。",
      detail: [
        `主张原文：${claim.statement}`,
        "全称表述需要覆盖全部情形的证据；单条或少数材料只能支持更窄的结论。",
        `当前已核实支持 ${supporting.length} 条。`
      ],
      evidenceIds: supporting.map((item) => item.id),
      challengeIds: [],
      actions: [
        "add_opposing_evidence",
        "add_supporting_evidence",
        "run_cross_review"
      ],
      suggestions: [
        suggestion(
          "检索是否存在反例或适用条件，必要时收窄表述（建议方向，未执行检索）"
        )
      ]
    });
  }

  // --- 13. time range, scope or causality never established ---------------
  // Only raised when material exists at all: otherwise gap 1 already says the
  // louder thing, and two gaps for one absence would inflate the plan.
  const causalWording = /(因为|由于|导致|造成|因此|从而|使得|随之|引发)/;
  const temporalWording =
    /(\d{4}\s*年|同比|环比|以来|之后|去年同期|近\s*\d+\s*年|上个季度|本季度|季度|月度)/;
  const causal = causalWording.test(claim.statement);
  const temporal = temporalWording.test(claim.statement);
  if ((claim.type === "prediction" || causal || temporal) && verdict.counts.total > 0) {
    const datedSources = verified
      .map((item) => sourceOf(item, sourcesById))
      .filter((source) => source !== undefined && Boolean(source.publishedAt));
    if (datedSources.length === 0) {
      const reasons: string[] = [];
      if (claim.type === "prediction") reasons.push("主张类型为预测。");
      if (causal) reasons.push("主张包含因果措辞。");
      if (temporal) reasons.push("主张包含时间范围措辞。");
      push({
        kind: "insufficient_time_or_scope_evidence",
        severity: "important",
        message:
          "主张涉及时间范围、范围口径或因果关系，但没有任何带发布时间的已核实来源。",
        detail: [
          ...reasons,
          `已核实材料 ${verified.length} 条，其中所引来源带发布时间的 0 条。`,
          "没有时间坐标的材料无法支撑时间或因果类表述。"
        ],
        evidenceIds: verified.map((item) => item.id),
        challengeIds: [],
        actions: ["add_primary_source", "record_source"],
        suggestions: [
          suggestion(
            "补充带明确发布时间、且覆盖该时间范围的材料（建议方向，未执行检索）"
          )
        ]
      });
    }
  }

  return gaps;
}
