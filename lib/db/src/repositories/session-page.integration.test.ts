import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { newId } from "@nexus/shared";
import type { Database } from "../client";
import { createTestDatabase } from "../testing/test-database";
import { conflicts, projects } from "../schema";
import {
  encodeSessionCursor,
  InvalidSessionCursorError,
  listSessionPage,
  parseSessionCursor
} from "./session-page";

/**
 * 会话列表分页，在真库上验证。
 *
 * 这一组用例存在的理由只有一条：**翻页必须不重不漏**。分页的三种典型实现都会
 * 在这一点上出错，而三种错误都不会在 mock 里暴露——
 *
 *  1. offset 分页：翻页途中有人新建会话，第二页会重复第一页的最后一条；
 *  2. 单列游标（只用 `updated_at`）：时间戳不唯一，同一毫秒的两条会在页边界上
 *     漏掉一条或重复一条；
 *  3. 毫秒游标：驱动把 `timestamptz` 解析成 `Date`，精度只剩毫秒，边界处同一毫秒
 *     的行会被整体跳过。
 *
 * 第 2、3 种在下面都有专门的用例，且都用**真实插入的时间戳**触发，不靠注入假值。
 */

// fail-closed：未配置 TEST_DATABASE_URL 时在建连之前抛错；目标必须是专用测试库。
const database: Database = createTestDatabase();

beforeEach(async () => {
  await database.execute("TRUNCATE projects CASCADE");
});

afterAll(async () => {
  await database.end();
});

type Seed = { id: string; updatedAt: string };

/**
 * 用原始 SQL 插入，而不是走 Drizzle 的 `values()`：只有这样才能表达微秒。
 * 驱动把 JS 的 `Date` 传成 timestamptz 时会截到毫秒，而「同一毫秒」正是要测的东西。
 */
async function seedSession(options: {
  name: string;
  /** ISO 8601，可到微秒，例如 2026-10-05T00:00:00.123456Z */
  updatedAt: string;
  projectId?: string;
}): Promise<Seed> {
  const projectId = options.projectId ?? newId();
  if (options.projectId === undefined) {
    await database.insert(projects).values({
      id: projectId,
      name: options.name,
      input: {},
      locale: "zh-CN"
    });
  }
  const id = newId();
  await database.execute(sql`
    insert into decision_sessions
      (id, project_id, locale, phase, operational_status, created_at, updated_at)
    values
      (${id}::uuid, ${projectId}::uuid, 'zh-CN', 'CREATED', 'ACTIVE',
       ${options.updatedAt}::timestamptz, ${options.updatedAt}::timestamptz)
  `);
  return { id, updatedAt: options.updatedAt };
}

/** 一路翻到底，按请求顺序返回每一页。 */
async function walkPages(pageSize: number, sessionIds?: readonly string[]) {
  type Page = Awaited<ReturnType<typeof listSessionPage>>;
  const pages: Page[] = [];
  let after: string | null = null;
  for (let step = 0; step < 50; step += 1) {
    const request: { limit: number; after?: string } = { limit: pageSize };
    if (after !== null) request.after = after;
    const result = await listSessionPage(database, request, sessionIds);
    pages.push(result);
    if (!result.hasNextPage || result.nextCursor === null) break;
    after = String(result.nextCursor);
  }
  return pages;
}

/** `updated_at` 降序、同时间戳时 id 降序——与查询的 `ORDER BY` 逐字对应。 */
function expectedOrder(seeds: readonly Seed[]): string[] {
  return [...seeds]
    .sort((left, right) => {
      if (left.updatedAt !== right.updatedAt) {
        return left.updatedAt < right.updatedAt ? 1 : -1;
      }
      return left.id < right.id ? 1 : -1;
    })
    .map((seed) => seed.id);
}

