import { asc, desc, eq } from "drizzle-orm";
import {
  FinalReportSchema,
  humanActionLabel,
  newId,
  type Challenge,
  type Claim,
  type Conflict,
  type Evidence,
  type FinalReport
} from "@nexus/shared";
import type { Database } from "../client";
import {
  challenges,
  claims,
  conflicts,
  decisionSessions,
  evidence,
  executionEvents,
  finalReports,
  humanDecisions,
  projects
} from "../schema";
import {
  parseChallenges,
  parseClaims,
  parseConflicts,
  parseEvidence,
  parseHumanDecisions
} from "./domain-mapper";

export class ReportNotReadyError extends Error {
  constructor() {
    super("Final report is not ready until a human decision is recorded");
    this.name = "ReportNotReadyError";
  }
}

function conclusionFromEvent(payload: unknown): string | null {
  if (
    payload !== null &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    "currentConclusion" in payload &&
    typeof payload.currentConclusion === "string"
  ) {
    return payload.currentConclusion;
  }
  return null;
}

/**
 * 严重度 1–5 的档位说法。只描述强度，不额外评分。
 */
function severityBand(severity: number): string {
  if (severity >= 5) return "极高";
  if (severity >= 4) return "高";
  if (severity >= 3) return "中";
  if (severity >= 2) return "偏低";
  return "低";
}

const CONFLICT_TYPE_LABELS: Record<Conflict["type"], string> = {
  evidence: "证据分歧",
  logic: "逻辑分歧",
  assumption: "假设分歧",
  priority: "优先级分歧"
};

const CHALLENGE_TYPE_LABELS: Record<Challenge["type"], string> = {
  evidence_gap: "证据缺口",
  logic_flaw: "逻辑漏洞",
  contradiction: "前后矛盾",
  feasibility: "可行性",
  priority: "优先级"
};

/**
 * 质询里出现最多的类型。用于摘要里说明「这次主要卡在哪」。
 */
function dominantChallengeType(
  challenges: readonly Challenge[]
): Challenge["type"] | null {
  if (challenges.length === 0) return null;
  const tally = new Map<Challenge["type"], number>();
  for (const item of challenges) {
    tally.set(item.type, (tally.get(item.type) ?? 0) + 1);
  }
  let best: Challenge["type"] | null = null;
  let bestCount = 0;
  for (const [type, count] of tally) {
    if (count > bestCount) {
      best = type;
      bestCount = count;
    }
  }
  return best;
}

/**
 * 执行摘要：用本次会话真正跑出来的数字写，而不是把四个结论标签串成一行。
 * 每一句都必须能在会话数据里找到对应事实，不做推测。
 */
