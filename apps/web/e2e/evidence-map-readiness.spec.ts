import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { OWNER_PASSWORD } from "./support/credentials";

/**
 * Evidence Map regression suite.
 *
 * The prompt that produced this file was a real defect: the panel published
 * React Flow's `useNodesInitialized()`, which for a controlled
 * `<ReactFlow nodes>` with no `onNodesChange` is permanently false. The graph
 * drew itself perfectly and the page still said "not ready" until the test
 * timed out. What follows therefore checks the things a reader of the map
 * actually depends on — that the nodes and the relations are on screen, that a
 * filter never leaves an edge hanging off nothing, that the two readiness
 * states the panel now publishes stay honest — in a real browser, on both
 * viewports the product ships.
 *
 * Screenshots go to `artifacts/playwright-p24`, deliberately separate from the
 * `artifacts/playwright` directory the arena spec writes to.
 */

const claimStatement = "该产品在华南区的复购率高于华北区。";
const supportingTitle = "支持方向年报";
const opposingTitle = "反对方向年报";
const supportingExcerpt = "华南区复购率为 31%。";
const opposingExcerpt = "华北区复购率为 24%。";

async function loginAsOwner(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("用户名").fill("owner");
  await page.getByLabel("密码").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: /^登录/ }).click();
  await expect(page).toHaveURL(/\/$/);
}

async function createResearch(page: Page, question: string): Promise<string> {
  const created = await page.context().request.post("/api/sessions", {
    headers: { "idempotency-key": `e2e-map24-${randomUUID()}` },
    data: {
      project: {
        name: "Evidence map regression",
        summary: "Readiness and layout regression coverage",
        targetUsers: "researchers",
        businessModel: "n/a",
        expectedData: "none"
      },
      locale: "zh-CN",
      researchQuestion: question
    }
  });
  expect(created.status()).toBe(201);
  const { id } = (await created.json()) as { id: string };
  return id;
}

async function postClaim(
  page: Page,
  sessionId: string,
  statement: string
): Promise<string> {
  const claim = await page.context().request.post(
    `/api/sessions/${sessionId}/claims`,
    {
      headers: { "idempotency-key": `e2e-map24-claim-${randomUUID()}` },
      data: { statement, type: "fact", stance: "support", importance: 3 }
    }
  );
  expect(claim.status()).toBe(201);
  const { claim: body } = (await claim.json()) as { claim: { id: string } };
  return body.id;
}

/** Registers a local file, which is how a source enters the session. */
async function importFile(
  page: Page,
  sessionId: string,
  fileName: string,
  text: string
): Promise<{ id: string; title: string }> {
  const uploaded = await page.context().request.post(
    `/api/sessions/${sessionId}/files`,
    {
      headers: {
        "content-type": "application/octet-stream",
        "x-file-name": encodeURIComponent(fileName),
        "idempotency-key": `e2e-map24-file-${randomUUID()}`
      },
      data: Buffer.from(text, "utf8")
    }
  );
  expect(uploaded.status()).toBe(201);
  const body = (await uploaded.json()) as {
    source: { id: string; title: string } | null;
    duplicated: boolean;
  };
  expect(body.duplicated).toBe(false);
  expect(body.source).not.toBeNull();
  return { id: body.source!.id, title: body.source!.title };
}

async function postEvidence(
  page: Page,
  sessionId: string,
  input: {
    title: string;
    content: string;
    direction: "supports" | "opposes";
    claimIds: string[];
    sourceId?: string;
  }
): Promise<void> {
  const evidence = await page.context().request.post(
    `/api/sessions/${sessionId}/evidence`,
    {
      headers: { "idempotency-key": `e2e-map24-evidence-${randomUUID()}` },
      data: {
        kind: "external_reference",
        title: input.title,
        content: input.content,
        description: "回归用例录入的原句。",
        sourceRef: "https://example.org/regression",
        direction: input.direction,
        reliability: 0.5,
        claimIds: input.claimIds,
        ...(input.sourceId ? { sourceId: input.sourceId } : {})
      }
    }
  );
  expect(evidence.status()).toBe(201);
}

/** A session carrying one claim, both directions, and a real source. */
async function seedRichGraph(page: Page): Promise<string> {
  const sessionId = await createResearch(
    page,
    "华南区复购率是否高于华北区？"
  );
  const claimId = await postClaim(page, sessionId, claimStatement);
  const file = await importFile(
    page,
    sessionId,
    "repurchase-region.txt",
    "华南区复购率为 31%。\n\n华北区复购率为 24%。\n"
  );
  await postEvidence(page, sessionId, {
    title: supportingTitle,
    content: supportingExcerpt,
    direction: "supports",
    claimIds: [claimId],
    sourceId: file.id
  });
  await postEvidence(page, sessionId, {
    title: opposingTitle,
    content: opposingExcerpt,
    direction: "opposes",
    claimIds: [claimId]
  });
  return sessionId;
}

