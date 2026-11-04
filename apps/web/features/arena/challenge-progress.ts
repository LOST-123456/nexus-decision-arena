import type { ExecutionEvent } from "@nexus/shared";

/**
 * 这一轮质询跑到哪儿了。
 *
 * 只有一个计时器的时候，"还要等多久"是个猜的数字：33 秒的活儿和卡死的
 * 活儿长得一模一样。`CHALLENGE_BATCH_STARTED` 带着本轮总数，之后每条质询
 * 都会留下痕迹，两个数一对就是进度。
 *
 * **两个口径，不是一个。**
 *
 * 质询一条要三次模型调用：提问、应答、判定。所以"问题已经问出来了"和
 * "这一条已经走完"是两件事。只数 `CHALLENGE_CREATED` 的话，页面会在第一
 * 条刚写下问题时就报"第 5 / 10 条"，而那 5 条其实一条都还没答完——那是
 * 在说谎。分开报：已提出（asked）说明工作在推进，已完成（done）说明
 * 真的收尾了几条。
 *
 * **只认当前这一轮。**
 *
 * 补充轮会再发一条批次开始。上一轮的数字如果留着，新一轮刚点下去、批次
 * 还没宣布的那一两秒里，页面就会显示"上一轮已提出 10 条、已完成 10 条
 * （全部走完）"——那不是这一轮的情况，说出来就是在骗人。所以先找本轮的
 * 起点（本轮进入重评估或质询的那一刻），只数它之后的批次；本轮还没宣布
 * 批次时，答案是"还不知道"，不是上一轮的旧数。
 */
export type ChallengeProgress = {
  /** 已经把问题问出来多少条（问题已经写下来了）。 */
  asked: number;
  /** 已经走完全程多少条（应答与判定都结束，含失败的）。 */
  done: number;
  /** 这一轮一共要做多少条。 */
  total: number;
};

/** 会开启新一轮质询的阶段。 */
const ROUND_START_PHASES = new Set(["REASSESSING", "CHALLENGING"]);

function phaseOf(event: ExecutionEvent): string | null {
  if (event.type !== "SESSION_STATE_CHANGED") return null;
  const payload = event.payload as { phase?: unknown } | null;
  return typeof payload?.phase === "string" ? payload.phase : null;
}

export function findChallengeProgress(
  events: readonly ExecutionEvent[]
): ChallengeProgress | null {
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence);

  /*
   * 本轮的起点：最后一个"进入重评估或质询"的状态变更。
   *
   * 它之前发生的都是上一轮的事，不该算进本轮的进度。
   */
  let roundStart = -1;
  for (const event of ordered) {
    const phase = phaseOf(event);
    if (phase !== null && ROUND_START_PHASES.has(phase)) {
      roundStart = event.sequence;
    }
  }

  let batchStart = -1;
  let total = 0;
  for (const event of ordered) {
    if (event.sequence <= roundStart) continue;
    if (event.type !== "CHALLENGE_BATCH_STARTED") continue;
    const payload = event.payload as { total?: unknown } | null;
    if (typeof payload?.total !== "number" || payload.total <= 0) continue;
    batchStart = event.sequence;
    total = payload.total;
  }
  if (batchStart < 0) return null;

  let asked = 0;
  let done = 0;
  for (const event of ordered) {
    if (event.sequence <= batchStart) continue;
    if (event.type === "CHALLENGE_CREATED") asked += 1;
    /*
     * 失败的质询也算"走完了"。
     *
     * 它不会再往前推进了（重试是另一轮的事）。不把它算进去的话，进度会永远
     * 停在 total - 1，页面看上去像还差一条，其实那条已经结束了。
     */
    if (event.type === "CHALLENGE_RESOLVED" || event.type === "CHALLENGE_FAILED") {
      done += 1;
    }
  }

  return { asked, done, total };
}