function buildExecutiveSummary(input: {
  projectName: string;
  firstConclusion: string;
  postChallengeConclusion: string;
  finalConclusion: string;
  humanAction: string;
  claims: readonly Claim[];
  evidence: readonly Evidence[];
  conflicts: readonly Conflict[];
  challenges: readonly Challenge[];
  requiredNextActions: readonly string[];
  /** 有一份人工裁决时，质询/冲突/证据都只是「与本次裁决相关」的子集。 */
  scopedToDecision: boolean;
}): string {
  const {
    projectName,
    firstConclusion,
    postChallengeConclusion,
    finalConclusion,
    humanAction,
    claims,
    evidence,
    conflicts,
    challenges,
    requiredNextActions,
    scopedToDecision
  } = input;

  const sentences: string[] = [];

  sentences.push(
    firstConclusion === finalConclusion
      ? `「${projectName}」经五角色评审，结论维持在「${finalConclusion}」，未因质询发生方向性改变。`
      : `「${projectName}」经五角色评审，结论由初步的「${firstConclusion}」收紧为「${finalConclusion}」，质询后的中间态是「${postChallengeConclusion}」。`
  );

  const challengeCount =
    challenges.length > 0
      ? challenges.length
      : conflicts.reduce((sum, item) => sum + item.challengeIds.length, 0);
  const maxSeverity = conflicts.reduce(
    (max, item) => Math.max(max, item.severity),
    0
  );
  const mustEscalate = conflicts.filter(
    (item) => item.humanDecisionRequired
  ).length;

  if (conflicts.length > 0 || challengeCount > 0) {
    const dominantType = dominantChallengeType(challenges);
    sentences.push(
      `${
        scopedToDecision ? "与本次裁决直接相关的" : "分析阶段"
      }质询共 ${challengeCount} 条、归并为 ${conflicts.length} 处冲突，` +
        `最高严重度 ${maxSeverity}/5（${severityBand(maxSeverity)}）` +
        (dominantType ? `，主要集中在「${CHALLENGE_TYPE_LABELS[dominantType]}」` : "") +
        (mustEscalate > 0
          ? `，其中 ${mustEscalate} 处被判定必须由人工裁决。`
          : "，均由流程内部收敛。")
    );
  } else {
    sentences.push(
      "分析阶段未形成结构性冲突，五角色的判断方向一致，因此没有触发人工升级。"
    );
  }

  if (evidence.length > 0) {
    const verifiedCount = evidence.filter(
      (item) => item.verificationStatus === "verified"
    ).length;
    const opposingCount = evidence.filter(
      (item) => item.direction === "opposes"
    ).length;
    // 证据实际覆盖的主张数，而不是全会话的主张数：
    // 「1 条证据覆盖 18 项主张」读起来像在虚报覆盖面。
    const coveredClaimIds = new Set(evidence.flatMap((item) => item.claimIds));
    const coveredCount =
      coveredClaimIds.size > 0 ? coveredClaimIds.size : claims.length;
    sentences.push(
      `本报告关联 ${evidence.length} 条证据，触达 ${coveredCount} 项主张，` +
        `其中已人工核实 ${verifiedCount} 条、${opposingCount} 条指向反对方向。` +
        (verifiedCount === 0
          ? "目前全部证据仍处于未核实状态，结论强度依赖于假设而非实证。"
          : "")
    );
  }

  sentences.push(`人工裁决动作为「${humanAction}」。`);

  if (requiredNextActions.length > 0) {
    const preview = requiredNextActions
      .slice(0, 3)
      .map((item) => withoutEndPunctuation(item))
      .join("、");
    sentences.push(
      `结论落地前仍需补齐 ${requiredNextActions.length} 项材料：${preview}` +
        (requiredNextActions.length > 3 ? " 等。" : "。")
    );
  }

  return sentences.join("");
}

/**
 * 保证一段文本以句子结束符收尾，避免多段拼接时粘在一起。
 */
function asSentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return trimmed;
  return /[。！？.!?；;]$/.test(trimmed) ? trimmed : `${trimmed}。`;
}

/**
 * 去掉句末标点，供「拼进一个长句再用；连接」的场景使用，
 * 否则会出现「…依据。；」这种双标点。
 */
function withoutEndPunctuation(text: string): string {
  return text.trim().replace(/[。！？.!?；;，,]+$/u, "");
}

/**
 * 模型倾向于在处置建议前面写英文动词（Provide: / Provide ...），
 * 报告是中文的，而且这一条前面已经有「处置方向：」这个标签，
 * 所以把动词整个去掉，只留建议内容。
 */
function normalizeSuggestion(text: string): string {
  return withoutEndPunctuation(text)
    .replace(/^\s*provide\s*[:：]\s*/iu, "")
    .replace(/^\s*provide\s+/iu, "");
}

/**
 * 决策解释：裁决理由 + 关键分歧 + 处置方向，三段各自成句。
 */