async function openMap(page: Page, sessionId: string): Promise<void> {
  await page.goto(`/research/${sessionId}`);
  await page.getByRole("tab", { name: "证据地图" }).click();
}

const canvas = (page: Page) => page.getByTestId("evidence-map-canvas");

/** Waits for the panel's own readiness signal — never a bare timeout. */
async function waitForMapReady(page: Page): Promise<void> {
  await expect(canvas(page)).toBeVisible();
  await expect(canvas(page)).toHaveAttribute("data-graph-loaded", "true", {
    timeout: 20_000
  });
  await expect(canvas(page)).toHaveAttribute("data-nodes-ready", "true", {
    timeout: 20_000
  });
}

/** Screenshot next to the run, never over the arena's protected artifacts. */
async function capture(
  page: Page,
  projectName: string,
  name: string
): Promise<void> {
  const directory = resolve(process.cwd(), "../../artifacts/playwright-p24");
  await mkdir(directory, { recursive: true });
  await page.screenshot({
    path: resolve(directory, `${projectName}-${name}.png`),
    fullPage: false
  });
}

/** Node ids React Flow has actually put in the DOM, in render order. */
async function renderedNodeIds(page: Page): Promise<string[]> {
  return page.$$eval(".react-flow__node", (nodes) =>
    nodes.map((node) => node.getAttribute("data-id") ?? "")
  );
}

/**
 * Screen-space endpoints of every drawn edge, read through the SVG's own CTM
 * so the answer does not depend on the current zoom or pan.
 */
async function edgeEndpoints(
  page: Page
): Promise<Array<{ label: string; from: [number, number]; to: [number, number] }>> {
  return page.$$eval(".react-flow__edge", (groups) => {
    const out: Array<{
      label: string;
      from: [number, number];
      to: [number, number];
    }> = [];
    for (const group of groups) {
      const path = group.querySelector("path");
      if (!path) continue;
      const d = path.getAttribute("d") ?? "";
      const numbers = d.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
      const svg = path.ownerSVGElement;
      const ctm = path.getScreenCTM();
      if (numbers.length < 4 || !svg || !ctm) continue;
      const point = svg.createSVGPoint();
      const project = (x: number, y: number): [number, number] => {
        point.x = x;
        point.y = y;
        const screen = point.matrixTransform(ctm);
        return [screen.x, screen.y];
      };
      const lastX = numbers[numbers.length - 2] ?? 0;
      const lastY = numbers[numbers.length - 1] ?? 0;
      out.push({
        label:
          group.querySelector(".react-flow__edge-text")?.textContent ?? "",
        from: project(numbers[0] ?? 0, numbers[1] ?? 0),
        to: project(lastX, lastY)
      });
    }
    return out;
  });
}

