import { describe, expect, it, vi } from "vitest";
import { ReportNotReadyError } from "@nexus/db";
import { newId, type FinalReport } from "@nexus/shared";
import { createApp } from "../../app";

function reportFixture(sessionId: string): FinalReport {
  const timestamp = new Date().toISOString();
  return {
    id: newId(),
    sessionId,
    projectName: "Live project",
    executiveSummary: "Summary",
    initialConclusion: "建议立项",
    postChallengeConclusion: "暂缓规模化扩张",
    humanAction: "Adopt the decisive challenge",
    finalConclusion: "有限立项",
    decisionExplanation: "Run a limited pilot.",
    requiredNextActions: ["Collect evidence"],
    decisiveChallengeIds: [newId()],
    evidenceIds: [newId()],
    humanDecisionId: newId(),
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function createTestApp(input: {
  sessionId: string;
  phase?: string;
  getBySessionId: ReturnType<typeof vi.fn>;
  generateAndPersist: ReturnType<typeof vi.fn>;
  /** 默认没有会话视图——报告接口在这种情况下只能返回报告本身。 */
  view?: { claims: unknown[]; evidence: unknown[] } | null;
}) {
  return createApp({
    sessions: {
      getById: vi.fn().mockResolvedValue({
        id: input.sessionId,
        phase: input.phase ?? "DECIDED"
      }),
      getView: vi.fn().mockResolvedValue(input.view ?? null)
    } as never,
    inspector: {} as never,
    events: {} as never,
    reports: {
      getBySessionId: input.getBySessionId,
      generateAndPersist: input.generateAndPersist
    } as never,
    runSession: {} as never
  });
}

const SESSION_ID = "00000000-0000-7000-8000-0000000007a1";

function evidenceFixture(
  verificationStatus: "verified" | "unverified" | "rejected"
) {
  return {
    id: newId(),
    sessionId: SESSION_ID,
    claimIds: [newId()],
    kind: "external_reference" as const,
    title: `材料（${verificationStatus}）`,
    content: "摘录正文",
    description: "说明",
    direction: "supports" as const,
    reliability: 0.6,
    verificationStatus,
    retrievedAt: "2026-10-01T00:00:00.000Z",
    createdBy: "human" as const
  };
}

/** The audit route needs a session view, a project and the material rows. */
function auditApp(
  evidence: ReturnType<typeof evidenceFixture>[] = [],
  view: { claims: unknown[]; evidence: unknown[] } = {
    claims: [],
    evidence: []
  }
) {
  const report = reportFixture(SESSION_ID);
  return createApp({
    sessions: {
      getById: vi.fn().mockResolvedValue({ id: SESSION_ID, phase: "DECIDED" }),
      getView: vi
        .fn()
        .mockResolvedValue({ id: SESSION_ID, phase: "DECIDED", ...view }),
      getProjectBySessionId: vi.fn().mockResolvedValue({ id: newId() })
    } as never,
    inspector: {} as never,
    events: { listAfter: vi.fn().mockResolvedValue([]) } as never,
    evidence: { listEvidence: vi.fn().mockResolvedValue(evidence) } as never,
    reports: {
      getBySessionId: vi.fn().mockResolvedValue(report),
      generateAndPersist: vi.fn()
    } as never,
    runSession: {} as never
  });
}

/**
 * 一条主张 + 一条挂在它上面的证据。覆盖率只认"已核实 + supports + 非
 * assumption"，所以测试要把这三件事分开摆，否则测不出边界。
 */
function coverageView(input: {
  evidenceStatus?: "verified" | "unverified" | "rejected";
  direction?: "supports" | "opposes" | "context";
  kind?: "external_reference" | "assumption";
  withEvidence?: boolean;
}) {
  const claimId = newId();
  const evidenceRow = {
    id: newId(),
    claimIds: [claimId],
    verificationStatus: input.evidenceStatus ?? "verified",
    direction: input.direction ?? "supports",
    kind: input.kind ?? "external_reference"
  };
  return {
    claims: [
      {
        id: claimId,
        evidenceIds: input.withEvidence === false ? [] : [evidenceRow.id]
      }
    ],
    evidence: input.withEvidence === false ? [] : [evidenceRow]
  };
}

describe("report route", () => {
  it("returns a persisted report without regenerating it", async () => {
    const sessionId = newId();
    const report = reportFixture(sessionId);
    const getBySessionId = vi.fn().mockResolvedValue(report);
    const generateAndPersist = vi.fn();
    const app = createTestApp({
      sessionId,
      getBySessionId,
      generateAndPersist
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/report`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(report);
    expect(generateAndPersist).not.toHaveBeenCalled();
  });

  it("generates and persists the report when it is absent", async () => {
    const sessionId = newId();
    const report = reportFixture(sessionId);
    const getBySessionId = vi.fn().mockResolvedValue(null);
    const generateAndPersist = vi.fn().mockResolvedValue(report);
    const app = createTestApp({
      sessionId,
      getBySessionId,
      generateAndPersist
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/report`
    });

    expect(response.statusCode).toBe(200);
    expect(generateAndPersist).toHaveBeenCalledWith(sessionId);
  });

  it("returns 409 until a human decision is recorded", async () => {
    const sessionId = newId();
    const app = createTestApp({
      sessionId,
      phase: "REASSESSING",
      getBySessionId: vi.fn().mockResolvedValue(null),
      generateAndPersist: vi
        .fn()
        .mockRejectedValue(new ReportNotReadyError())
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/report`
    });

    expect(response.statusCode).toBe(409);
  });

  it("exports the same document the page renders as Markdown", async () => {
    const sessionId = newId();
    const report = reportFixture(sessionId);
    const app = createTestApp({
      sessionId,
      getBySessionId: vi.fn().mockResolvedValue(report),
      generateAndPersist: vi.fn()
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/report?format=markdown`
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/markdown");
    // The conclusion chain is part of the document, so it is part of the file.
    expect(response.body).toContain(`- 最终结论：${report.finalConclusion}`);
    expect(response.body).toContain(`- 初始结论：${report.initialConclusion}`);
    expect(response.body).toContain("## 裁决依据");
    expect(response.body).toContain(`关联证据：1 项`);
  });

  it("names the download after the report, not after a constant", async () => {
    const sessionId = newId();
    const report = reportFixture(sessionId);
    const app = createTestApp({
      sessionId,
      getBySessionId: vi.fn().mockResolvedValue(report),
      generateAndPersist: vi.fn()
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/report?format=markdown&download=1`
    });

    const disposition = String(response.headers["content-disposition"]);
    expect(disposition).toContain("attachment");
    expect(decodeURIComponent(disposition)).toContain("Live-project-决策报告-");
  });

  it("still answers JSON when no format is asked for", async () => {
    const sessionId = newId();
    const report = reportFixture(sessionId);
    const app = createTestApp({
      sessionId,
      getBySessionId: vi.fn().mockResolvedValue(report),
      generateAndPersist: vi.fn()
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/report`
    });

    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toEqual(report);
  });
});

describe("audit route", () => {
  it("carries the evidence the decision was made on, labelled", async () => {
    // Before this the package held a verdict and an event log but not one row
    // of the material behind it.
    const response = await auditApp([
      evidenceFixture("verified"),
      evidenceFixture("unverified"),
      evidenceFixture("rejected")
    ]).inject({ method: "GET", url: `/api/sessions/${SESSION_ID}/audit` });

    expect(response.statusCode).toBe(200);
    const bundle = response.json<{
      materials: Array<{ verificationStatus: string; verificationLabel: string }>;
      delivery: { disclosure: { policy: string; scope: string } };
    }>();

    expect(bundle.materials).toHaveLength(3);
    expect(bundle.materials.map((item) => item.verificationLabel)).toEqual([
      "已核实",
      "待核实",
      "已驳回"
    ]);
    expect(bundle.delivery.disclosure.policy).toBe("retain-and-label");
    expect(bundle.delivery.disclosure.scope).toBe("all");
  });

  it("keeps unverified material by default and says so in the Markdown export", async () => {
    const response = await auditApp([
      evidenceFixture("verified"),
      evidenceFixture("unverified")
    ]).inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/audit?format=markdown`
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("# 审计包交付说明");
    expect(response.body).toContain("全部保留并标注");
    expect(response.body).toContain("材料条数：2（其中已核实 1 条）");
    expect(response.body).toContain("未包含：证据 0 条");
  });

  it("filters to verified material only when asked, and reports what it dropped", async () => {
    const response = await auditApp([
      evidenceFixture("verified"),
      evidenceFixture("unverified")
    ]).inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/audit?scope=verified`
    });

    const bundle = response.json<{
      materials: Array<{ verificationStatus: string }>;
      delivery: {
        disclosure: { scope: string; statement: string; withheld: { materials: number } };
      };
    }>();

    expect(bundle.materials).toHaveLength(1);
    expect(bundle.delivery.disclosure.scope).toBe("verified");
    expect(bundle.delivery.disclosure.withheld.materials).toBe(1);
    expect(bundle.delivery.disclosure.statement).toContain("1 条");
  });

  it("refuses an audit scope it does not implement", async () => {
    const response = await auditApp([]).inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/audit?scope=everything`
    });
    expect(response.statusCode).toBe(400);
  });
});

/**
 * 闸门：报告出门之前，先算清"这轮结论背后有多少已核实证据"。
 *
 * 这三个出口必须同源。曾经的做法是每个出口各自组装，结果页面写着"证据
 * 不足"、下载的 Markdown 里一个字都没有——读者拿到文件就再也看不到这个
 * 警告了。所以测试盯的不是"有没有这个字段"，而是"三个出口是不是同一个数"。
 */
describe("report route · 证据覆盖率闸门", () => {
  it("给主张挂了未核实材料时，报告头标为证据不足", async () => {
    const sessionId = newId();
    const app = createTestApp({
      sessionId,
      getBySessionId: vi.fn().mockResolvedValue(reportFixture(sessionId)),
      generateAndPersist: vi.fn(),
      view: coverageView({ evidenceStatus: "unverified" })
    });

    const body = (
      await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/report` })
    ).json<{ evidenceCoverage: { level: string; statement: string } }>();

    expect(body.evidenceCoverage.level).toBe("unverified");
    expect(body.evidenceCoverage.statement).toContain("1 条主张");
  });

  it("一条已核实的支撑证据就够把主张从'证据不足'里摘出来", async () => {
    const sessionId = newId();
    const app = createTestApp({
      sessionId,
      getBySessionId: vi.fn().mockResolvedValue(reportFixture(sessionId)),
      generateAndPersist: vi.fn(),
      view: coverageView({ evidenceStatus: "verified", direction: "supports" })
    });

    const body = (
      await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/report` })
    ).json<{ evidenceCoverage: { level: string; coverageRatio: number | null } }>();

    expect(body.evidenceCoverage.level).toBe("verified");
    expect(body.evidenceCoverage.coverageRatio).toBe(1);
  });

  it("把覆盖率写进 Markdown 导出，且排在执行摘要之前", async () => {
    const sessionId = newId();
    const app = createTestApp({
      sessionId,
      getBySessionId: vi.fn().mockResolvedValue(reportFixture(sessionId)),
      generateAndPersist: vi.fn(),
      view: coverageView({ evidenceStatus: "unverified" })
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/report?format=markdown`
    });

    expect(response.body).toContain("## 证据覆盖率");
    expect(response.body).toContain("证据不足");
    // 顺序也是口径的一部分：读者先看到"这份报告核过多少"，再读结论。
    expect(response.body.indexOf("## 证据覆盖率")).toBeLessThan(
      response.body.indexOf("## 执行摘要")
    );
  });

  it("没有会话视图时不编一个覆盖率出来", async () => {
    // 宁可没有这个字段，也不能默认"全部核实过"。
    const sessionId = newId();
    const report = reportFixture(sessionId);
    const app = createTestApp({
      sessionId,
      getBySessionId: vi.fn().mockResolvedValue(report),
      generateAndPersist: vi.fn(),
      view: null
    });

    const body = (
      await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/report` })
    ).json<Record<string, unknown>>();

    expect(body).toEqual(report);
    expect("evidenceCoverage" in body).toBe(false);
  });

  it("审计包里也有覆盖率，且写明它是跟着报告走的", async () => {
    const response = await auditApp(
      [evidenceFixture("unverified")],
      coverageView({ evidenceStatus: "unverified" })
    ).inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/audit?format=markdown`
    });

    expect(response.body).toContain("- 证据覆盖率：证据不足");
    // 只写"覆盖率 0%"没有意义，读者需要知道这份文件该怎么用。
    expect(response.body).toContain("不是已经核实的结果");
  });

  it("收窄交付口径不重算覆盖率", async () => {
    // 口径管的是"包里放多少材料"，不是"这轮结论核实过多少"。
    // 用收窄后的集合重算，会让一次 scope=verified 的导出看起来更可靠。
    const response = await auditApp(
      [evidenceFixture("verified"), evidenceFixture("unverified")],
      coverageView({ evidenceStatus: "verified", direction: "supports" })
    ).inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/audit?format=markdown&scope=verified`
    });

    expect(response.body).toContain("未包含：证据 1 条");
    expect(response.body).toContain("- 证据覆盖率：已核实");
  });
});