describe("会话列表分页", () => {
  it("翻到底：不重、不漏、顺序稳定", async () => {
    // 两组同时间戳，专门制造「单列游标说不清顺序」的位置。
    const seeds = [
      await seedSession({ name: "十月一日 A", updatedAt: "2026-10-01T00:00:00.000Z" }),
      await seedSession({ name: "十月一日 B", updatedAt: "2026-10-01T00:00:00.000Z" }),
      await seedSession({ name: "十月二日 A", updatedAt: "2026-10-02T00:00:00.000Z" }),
      await seedSession({ name: "十月二日 B", updatedAt: "2026-10-02T00:00:00.000Z" }),
      await seedSession({ name: "十月三日", updatedAt: "2026-10-03T00:00:00.000Z" }),
      await seedSession({ name: "十月四日 A", updatedAt: "2026-10-04T00:00:00.000Z" }),
      await seedSession({ name: "十月四日 B", updatedAt: "2026-10-04T00:00:00.000Z" })
    ];

    const pages = await walkPages(3);

    // 页大小按 n+1 判页：最后不满一页，且只有最后一页说「没有下一页」。
    expect(pages.map((page) => page.items.length)).toEqual([3, 3, 1]);
    expect(pages.map((page) => page.hasNextPage)).toEqual([true, true, false]);
    expect(pages[pages.length - 1]?.nextCursor).toBeNull();

    const collected = pages.flatMap((page) => page.items.map((item) => item.id));
    expect(collected).toHaveLength(seeds.length);
    // 不重。
    expect(new Set(collected).size).toBe(seeds.length);
    // 不漏，且顺序与 ORDER BY 一致——包括两组同时间戳。
    expect(collected).toEqual(expectedOrder(seeds));
  });

  it("同一毫秒内的多条记录不会被页边界跳过", async () => {
    const projectId = newId();
    await database.insert(projects).values({
      id: projectId,
      name: "同一毫秒",
      input: {},
      locale: "zh-CN"
    });
    // 三条都落在 ...T00:00:00.123 这一毫秒里，只差微秒。
    const seeds: Seed[] = [];
    for (const stamp of [
      "2026-10-05T00:00:00.123001Z",
      "2026-10-05T00:00:00.123002Z",
      "2026-10-05T00:00:00.123003Z"
    ]) {
      seeds.push(
        await seedSession({ name: "微秒", updatedAt: stamp, projectId })
      );
    }

    // 一次只取一条：任何一次页边界都落在同一毫秒内部。
    const pages = await walkPages(1);
    const collected = pages.flatMap((page) => page.items.map((item) => item.id));

    expect(collected).toHaveLength(3);
    expect(new Set(collected).size).toBe(3);
    expect([...collected].sort()).toEqual([...seeds.map((seed) => seed.id)].sort());
  });

  it("游标是微秒 + id，且能原样往返", async () => {
    const first = await seedSession({
      name: "第一条",
      updatedAt: "2026-10-06T00:00:00.654321Z"
    });
    await seedSession({
      name: "第二条",
      updatedAt: "2026-10-05T00:00:00.000000Z"
    });

    const [page] = await walkPages(1);
    const cursor = String(page?.nextCursor ?? "");
    const [micros, id] = cursor.split("|");
    // 微秒精度保留在游标里：654321，不是 654000。这正是毫秒游标会丢掉的位。
    const epochMillis = Date.parse("2026-10-06T00:00:00.654Z");
    expect(micros).toBe(String(epochMillis * 1000 + 321));
    expect(id).toBe(first.id);
    expect(parseSessionCursor(cursor)).toEqual({ micros, id: first.id });
    expect(parseSessionCursor(encodeSessionCursor("1", first.id))?.id).toBe(first.id);
  });

  it("只认自己发过的游标，其余抛错而不是悄悄回到第一页", async () => {
    await seedSession({ name: "随便一条", updatedAt: "2026-10-07T00:00:00.000Z" });

    await expect(
      listSessionPage(database, { limit: 5, after: "not-a-cursor" })
    ).rejects.toBeInstanceOf(InvalidSessionCursorError);
    await expect(
      listSessionPage(database, { limit: 5, after: "123" })
    ).rejects.toBeInstanceOf(InvalidSessionCursorError);
    await expect(
      listSessionPage(database, { limit: 5, after: `1700000000000000|${newId()}` })
    ).resolves.toMatchObject({ items: [], hasNextPage: false });
  });

  it("可读集合为空时返回空页，不是「不加限制」", async () => {
    await seedSession({ name: "别人的研究", updatedAt: "2026-10-08T00:00:00.000Z" });

    const result = await listSessionPage(database, { limit: 10 }, []);

    expect(result.items).toHaveLength(0);
    expect(result.hasNextPage).toBe(false);
    expect(result.nextCursor).toBeNull();
  });

  it("受限调用者只看到自己的那几条", async () => {
    const mine = await seedSession({
      name: "我的",
      updatedAt: "2026-10-09T00:00:00.000Z"
    });
    await seedSession({ name: "别人的", updatedAt: "2026-10-10T00:00:00.000Z" });

    const result = await listSessionPage(database, { limit: 10 }, [mine.id]);

    expect(result.items.map((item) => item.id)).toEqual([mine.id]);
    expect(result.hasNextPage).toBe(false);
  });

  it("分歧数量只统计本页的行", async () => {
    const withConflicts = await seedSession({
      name: "有分歧",
      updatedAt: "2026-10-11T00:00:00.000Z"
    });
    const withoutConflicts = await seedSession({
      name: "无分歧",
      updatedAt: "2026-10-12T00:00:00.000Z"
    });

    for (let index = 0; index < 2; index += 1) {
      await database.insert(conflicts).values({
        id: newId(),
        sessionId: withConflicts.id,
        claimIds: [],
        challengeIds: [],
        type: "EVIDENCE",
        summary: `分歧 ${index}`,
        severity: 2,
        status: "OPEN",
        humanDecisionRequired: false,
        resolutionSuggestion: "n/a",
        impactScope: []
      });
    }

    const result = await listSessionPage(database, { limit: 10 });
    const byId = new Map(result.items.map((item) => [item.id, item]));

    expect(byId.get(withConflicts.id)?.conflictCount).toBe(2);
    expect(byId.get(withoutConflicts.id)?.conflictCount).toBe(0);
  });

  it("页大小为 0 时按契约抬到 1，而不是返回空页", async () => {
    await seedSession({ name: "较新", updatedAt: "2026-10-14T00:00:00.000Z" });
    await seedSession({ name: "较旧", updatedAt: "2026-10-13T00:00:00.000Z" });

    const result = await listSessionPage(database, { limit: 0 });

    expect(result.items).toHaveLength(1);
    expect(result.hasNextPage).toBe(true);
  });
});
