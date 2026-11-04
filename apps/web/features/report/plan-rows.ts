/**
 * 把一次决策会话里的质询摊成一张可执行的计划表。
 *
 * 设计约束（与「AI 建议≠人工核实」红线一致）：
 * - 每一行必须能追溯到一条真实存在的质询，不做任何推测性合并；
 * - 「待办事项」只取自质询自己声明的 requiredEvidence，取不到才退回质询原文；
 * - 「针对的主张」只取自被质疑主张的原文，取不到就明写「未记录」；
 * - 「必办 / 参考」只反映该质询是否被本次裁决直接采纳，不代表优先级排序。
 */

export type PlanRow = {
  key: string;
  /** 需要补齐的材料。 */
  action: string;
  /** 这条材料是为了支撑哪一条被质疑的主张（可能被截断）。 */
  basis: string;
  /** basis 截断前的原文，用于 hover 展示；未截断时与 basis 相同。 */
  basisFull: string;
  raisedBy: string;
  severity: number;
  severityLabel: string;
  /** 是否被本次裁决直接采纳。 */
  decisive: boolean;
};

export type PlanChallenge = {
  id: string;
  targetClaimId: string;
  question: string;
  requiredEvidence: string[];
  severity: number;
  challengerRoleId: string;
};

export type PlanSource = {
  agents?: ReadonlyArray<{ id: string; name: string }>;
  claims?: ReadonlyArray<{ id: string; statement: string }>;
  challenges?: readonly PlanChallenge[];
};

export type PlanTable = {
  rows: PlanRow[];
  /** 没有声明所需材料、也没有可用的质询原文，导致无法生成待办事项的质询条数。 */
  missingMaterial: number;
  /** 与已有行「材料 + 被质疑主张」完全一致而被合并掉的质询条数。 */
  mergedDuplicates: number;
};

/** 主张原文超过这个长度就截断，避免单行把表格撑爆。 */
export const MAX_BASIS_LENGTH = 96;

const TAIL_PUNCTUATION = /[。！？；，、\s]+$/u;

function trimTail(text: string): string {
  return text.replace(TAIL_PUNCTUATION, "").trim();
}

export function severityLabelOf(severity: number): string {
  if (severity >= 5) return "极高";
  if (severity >= 4) return "高";
  if (severity >= 3) return "中";
  if (severity >= 2) return "偏低";
  return "低";
}

function clampBasis(statement: string): { basis: string; basisFull: string } {
  const full = trimTail(statement);
  if (full.length <= MAX_BASIS_LENGTH) return { basis: full, basisFull: full };
  return { basis: `${full.slice(0, MAX_BASIS_LENGTH)}…`, basisFull: full };
}

function actionOf(challenge: PlanChallenge): string {
  const materials = challenge.requiredEvidence
    .map(trimTail)
    .filter((item) => item.length > 0);
  if (materials.length > 0) return materials.join("、");
  return trimTail(challenge.question);
}

export function buildPlanRows(
  decisiveChallengeIds: readonly string[],
  source: PlanSource | null
): PlanTable {
  const challenges = source?.challenges ?? [];
  if (challenges.length === 0) {
    return { rows: [], missingMaterial: 0, mergedDuplicates: 0 };
  }

  const roleName = new Map(
    (source?.agents ?? []).map((role) => [role.id, role.name])
  );
  const claimStatement = new Map(
    (source?.claims ?? []).map((claim) => [claim.id, claim.statement])
  );
  const decisive = new Set(decisiveChallengeIds);

  const rows: PlanRow[] = [];
  const rowBySubject = new Map<string, PlanRow>();
  let missingMaterial = 0;
  let mergedDuplicates = 0;

  for (const challenge of challenges) {
    const action = actionOf(challenge);
    if (action === "") {
      missingMaterial += 1;
      continue;
    }
    const claim = claimStatement.get(challenge.targetClaimId);
    const { basis, basisFull } = clampBasis(claim ?? "");
    // 同一条主张缺同一份材料 = 同一个待办事项，合并成一行即可；
    // 但只要其中任何一条质询被裁决采纳，这一行就是必办。
    const dedupeKey = `${action}\u0000${basisFull}`;
    const existing = rowBySubject.get(dedupeKey);
    if (existing) {
      mergedDuplicates += 1;
      existing.decisive = existing.decisive || decisive.has(challenge.id);
      existing.severity = Math.max(existing.severity, challenge.severity);
      existing.severityLabel = severityLabelOf(existing.severity);
      continue;
    }
    const row: PlanRow = {
      key: challenge.id,
      action,
      basis,
      basisFull,
      raisedBy: roleName.get(challenge.challengerRoleId) ?? "未记录",
      severity: challenge.severity,
      severityLabel: severityLabelOf(challenge.severity),
      decisive: decisive.has(challenge.id)
    };
    rowBySubject.set(dedupeKey, row);
    rows.push(row);
  }

  // 必办在前；同组内按严重度从高到低；严重度相同保持质询原始顺序（sort 稳定）。
  const sorted = rows.sort((a, b) => {
    if (a.decisive !== b.decisive) return a.decisive ? -1 : 1;
    return b.severity - a.severity;
  });

  return { rows: sorted, missingMaterial, mergedDuplicates };
}
