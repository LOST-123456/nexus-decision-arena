import type { ExecutionEvent } from "@nexus/shared";
import { describe, expect, it } from "vitest";
import { findChallengeProgress } from "./challenge-progress";

const SESSION = "0198f3c0-0000-7000-8000-00000000cc01";
const CORRELATION = "0198f3c0-0000-7000-8000-00000000dd01";

function event(
  sequence: number,
  type: ExecutionEvent["type"],
  payload: unknown
): ExecutionEvent {
  return {
    id: `0198f3c0-0000-7000-8000-${String(sequence).padStart(12, "0")}`,
    sessionId: SESSION,
    sequence,
    correlationId: CORRELATION,
    type,
    payload,
    occurredAt: "2026-10-30T00:00:00.000Z"
  };
}

const batch = (sequence: number, total: number) =>
  event(sequence, "CHALLENGE_BATCH_STARTED", { total });
const created = (sequence: number) => event(sequence, "CHALLENGE_CREATED", {});
const resolved = (sequence: number) => event(sequence, "CHALLENGE_RESOLVED", {});
const failed = (sequence: number) => event(sequence, "CHALLENGE_FAILED", {});
const phase = (sequence: number, value: string) =>
  event(sequence, "SESSION_STATE_CHANGED", { phase: value });

describe("findChallengeProgress", () => {
  it("分别报出已提出与已完成的条数", () => {
    const events = [
      batch(10, 10),
      created(11),
      created(12),
      created(13),
      resolved(14)
    ];
    expect(findChallengeProgress(events)).toEqual({
      asked: 3,
      done: 1,
      total: 10
    });
  });

  it("新一轮开始后只认新一轮的数", () => {
    const events = [
      batch(10, 4),
      created(11),
      created(12),
      resolved(13),
      batch(20, 6),
      created(21)
    ];
    expect(findChallengeProgress(events)).toEqual({
      asked: 1,
      done: 0,
      total: 6
    });
  });

  /**
   * 点下去之后、新一批次还没宣布的那一两秒里，页面最容易说谎：
   * 上一轮的"10 条已全部走完"还挂在进度栏上，看着像这一轮已经跑完了。
   * 新一轮既然已经开了，本轮的进度就还没���数——不知道就说不知道。
   */
  it("新一轮刚开始、批次还没宣布时不报上一轮的旧数", () => {
    const events = [
      phase(5, "CHALLENGING"),
      batch(6, 10),
      created(7),
      created(8),
      resolved(9),
      phase(20, "REASSESSING")
    ];
    expect(findChallengeProgress(events)).toBeNull();
  });

  it("新一轮的批次一到就从头开始数", () => {
    const events = [
      phase(5, "CHALLENGING"),
      batch(6, 10),
      created(7),
      resolved(8),
      phase(20, "REASSESSING"),
      phase(21, "CHALLENGING"),
      batch(22, 10),
      created(23)
    ];
    expect(findChallengeProgress(events)).toEqual({
      asked: 1,
      done: 0,
      total: 10
    });
  });

  it("失败的质询也算走完了，不会让进度永远差一条", () => {
    const events = [batch(10, 2), created(11), failed(12)];
    expect(findChallengeProgress(events)).toEqual({
      asked: 1,
      done: 1,
      total: 2
    });
  });

  it("还没有批次就还没有进度", () => {
    expect(findChallengeProgress([created(11)])).toBeNull();
  });

  it("总数不合法时不谎报", () => {
    expect(findChallengeProgress([batch(10, 0)])).toBeNull();
  });
});
