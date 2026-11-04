import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { newId, type ClaimInspectorDTO } from "@nexus/shared";
import { Inspector } from "./inspector";

function inspectorFixture(): ClaimInspectorDTO {
  const id = newId();
  const timestamp = new Date().toISOString();
  return {
    claim: {
      id,
      sessionId: newId(),
      agentRunId: newId(),
      roleId: newId(),
      lens: "market",
      statement: "The growth target lacks evidence",
      type: "assumption",
      stance: "oppose",
      importance: 5,
      confidence: 0.2,
      evidenceIds: [],
      status: "contested",
      rootClaimId: id,
      revision: 1,
      relations: [],
      createdAt: timestamp,
      updatedAt: timestamp
    },
    evidence: [],
    challenges: [],
    conflicts: [],
    provenance: {
      agentRun: undefined,
      promptVersion: undefined
    },
    decisionRationale: {
      outcome: "contested",
      summary: "Procurement evidence is still missing.",
      decisiveChallengeIds: [],
      evidenceIds: []
    }
  };
}

describe("Inspector", () => {
  it("shows the structured decision rationale", () => {
    render(<Inspector data={inspectorFixture()} />);

    expect(
      screen.getByText("Procurement evidence is still missing.")
    ).toBeTruthy();
    expect(screen.getByText("DECISION RATIONALE")).toBeTruthy();
  });

  /**
   * 这一组标签以前是英文：Evidence / Challenges / Conflicts / Status /
   * Decisive challenges / Linked evidence。而同一屏的其它文字全是中文，
   * 连隔壁 `反方 Claim` 旁边的兄弟节点都写着「结构化质询」——说明这是漏改，
   * 不是设计。
   *
   * 状态值也要一起翻：枚举名 `contested` 是给代码看的，不是给读的人看的。
   * 映射复用 `claimStatusLabel`，与研究面同一份，避免两个面各翻一套。
   */
  it("用中文标签，且状态与裁决结果都不是给代码看的枚举名", () => {
    const { container } = render(<Inspector data={inspectorFixture()} />);

    // `getByText("证据")` 会连带匹配「关联证据」一类的兄弟节点，所以这里
    // 直接取标签集合与字段集合。
    const terms = Array.from(container.querySelectorAll("dt")).map(
      (node) => node.textContent
    );
    expect(terms).toEqual([
      "证据",
      "质询",
      "冲突",
      "状态",
      "决定性质询",
      "关联证据"
    ]);

    const values = Array.from(container.querySelectorAll("dd")).map(
      (node) => node.textContent
    );
    // 主张状态：contested → 有争议
    expect(values[3]).toBe("有争议");

    // 裁决结果同样是枚举，也不许原样露出；措辞要和上一行区分开。
    expect(container.querySelector(".inspector-rationale strong")?.textContent).toBe(
      "未定论"
    );

    expect(container.textContent).not.toContain("contested");
    for (const gone of ["Evidence", "Challenges", "Conflicts", "Decisive challenges"]) {
      expect(screen.queryByText(gone), `${gone} 不应再出现`).toBeNull();
    }
  });
});