function buildDecisionExplanation(input: {
  rationale: string | null;
  conflicts: readonly Conflict[];
  requiredNextActions: readonly string[];
}): string {
  const { rationale, conflicts, requiredNextActions } = input;
  const blocks: string[] = [];

  if (rationale) {
    blocks.push(`裁决理由：${asSentence(rationale)}`);
  } else if (conflicts.length > 0) {
    blocks.push(
      "本次会话未记录人工裁决理由，以下解释由质询结果直接推导，不代表任何人已签字确认。"
    );
  } else {
    blocks.push(
      "本次会话既无人工裁决，也未形成高严重度冲突，因此没有需要解释的取舍。"
    );
  }

  if (conflicts.length > 0) {
    // 两个角色经常针对同一条主张提出实质相同的质疑，措辞只差角色名，
    // 按文本去重抓不住。按「同一批主张 + 同一分歧类型」去重才准。
    const seen = new Set<string>();
    const ranked: string[] = [];
    for (const item of [...conflicts].sort((a, b) => b.severity - a.severity)) {
      const key =
        item.claimIds.length > 0
          ? `${item.type}|${[...item.claimIds].sort().join(",")}`
          : `${item.type}|${withoutEndPunctuation(item.summary).replace(/\s+/gu, "")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      ranked.push(
        `（${CONFLICT_TYPE_LABELS[item.type]}，严重度 ${item.severity}/5）${withoutEndPunctuation(item.summary)}`
      );
      if (ranked.length === 3) break;
    }
    blocks.push(`关键分歧：${ranked.join("；")}。`);
  }

  const suggestions = [
    ...new Set(
      conflicts
        .map((item) => item.resolutionSuggestion)
        .filter(Boolean)
        .map((item) => normalizeSuggestion(item))
    )
  ];
  if (suggestions.length > 0) {
    blocks.push(`处置方向：${suggestions.join("；")}。`);
  }

  if (requiredNextActions.length > 0) {
    blocks.push(
      `补齐材料后本结论才具备可审计的依据：${requiredNextActions
        .map((item) => withoutEndPunctuation(item))
        .join("；")}。`
    );
  }

  return blocks.join("");
}

function toFinalReport(
  row: typeof finalReports.$inferSelect
): FinalReport {
  return FinalReportSchema.parse({
    ...row,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
    humanDecisionId: row.humanDecisionId ?? undefined
  });
}

export class FinalReportRepository {
  constructor(private readonly database: Database) {}

  async getBySessionId(sessionId: string): Promise<FinalReport | null> {
    const [row] = await this.database
      .select()
      .from(finalReports)
      .where(eq(finalReports.sessionId, sessionId))
      .limit(1);
    return row ? toFinalReport(row) : null;
  }

  async generateAndPersist(sessionId: string): Promise<FinalReport> {
    const [session] = await this.database
      .select()
      .from(decisionSessions)
      .where(eq(decisionSessions.id, sessionId))
      .limit(1);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (session.phase !== "DECIDED" && session.phase !== "REPORT_READY") {
      throw new ReportNotReadyError();
    }

    const [project] = await this.database
      .select()
      .from(projects)
      .where(eq(projects.id, session.projectId))
      .limit(1);
    const sessionClaims = parseClaims(
      await this.database
        .select()
        .from(claims)
        .where(eq(claims.sessionId, sessionId))
    );
    const sessionEvidence = parseEvidence(
      await this.database
        .select()
        .from(evidence)
        .where(eq(evidence.sessionId, sessionId))
    );
    const sessionConflicts = parseConflicts(
      await this.database
        .select()
        .from(conflicts)
        .where(eq(conflicts.sessionId, sessionId))
    );
    const sessionChallenges = parseChallenges(
      await this.database
        .select()
        .from(challenges)
        .where(eq(challenges.sessionId, sessionId))
    );
    const [latestDecisionRow] = await this.database
      .select()
      .from(humanDecisions)
      .where(eq(humanDecisions.sessionId, sessionId))
      .orderBy(desc(humanDecisions.createdAt))
      .limit(1);
    const sessionEvents = await this.database
      .select()
      .from(executionEvents)
      .where(eq(executionEvents.sessionId, sessionId))
      .orderBy(asc(executionEvents.sequence));

    const latestDecision = latestDecisionRow
      ? parseHumanDecisions([latestDecisionRow])[0]
      : undefined;

    const affectedClaimIds = latestDecision?.affectedClaimIds ?? [];
    const decisiveConflicts = sessionConflicts.filter((conflict) =>
      conflict.claimIds.some((claimId) => affectedClaimIds.includes(claimId))
    );
    const relevantConflicts =
      decisiveConflicts.length > 0 ? decisiveConflicts : sessionConflicts;
    const decisiveChallengeIds = [
      ...new Set(relevantConflicts.flatMap((conflict) => conflict.challengeIds))
    ];
    const decisiveChallenges = sessionChallenges.filter((challenge) =>
      decisiveChallengeIds.includes(challenge.id)
    );
    const relevantClaimIds = new Set([
      ...affectedClaimIds,
      ...decisiveChallenges.map((challenge) => challenge.targetClaimId)
    ]);
    const relevantEvidence =
      relevantClaimIds.size === 0
        ? sessionEvidence
        : sessionEvidence.filter(
            (item) =>
              item.claimIds.some((claimId) => relevantClaimIds.has(claimId)) ||
              sessionClaims.some(
                (claim) =>
                  claim.id === item.claimIds[0] &&
                  relevantClaimIds.has(claim.id)
              )
          );
    const requiredNextActions = [
      ...new Set(
        decisiveChallenges.flatMap((challenge) => challenge.requiredEvidence)
      )
    ];
    const firstConclusion =
      sessionEvents
        .map((event) => conclusionFromEvent(event.payload))
        .find((conclusion): conclusion is string => Boolean(conclusion)) ??
      session.currentConclusion ?? "结论待定";
    const postChallengeConclusion =
      latestDecision?.previousConclusion ??
      session.currentConclusion ??
      "结论待定";
    const finalConclusion =
      session.currentConclusion ??
      latestDecision?.newConclusion ??
      postChallengeConclusion;
    const humanAction = latestDecision
      ? humanActionLabel(latestDecision.action)
      : "无需人工介入";
    const decisionExplanation = buildDecisionExplanation({
      rationale: latestDecision?.rationale ?? null,
      conflicts: relevantConflicts,
      requiredNextActions
    });
    const executiveSummary = buildExecutiveSummary({
      projectName: project?.name ?? "未命名决策会话",
      firstConclusion,
      postChallengeConclusion,
      finalConclusion,
      humanAction,
      claims: sessionClaims,
      evidence: relevantEvidence,
      conflicts: relevantConflicts,
      challenges: decisiveChallenges,
      requiredNextActions,
      scopedToDecision: latestDecision !== undefined
    });
    const now = new Date().toISOString();
    const report = FinalReportSchema.parse({
      id: newId(),
      sessionId,
      projectName: project?.name ?? "未命名决策会话",
      executiveSummary,
      initialConclusion: firstConclusion,
      postChallengeConclusion,
      humanAction,
      finalConclusion,
      decisionExplanation,
      requiredNextActions,
      decisiveChallengeIds,
      evidenceIds: relevantEvidence.map((item) => item.id),
      ...(latestDecision ? { humanDecisionId: latestDecision.id } : {}),
      createdAt: now,
      updatedAt: now
    });

    const [persisted] = await this.database
      .insert(finalReports)
      .values({
        id: report.id,
        sessionId: report.sessionId,
        projectName: report.projectName,
        executiveSummary: report.executiveSummary,
        initialConclusion: report.initialConclusion,
        postChallengeConclusion: report.postChallengeConclusion,
        humanAction: report.humanAction,
        finalConclusion: report.finalConclusion,
        decisionExplanation: report.decisionExplanation,
        requiredNextActions: report.requiredNextActions,
        decisiveChallengeIds: report.decisiveChallengeIds,
        evidenceIds: report.evidenceIds,
        humanDecisionId: report.humanDecisionId ?? null,
        createdAt: report.createdAt,
        updatedAt: report.updatedAt
      })
      .onConflictDoUpdate({
        target: finalReports.sessionId,
        set: {
          projectName: report.projectName,
          executiveSummary: report.executiveSummary,
          initialConclusion: report.initialConclusion,
          postChallengeConclusion: report.postChallengeConclusion,
          humanAction: report.humanAction,
          finalConclusion: report.finalConclusion,
          decisionExplanation: report.decisionExplanation,
          requiredNextActions: report.requiredNextActions,
          decisiveChallengeIds: report.decisiveChallengeIds,
          evidenceIds: report.evidenceIds,
          humanDecisionId: report.humanDecisionId ?? null,
          updatedAt: report.updatedAt
        }
      })
      .returning();

    if (!persisted) {
      throw new Error("Final report persistence failed");
    }
    return toFinalReport(persisted);
  }
}
