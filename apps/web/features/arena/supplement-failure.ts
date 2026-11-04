import type { ExecutionEvent } from "@nexus/shared";

/**
 * 补充分析改成后台执行之后，"失败"不再有地方可以返回。
 *
 * 上一版是 `await runSession.start(...)`，失败会顺着 HTTP 响应回到页面，页面
 * 弹一行红字就完事。现在那条响应早就发出去了（这正是"点按钮不再卡住"的原因），
 * 于是失败只剩一个出口：core 写下的 `AGENT_RUN_FAILED` 事件。
 *
 * 这个函数就是把它找出来，好让右栏说"这一轮没跑起来"，而不是继续转计时器。
 * 只认**最近一次**进入 REASSESSING 之后发生的那条，避免上一轮的旧失败一直在
 * 新的一轮里冒出来。阶段已经离开 REASSESSING 时一律返回 null。
 */
export function findSupplementFailure(
  events: readonly ExecutionEvent[],
  phase: string
): string | null {
  if (phase !== "REASSESSING") return null;

  const ordered = [...events].sort((a, b) => a.sequence - b.sequence);

  let reassessingSince = -1;
  for (const event of ordered) {
    if (event.type !== "SESSION_STATE_CHANGED") continue;
    const payload = event.payload as { phase?: unknown } | null;
    if (payload?.phase === "REASSESSING") {
      reassessingSince = event.sequence;
    }
  }
  if (reassessingSince < 0) return null;

  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const event = ordered[index]!;
    if (event.sequence <= reassessingSince) break;
    if (event.type !== "AGENT_RUN_FAILED") continue;
    const payload = event.payload as
      | { stage?: unknown; message?: unknown }
      | null;
    if (payload?.stage !== "supplement_round") continue;
    return typeof payload.message === "string" && payload.message.length > 0
      ? payload.message
      : "没有留下失败原因";
  }

  return null;
}