test.describe("evidence map readiness and layout", () => {
  test("publishes the two readiness states separately, and only when true", async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAsOwner(page);
    const sessionId = await seedRichGraph(page);
    await openMap(page, sessionId);

    // The graph arrived and every node has been measured: the panel says so,
    // in its own words, on the element the reader can inspect.
    await waitForMapReady(page);

    // The measured state is not a latch: swapping the node set drops it, and
    // it comes back on its own once the new nodes are laid out.
    await page.evaluate(() => {
      const target = document.querySelector(
        '[data-testid="evidence-map-canvas"]'
      );
      const seen: string[] = [];
      if (!target) return;
      const record = () => {
        const value = target.getAttribute("data-nodes-ready");
        if (seen[seen.length - 1] !== value && value !== null) seen.push(value);
      };
      new MutationObserver(record).observe(target, {
        attributes: true,
        attributeFilter: ["data-nodes-ready"]
      });
      record();
      (window as unknown as { __readyTrace: string[] }).__readyTrace = seen;
    });

    await page.getByTestId("evidence-map-filters").getByText("只看主张").click();
    await expect(canvas(page)).toHaveAttribute("data-nodes-ready", "true", {
      timeout: 20_000
    });
    const trace = await page.evaluate(
      () => (window as unknown as { __readyTrace: string[] }).__readyTrace
    );
    // It went true (from the first wait), then false when the node set was
    // swapped, then true again — not true throughout.
    expect(trace).toContain("false");
    expect(trace[trace.length - 1]).toBe("true");

    await capture(page, testInfo.project.name, "evidence-map-readiness");
  });

  test("draws every node kind and both directions of relation", async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAsOwner(page);
    const sessionId = await seedRichGraph(page);
    await openMap(page, sessionId);
    await waitForMapReady(page);

    // Claim, evidence and source nodes, each as its own rendered node.
    await expect(
      page.locator('.evidence-map-node[data-node-type="claim"]')
    ).toHaveCount(1);
    await expect(
      page.locator('.evidence-map-node[data-node-type="evidence"]')
    ).toHaveCount(2);
    await expect(
      page.locator('.evidence-map-node[data-node-type="source"]')
    ).toHaveCount(1);

    await expect(page.getByText(claimStatement)).toBeVisible();
    await expect(page.getByText(supportingTitle)).toBeVisible();
    await expect(page.getByText(opposingTitle)).toBeVisible();

    // Both directions are drawn, and labelled as the recorded direction.
    const labels = await page.$$eval(".react-flow__edge-text", (nodes) =>
      nodes.map((node) => node.textContent ?? "")
    );
    expect(labels).toContain("支持");
    expect(labels).toContain("反对");
    expect(labels).toContain("出自来源");

    // The map still refuses to read as a verdict.
    await expect(
      page.getByText(/不代表已证实；结论以\s*Verdict 与人工审核为准/)
    ).toBeVisible();

    await capture(page, testInfo.project.name, "evidence-map-graph");
  });

  test("keeps every edge attached after a filter narrows the graph", async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAsOwner(page);
    const sessionId = await seedRichGraph(page);
    await openMap(page, sessionId);
    await waitForMapReady(page);

    // The projection is the product's own record of what the map should show,
    // so it is the yardstick for "no edge is hanging off a node that is gone".
    const projection = await page.context().request.get(
      `/api/sessions/${sessionId}/evidence-map`
    );
    expect(projection.status()).toBe(200);
    const graph = (await projection.json()) as {
      nodes: Array<{ id: string }>;
      edges: Array<{ id: string; from: string; to: string }>;
    };
    expect(graph.nodes.length).toBe(4);
    expect(graph.edges.length).toBe(3);

    const beforeIds = await renderedNodeIds(page);
    expect(new Set(beforeIds)).toEqual(new Set(graph.nodes.map((n) => n.id)));
    await expect(page.locator(".react-flow__edge")).toHaveCount(3);

    await page.getByTestId("evidence-map-filters").getByText("只看主张").click();
    await expect(canvas(page)).toHaveAttribute("data-nodes-ready", "true", {
      timeout: 20_000
    });

    const afterIds = await renderedNodeIds(page);
    expect(afterIds.length).toBe(1);
    // The claim filter keeps the claim and nothing else.
    expect(afterIds.every((id) => id.startsWith("claim:"))).toBe(true);
    await expect(
      page.locator(".evidence-map-node", { hasText: supportingTitle })
    ).toHaveCount(0);

    // No edge survives a filter that removed one of its ends: the "只看主张"
    // view has a single node, so it must have no edges at all.
    await expect(page.locator(".react-flow__edge")).toHaveCount(0);

    // And the reverse direction — back to the full graph, all three edges are
    // drawn, and each endpoint lands on a node that is actually on screen.
    await page.getByTestId("evidence-map-filters").getByText("全部").click();
    await expect(canvas(page)).toHaveAttribute("data-nodes-ready", "true", {
      timeout: 20_000
    });
    const endpoints = await edgeEndpoints(page);
    expect(endpoints.length).toBe(3);
    const labels = endpoints.map((edge) => edge.label);
    expect(labels).toContain("支持");
    expect(labels).toContain("反对");
    expect(labels).toContain("出自来源");

    const nodeRects = await page.$$eval(".react-flow__node", (nodes) =>
      nodes.map((node) => {
        const rect = node.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      })
    );
    // React Flow starts a smoothstep path a couple of pixels outside the node,
    // at the handle, so "on a node" is checked with a handle-sized margin.
    const MARGIN = 40;
    const insideSomeNode = (point: [number, number]): boolean =>
      nodeRects.some(
        (rect) =>
          point[0] >= rect.left - MARGIN &&
          point[0] <= rect.right + MARGIN &&
          point[1] >= rect.top - MARGIN &&
          point[1] <= rect.bottom + MARGIN
      );
    for (const edge of endpoints) {
      expect(
        insideSomeNode(edge.from),
        `edge "${edge.label}" starts off every node`
      ).toBe(true);
      expect(
        insideSomeNode(edge.to),
        `edge "${edge.label}" ends off every node`
      ).toBe(true);
    }

    await capture(page, testInfo.project.name, "evidence-map-filter");
  });

  test("opens the node detail on click, and says the excerpt is still unverified", async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAsOwner(page);
    const sessionId = await seedRichGraph(page);
    await openMap(page, sessionId);
    await waitForMapReady(page);

    await page.getByText(supportingTitle).first().click();
    const detail = page.getByTestId("evidence-map-detail");
    await expect(detail).toBeVisible();
    await expect(detail).toContainText("摘录");
    await expect(detail).toContainText(supportingExcerpt);
    await expect(detail).toContainText("核实状态");
    await expect(detail).toContainText("待核实");
    await expect(detail).toContainText("出自来源");
    await expect(detail).toContainText("方向");

    // The claim node reports the derived verdict, not a proof.
    await page.getByText(claimStatement).first().click();
    await expect(detail).toContainText("Verdict");
    await expect(detail).toContainText("不改变判定");

    await capture(page, testInfo.project.name, "evidence-map-detail");
  });

  test("lays the graph out again after the data behind it changes", async ({
    page
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAsOwner(page);
    const sessionId = await seedRichGraph(page);
    await openMap(page, sessionId);
    await waitForMapReady(page);

    await expect(page.locator(".react-flow__node")).toHaveCount(4);

    // A second claim arrives: the map has to adopt it and lay it out.
    await postClaim(page, sessionId, "该产品在两地的复购率差异具有统计显著性。");
    await page.reload();
    await page.getByRole("tab", { name: "证据地图" }).click();
    await waitForMapReady(page);

    await expect(page.locator(".react-flow__node")).toHaveCount(5);
    await expect(
      page.getByText("该产品在两地的复购率差异具有统计显著性。")
    ).toBeVisible();
  });

  test("loads normally after a refresh, on both viewports", async ({
    page
  }, testInfo) => {
    await loginAsOwner(page);
    const sessionId = await seedRichGraph(page);
    await openMap(page, sessionId);
    await waitForMapReady(page);

    await page.reload();
    await page.getByRole("tab", { name: "证据地图" }).click();
    await waitForMapReady(page);

    const ids = await renderedNodeIds(page);
    expect(ids.length).toBe(4);
    const box = await canvas(page).boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(200);
    expect(box?.height ?? 0).toBeGreaterThan(200);
    for (const node of await page.locator(".react-flow__node").all()) {
      const rect = await node.boundingBox();
      expect(rect?.width ?? 0).toBeGreaterThan(0);
      expect(rect?.height ?? 0).toBeGreaterThan(0);
    }

    await capture(page, testInfo.project.name, "evidence-map-reload");
  });

  test("shows an empty state for a session with no material, and calls it ready", async ({
    page
  }) => {
    await loginAsOwner(page);
    const sessionId = await createResearch(page, "一个还没有任何材料的问题。");
    await openMap(page, sessionId);

    await expect(canvas(page)).toHaveAttribute("data-graph-loaded", "true", {
      timeout: 20_000
    });
    // Nothing to measure, so the layout state must not be left hanging.
    await expect(canvas(page)).toHaveAttribute("data-nodes-ready", "true", {
      timeout: 20_000
    });
    await expect(page.getByText(/尚无可视化材料/)).toBeVisible();
    await expect(page.locator(".react-flow__node")).toHaveCount(0);
  });

  test("says so plainly when the graph cannot be loaded", async ({ page }) => {
    await loginAsOwner(page);
    const sessionId = await seedRichGraph(page);
    await page.route(`**/api/sessions/*/evidence-map`, (route) =>
      route.abort()
    );
    await openMap(page, sessionId);

    // Next's route announcer also carries role="alert", so scope to the panel's
    // own message rather than matching every live region on the page.
    const alert = page
      .locator('[role="alert"]')
      .filter({ hasText: /核心 API|加载证据地图/ });
    await expect(alert).toBeVisible();
    await expect(alert).not.toBeEmpty();
    await expect(page.getByRole("button", { name: "重试" })).toBeVisible();
    // A failed load must not read as "loaded, just not laid out yet".
    await expect(canvas(page)).toHaveCount(0);
  });

  test("is laid out and readable when the tab is opened from another panel", async ({
    page
  }, testInfo) => {
    await loginAsOwner(page);
    const sessionId = await seedRichGraph(page);
    // Land on a different panel first, so the map mounts from a hidden tab
    // rather than being the first thing the page renders.
    await page.goto(`/research/${sessionId}`);
    await page.getByRole("tab", { name: "文件导入" }).click();
    await expect(page.getByTestId("file-import-panel")).toBeVisible();

    await page.getByRole("tab", { name: "证据地图" }).click();
    await waitForMapReady(page);

    await expect(page.locator(".react-flow__node")).toHaveCount(4);
    await capture(page, testInfo.project.name, "evidence-map-from-tab");
  });
});
