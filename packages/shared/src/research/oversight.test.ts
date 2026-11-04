import { describe, expect, it } from "vitest";
import {
  challengeAcceptedRate,
  completedRunRate,
  EMPTY_OVERSIGHT_COUNTS,
  formatRate,
  OversightCountsSchema,
  type OversightCounts
} from "./oversight";

function counts(over: {
  decisions?: Partial<OversightCounts["decisions"]>;
  runs?: Partial<OversightCounts["runs"]>;
}): OversightCounts {
  return {
    ...EMPTY_OVERSIGHT_COUNTS,
    sessionCount: 1,
    decisions: { ...EMPTY_OVERSIGHT_COUNTS.decisions, ...over.decisions },
    runs: { ...EMPTY_OVERSIGHT_COUNTS.runs, ...over.runs }
  };
}

/**
 * 分母为零时不给比率 —— 这是这个面板唯一容易说错的地方。
 *
 * 一个从没被裁决过的工作区，画一根 0% 的柱子等于说「AI 从不被推翻」，那是和
 * 事实相反的结论。返回 `null` 并显示「暂无数据」，说的是「还没有过」。
 */
describe("oversight rates", () => {
  it("has no acceptance rate before anything was decided", () => {
    expect(challengeAcceptedRate(counts({}))).toBeNull();
    expect(formatRate(null)).toBe("暂无数据");
  });

  it("reports the share of challenges a person accepted", () => {
    const value = counts({
      decisions: {
        total: 4,
        acceptChallenge: 1,
        upholdClaim: 2,
        requestMoreAnalysis: 1
      }
    });
    expect(challengeAcceptedRate(value)).toBe(0.25);
    expect(formatRate(0.25)).toBe("25%");
    // 0% is a real answer when the denominator is real.
    expect(
      challengeAcceptedRate(counts({ decisions: { total: 3, upholdClaim: 3 } }))
    ).toBe(0);
    expect(formatRate(0)).toBe("0%");
  });

  it("counts cancelled and timed-out runs as not completed", () => {
    const value = counts({
      runs: { total: 10, completed: 6, failed: 2, timedOut: 1, cancelled: 1 }
    });
    // 6/10, not 7/10: a cancelled run did not do the job. Counting it as
    // success is how a dashboard ends up saying "98% reliable".
    expect(completedRunRate(value)).toBe(0.6);
  });

  it("has no completion rate before anything ran", () => {
    expect(completedRunRate(counts({}))).toBeNull();
  });
});

describe("OversightCountsSchema", () => {
  it("accepts the empty shape, so an idle workspace is not an error", () => {
    expect(OversightCountsSchema.parse(EMPTY_OVERSIGHT_COUNTS)).toEqual(
      EMPTY_OVERSIGHT_COUNTS
    );
  });

  it("rejects a negative count rather than rendering a bar below zero", () => {
    const broken = {
      ...EMPTY_OVERSIGHT_COUNTS,
      conflicts: { ...EMPTY_OVERSIGHT_COUNTS.conflicts, total: -1 }
    };
    expect(OversightCountsSchema.safeParse(broken).success).toBe(false);
  });
});
