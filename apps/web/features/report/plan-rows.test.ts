import { describe, expect, it } from "vitest";
import {
  MAX_BASIS_LENGTH,
  buildPlanRows,
  severityLabelOf,
  type PlanSource
} from "./plan-rows";

const roleA = "role-market";
const roleB = "role-risk";

function source(overrides: Partial<PlanSource> = {}): PlanSource {
  return {
    agents: [
      { id: roleA, name: "市场分析师" },
      { id: roleB, name: "风险审查员" }
    ],
    claims: [
      { id: "claim-1", statement: "按实验室数量收取年度订阅费。" },
      { id: "claim-2", statement: "六个月内完成首批部署。" }
    ],
    challenges: [
      {
        id: "ch-1",
        targetClaimId: "claim-1",
        question: "缺少什么证据？",
        requiredEvidence: ["采购名单", "历史转化率"],
        severity: 3,
        challengerRoleId: roleA
      },
      {
        id: "ch-2",
        targetClaimId: "claim-2",
        question: "缺少什么证据？",
        requiredEvidence: ["部署排期"],
        severity: 5,
        challengerRoleId: roleB
      }
    ],
    ...overrides
  };
}

describe("severityLabelOf", () => {
  it("把 1-5 级映射成中文档位", () => {
    expect([1, 2, 3, 4, 5].map(severityLabelOf)).toEqual([
      "低",
      "偏低",
      "中",
      "高",
      "极高"
    ]);
  });
});

describe("buildPlanRows", () => {
  it("每条质询一行，多项材料合并进「待办事项」", () => {
    const { rows } = buildPlanRows([], source());
    expect(rows).toHaveLength(2);
    const purchase = rows.find((row) => row.key === "ch-1");
    expect(purchase?.action).toBe("采购名单、历史转化率");
  });

  it("用被质疑主张的原文做依据，并去掉句末标点", () => {
    const { rows } = buildPlanRows([], source());
    expect(rows.find((row) => row.key === "ch-2")?.basis).toBe(
      "六个月内完成首批部署"
    );
  });

  it("把提出角色 id 翻成角色名", () => {
    const { rows } = buildPlanRows([], source());
    expect(rows.find((row) => row.key === "ch-1")?.raisedBy).toBe("市场分析师");
    expect(rows.find((row) => row.key === "ch-2")?.raisedBy).toBe("风险审查员");
  });

  it("被裁决采纳的质询排在最前面，其次是严重度降序", () => {
    const { rows } = buildPlanRows(["ch-1"], source());
    expect(rows.map((row) => row.key)).toEqual(["ch-1", "ch-2"]);
    expect(rows[0]?.decisive).toBe(true);
    expect(rows[1]?.decisive).toBe(false);

    const severityOrder = buildPlanRows([], source()).rows.map(
      (row) => row.severity
    );
    expect(severityOrder).toEqual([5, 3]);
  });

  it("缺角色名或主张原文时降级成「未记录」，不猜", () => {
    const { rows } = buildPlanRows(
      [],
      source({
        agents: [],
        claims: [],
        challenges: [
          {
            id: "ch-9",
            targetClaimId: "missing-claim",
            question: "缺少什么证据？",
            requiredEvidence: ["采购记录"],
            severity: 4,
            challengerRoleId: "missing-role"
          }
        ]
      })
    );
    expect(rows[0]?.raisedBy).toBe("未记录");
    expect(rows[0]?.basis).toBe("");
    expect(rows[0]?.basisFull).toBe("");
  });

  it("没声明所需材料时退回质询原文，不空转出一行空白", () => {
    const { rows } = buildPlanRows(
      [],
      source({
        challenges: [
          {
            id: "ch-3",
            targetClaimId: "claim-1",
            question: "缺少什么证据？",
            requiredEvidence: [],
            severity: 2,
            challengerRoleId: roleA
          }
        ]
      })
    );
    expect(rows[0]?.action).toBe("缺少什么证据");
  });

  it("材料和质询原文都空时跳过，并计入 missingMaterial", () => {
    const result = buildPlanRows(
      [],
      source({
        challenges: [
          {
            id: "ch-4",
            targetClaimId: "claim-1",
            question: "   ",
            requiredEvidence: [],
            severity: 1,
            challengerRoleId: roleA
          }
        ]
      })
    );
    expect(result.rows).toHaveLength(0);
    expect(result.missingMaterial).toBe(1);
    expect(result.mergedDuplicates).toBe(0);
  });

  it("材料和主张都相同的重复质询只留一行，并计入 mergedDuplicates", () => {
    const duplicate = {
      targetClaimId: "claim-1",
      question: "缺少什么证据？",
      requiredEvidence: ["采购记录"],
      severity: 4,
      challengerRoleId: roleA
    };
    const result = buildPlanRows(
      [],
      source({
        challenges: [
          { ...duplicate, id: "ch-5" },
          { ...duplicate, id: "ch-6" }
        ]
      })
    );
    expect(result.rows).toHaveLength(1);
    expect(result.mergedDuplicates).toBe(1);
    expect(result.missingMaterial).toBe(0);
  });

  it("合并后的行只要有一条质询被采纳就是必办，严重度取较高者", () => {
    const duplicate = {
      targetClaimId: "claim-1",
      question: "缺少什么证据？",
      requiredEvidence: ["采购记录"],
      severity: 2,
      challengerRoleId: roleA
    };
    const result = buildPlanRows(
      ["ch-7"],
      source({
        challenges: [
          { ...duplicate, id: "ch-7", severity: 2 },
          { ...duplicate, id: "ch-8", severity: 5 }
        ]
      })
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.decisive).toBe(true);
    expect(result.rows[0]?.severity).toBe(5);
    expect(result.rows[0]?.severityLabel).toBe("极高");
  });

  it("过长的主张原文截断并保留全文供悬浮显示", () => {
    const long = `${"证".repeat(MAX_BASIS_LENGTH + 20)}。`;
    const { rows } = buildPlanRows(
      [],
      source({
        claims: [
          { id: "claim-1", statement: long },
          { id: "claim-2", statement: "六个月内完成首批部署。" }
        ]
      })
    );
    const truncated = rows.find((row) => row.key === "ch-1");
    expect(truncated?.basis.endsWith("…")).toBe(true);
    expect(truncated?.basis.length).toBe(MAX_BASIS_LENGTH + 1);
    expect(truncated?.basisFull.length).toBe(MAX_BASIS_LENGTH + 20);
  });

  it("没有质询时返回空表，交给页面回退到有序列表", () => {
    expect(buildPlanRows(["ch-1"], null)).toEqual({
      rows: [],
      missingMaterial: 0,
      mergedDuplicates: 0
    });
    expect(buildPlanRows(["ch-1"], source({ challenges: [] }))).toEqual({
      rows: [],
      missingMaterial: 0,
      mergedDuplicates: 0
    });
  });
});
