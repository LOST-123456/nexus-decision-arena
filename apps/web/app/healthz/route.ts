/**
 * 站点自己的健康端点：证明这个进程在监听、能返回 200。
 *
 * 为什么需要它：Playwright 启动 web 时用过一个业务页面（`/sessions/demo`）做
 * 探活，而那个页面要 SSR 取数——core 还没就绪时它回 502，测试于是等到超时，
 * 报出来的却是「web server 启动失败」。探活应该只回答「dev server 起来了没」，
 * 不该顺带要求整条业务链路已经通。
 *
 * 放在 `/healthz` 而不是 `/api/healthz`：`next.config.ts` 把所有 `/api/*`
 * rewrite 给 core，放进去就等于把探活也交给了被测服务。
 */
export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json({ ok: true, uptimeSeconds: Math.round(process.uptime()) });
}

/**
 * HEAD as well, because a health check does not owe you a body — and a probe
 * that sends HEAD must not read 405 as "still starting".
 */
export function HEAD(): Response {
  return new Response(null, { status: 200 });
}
