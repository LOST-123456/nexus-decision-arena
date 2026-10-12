import { describe, expect, it } from "vitest";
import {
  newId,
  type Claim,
  type ClaimVerdict,
  type Evidence,
  type EvidenceImpact,
  type RevalidationTask,
  type Source,
  type SourceSnapshot
} from "@nexus/shared";
import { diffSnapshots } from "./snapshot-diff";
import { deriveEvidenceImpacts } from "./evidence-impact";
import { deriveClaimImpacts } from "./claim-impact";
import { deriveRevalidationWarnings } from "./revalidation-warnings";

/**
 * The monitoring derivations, as pure functions.
 *
 * The boundary under test: a change is *detected and described*, never
 * *decided*. The diff keeps both versions, the impact derivation reads
 * verification status without touching it, the claim projection asks for a
 * re-check without rewriting a verdict, and the report warnings say "material
 * moved" without saying "the conclusion is wrong".
 */

const SESSION_ID = newId();
const SOURCE_ID = newId();

function snapshot(input: {
  id?: string;
  content: string;
  hash: string;
  title?: string | null;
  retrievedAt?: string;
}): SourceSnapshot {
  return {
    id: input.id ?? newId(),
    sessionId: SESSION_ID,
    sourceId: SOURCE_ID,
    canonicalUrl: "https://example.test/page",
    contentHash: input.hash,
    contentType: "text/plain",
    content: input.content,
    contentBytes: input.content.length,
    charCount: input.content.length,
    retrievedAt: input.retrievedAt ?? "2026-10-01T00:00:00.000Z",
    createdAt: "2026-10-01T00:00:00.000Z",
    // `title` is optional on the record: absent, never null.
    ...(input.title == null ? {} : { title: input.title })
  };
}

function excerpt(overrides: Partial<Evidence> = {}): Evidence {
  return {
    id: newId(),
    sessionId: SESSION_ID,
    claimIds: [newId()],
    kind: "external_reference",
    title: "摘录一",
    content: "出口连续三个季度下滑。",
    description: "工作台摘录",
    sourceId: SOURCE_ID,
    direction: "supports",
    reliability: 0.8,
    verificationStatus: "verified",
    verifiedBy: "复核员 (reviewer)",
    verificationNote: "与原文一致",
    retrievedAt: "2026-10-01T00:00:00.000Z",
    createdBy: "human",
    ...overrides
  };
}

const OLD_TEXT = [
  "国家统计局发布上半年经济数据。",
  "出口连续三个季度下滑，制造业投资增速回落至 4.2%。",
  "分析人士认为外部需求仍然疲软。"
].join("\n");

const NEW_TEXT = [
  "国家统计局发布上半年经济数据（修订版）。",
  "出口连续三个季度下滑，制造业投资增速回升至 5.6%。",
  "分析人士认为外部需求仍然疲软。"
].join("\n");

describe("diffSnapshots", () => {
  it("reports nothing moved when the two captures are identical", () => {
    const previous = snapshot({ content: OLD_TEXT, hash: "a".repeat(64) });
    const current = snapshot({ content: OLD_TEXT, hash: "a".repeat(64) });
    const diff = diffSnapshots({
      sessionId: SESSION_ID,
      sourceId: SOURCE_ID,
      previous,
      current
    });
    expect(diff.segments).toEqual([
      { kind: "same", text: OLD_TEXT }
    ]);
    expect(diff.addedChars).toBe(0);
    expect(diff.removedChars).toBe(0);
    expect(diff.highlights).toEqual([]);
    expect(diff.titleChanged).toBe(false);
  });

  it("keeps both versions and names what moved, with advisory highlights", () => {
    const previous = snapshot({
      content: OLD_TEXT,
      hash: "a".repeat(64),
      title: "旧标题"
    });
    const current = snapshot({
      content: NEW_TEXT,
      hash: "b".repeat(64),
      title: "新标题"
    });
    const diff = diffSnapshots({
      sessionId: SESSION_ID,
      sourceId: SOURCE_ID,
      previous,
      current
    });

    // The old capture is not modified and stays addressable by its own id.
    expect(diff.previousSnapshotId).toBe(previous.id);
    expect(diff.currentSnapshotId).toBe(current.id);
    expect(diff.previousContentHash).toBe("a".repeat(64));
    expect(diff.currentContentHash).toBe("b".repeat(64));
    expect(diff.titleChanged).toBe(true);
    expect(diff.previousTitle).toBe("旧标题");
    expect(diff.currentTitle).toBe("新标题");

    const added = diff.segments.filter((s) => s.kind === "added");
    const removed = diff.segments.filter((s) => s.kind === "removed");
    expect(added).toHaveLength(1);
    expect(removed).toHaveLength(1);
    expect(added[0]?.text).toContain("5.6%");
    expect(removed[0]?.text).toContain("4.2%");
    expect(diff.addedChars).toBeGreaterThan(0);
    expect(diff.removedChars).toBeGreaterThan(0);

    // The moved numbers are flagged as advisory, never as a finding.
    expect(diff.highlights.map((h) => h.kind)).toContain("number");
    expect(diff.highlights.some((h) => h.text.includes("5.6"))).toBe(true);
    expect(diff.highlights.some((h) => h.text.includes("4.2"))).toBe(true);
  });

  it("names the excerpts that vanished from the newer version", () => {
    const previous = snapshot({ content: OLD_TEXT, hash: "a".repeat(64) });
    const vanished = excerpt({ anchorText: "分析人士认为外部需求仍然疲软。" });
    const stillThere = excerpt({ anchorText: "出口连续三个季度下滑" });
    const current = snapshot({
      content: [
        "国家统计局发布上半年经济数据（修订版）。",
        "出口连续三个季度下滑，制造业投资增速回升至 5.6%。"
      ].join("\n"),
      hash: "b".repeat(64)
    });
    const diff = diffSnapshots({
      sessionId: SESSION_ID,
      sourceId: SOURCE_ID,
      previous,
      current,
      excerpts: [vanished, stillThere]
    });
    expect(diff.missingExcerpts).toHaveLength(1);
    expect(diff.missingExcerpts[0]?.evidenceId).toBe(vanished.id);
    expect(diff.missingExcerpts[0]?.anchorText).toBe(
      "分析人士认为外部需求仍然疲软。"
    );
  });

  it("says so instead of inventing a version when there is only one capture", () => {
    const only = snapshot({ content: OLD_TEXT, hash: "a".repeat(64) });
    const diff = diffSnapshots({
      sessionId: SESSION_ID,
      sourceId: SOURCE_ID,
      previous: null,
      current: only
    });
    expect(diff.segments).toEqual([]);
    expect(diff.previousSnapshotId).toBeNull();
    expect(diff.currentSnapshotId).toBe(only.id);
  });

  it("collapses long unchanged runs rather than echoing the whole page", () => {
    const filler = "这是一段没有发生任何变化的文字。".repeat(60);
    const previous = snapshot({
      content: `${filler}\n旧结论：增速 4.2%。`,
      hash: "a".repeat(64)
    });
    const current = snapshot({
      content: `${filler}\n新结论：增速 5.6%。`,
      hash: "b".repeat(64)
    });
    const diff = diffSnapshots({
      sessionId: SESSION_ID,
      sourceId: SOURCE_ID,
      previous,
      current
    });
    const same = diff.segments.filter((segment) => segment.kind === "same");
    expect(same).toHaveLength(1);
    expect(same[0]!.text.length).toBeLessThan(filler.length);
    expect(same[0]!.text).toContain("未变化");
  });
});

describe("deriveEvidenceImpacts", () => {
  const previous = snapshot({ content: OLD_TEXT, hash: "a".repeat(64) });
  const current = snapshot({ content: NEW_TEXT, hash: "b".repeat(64) });

  it("marks an excerpt whose surroundings changed but quote survived", () => {
    // Same position (the prefix is byte-identical), rewritten context after it.
    const oldText = "导语不变。出口连续三个季度下滑，旧上下文：增速 4.2%。";
    const newText = "导语不变。出口连续三个季度下滑，新上下文：增速 5.6%。";
    const item = excerpt({
      anchorText: "出口连续三个季度下滑",
      locatorStatus: "anchored",
      sourceContentHash: "a".repeat(64)
    });
    const [impact] = deriveEvidenceImpacts({
      excerpts: [item],
      previous: snapshot({ content: oldText, hash: "a".repeat(64) }),
      current: snapshot({ content: newText, hash: "b".repeat(64) })
    });
    expect(impact?.impact).toBe("content_changed");
    // The historical decision is carried through untouched.
    expect(impact?.verificationStatus).toBe("verified");
    expect(impact?.locatorStatus).toBe("anchored");
  });

  it("marks an excerpt that is no longer in the newer version", () => {
    const item = excerpt({
      anchorText: "分析人士认为外部需求仍然疲软。",
      locatorStatus: "anchored"
    });
    const withoutLine = [
      "国家统计局发布上半年经济数据（修订版）。",
      "出口连续三个季度下滑，制造业投资增速回升至 5.6%。"
    ].join("\n");
    const [impact] = deriveEvidenceImpacts({
      excerpts: [item],
      previous,
      current: snapshot({ content: withoutLine, hash: "b".repeat(64) })
    });
    expect(impact?.impact).toBe("anchor_missing");
    expect(impact?.reason).toContain("已找不到");
  });

  it("marks an excerpt that moved position without changing a word", () => {
    const movedText = ["导语。", OLD_TEXT].join("\n");
    const item = excerpt({
      anchorText: "出口连续三个季度下滑",
      locatorStatus: "anchored"
    });
    const [impact] = deriveEvidenceImpacts({
      excerpts: [item],
      previous: snapshot({ content: OLD_TEXT, hash: "a".repeat(64) }),
      current: snapshot({ content: movedText, hash: "b".repeat(64) })
    });
    expect(impact?.impact).toBe("anchor_moved");
    expect(impact?.reason).toContain("位置发生变化");
  });

  it("marks an excerpt the change never reached as unaffected", () => {
    // The edit happens more than a context window away from the quote, and
    // the quote's own position is unchanged.
    const anchor = "出口连续三个季度下滑，已核实。";
    const oldText = `旧导语：${"x".repeat(200)}\n${anchor}\n结尾不变。`;
    const newText = `新导语：${"x".repeat(200)}\n${anchor}\n结尾不变。`;
    const item = excerpt({
      anchorText: anchor,
      locatorStatus: "anchored",
      sourceContentHash: "a".repeat(64)
    });
    const [impact] = deriveEvidenceImpacts({
      excerpts: [item],
      previous: snapshot({ content: oldText, hash: "a".repeat(64) }),
      current: snapshot({ content: newText, hash: "b".repeat(64) })
    });
    expect(impact?.impact).toBe("unaffected");
    expect(impact?.reason).toContain("原样存在");
  });

  it("says needs_review when nothing could be established", () => {
    const noAnchor = excerpt({ anchorText: undefined });
    const noCapture = excerpt({ anchorText: "出口连续三个季度下滑" });
    const [first, second] = deriveEvidenceImpacts({
      excerpts: [noAnchor, noCapture],
      previous,
      current: null
    });
    expect(first?.impact).toBe("needs_review");
    expect(first?.reason).toContain("没有锚定文本");
    expect(second?.impact).toBe("needs_review");
    expect(second?.reason).toContain("没有已保存的正文版本");
  });
});

describe("deriveClaimImpacts", () => {
  const claim: Claim = {
    id: newId(),
    sessionId: SESSION_ID,
    lens: "research",
    statement: "出口连续三个季度下滑。",
    type: "fact",
    stance: "support",
    importance: 3,
    confidence: 0.5,
    evidenceIds: [],
    status: "proposed",
    rootClaimId: newId(),
    revision: 1,
    relations: [],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z"
  };
  const verdict: ClaimVerdict = {
    claimId: claim.id,
    status: "supported",
    confidence: 0.8,
    rationale: "已核实支持证据",
    counts: {
      total: 1,
      verified: 1,
      unverified: 0,
      rejected: 0,
      expired: 0,
      notYetEffective: 0,
      verifiedSupporting: 1,
      verifiedOpposing: 0,
      verifiedContext: 0
    },
    needsWork: false,
    basis: {
      supportingEvidenceIds: [],
      opposingEvidenceIds: [],
      contextEvidenceIds: []
    },
    excluded: [],
    ruleHits: [],
    confidenceBasis: [],
    openQuestions: [],
    limits: [],
    crossReview: {
      challenges: 0,
      unresolved: 0,
      severeUnresolved: 0,
      unresolvedChallengeIds: [],
      severeUnresolvedChallengeIds: [],
      lastReviewedAt: null
    },
    review: null,
    effectiveStatus: "supported"
  };

  function impactFor(
    evidence: Evidence,
    impact: EvidenceImpact["impact"]
  ): EvidenceImpact {
    return {
      evidenceId: evidence.id,
      title: evidence.title,
      impact,
      reason: "测试",
      locator: null,
      locatorStatus: "anchored",
      verificationStatus: "verified",
      direction: "supports"
    };
  }

  it("asks for a re-check without rewriting the verdict", () => {
    const moved = excerpt({ claimIds: [claim.id] });
    const untouched = excerpt({ claimIds: [claim.id] });
    const impacts = deriveClaimImpacts({
      claims: [claim],
      evidence: [moved, untouched],
      impacts: [
        impactFor(moved, "anchor_missing"),
        impactFor(untouched, "unaffected")
      ],
      verdicts: [verdict]
    });
    expect(impacts).toHaveLength(1);
    expect(impacts[0]?.claimId).toBe(claim.id);
    expect(impacts[0]?.verdictStatus).toBe("supported");
    expect(impacts[0]?.affectedEvidenceIds).toEqual([moved.id]);
    expect(impacts[0]?.reason).toContain("建议重新核查");
  });

  it("lists a claim with only untouched material as unaffected work", () => {
    const untouched = excerpt({ claimIds: [claim.id] });
    const impacts = deriveClaimImpacts({
      claims: [claim],
      evidence: [untouched],
      impacts: [impactFor(untouched, "unaffected")],
      verdicts: [verdict]
    });
    expect(impacts).toEqual([]);
  });
});

describe("deriveRevalidationWarnings", () => {
  const source: Source = {
    id: SOURCE_ID,
    sessionId: SESSION_ID,
    title: "季度回顾",
    kind: "url",
    url: "https://example.test/page",
    createdBy: "human",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z"
  };
  const item = excerpt({ sourceId: SOURCE_ID });
  const claim: Claim = {
    id: newId(),
    sessionId: SESSION_ID,
    lens: "research",
    statement: "出口连续三个季度下滑。",
    type: "fact",
    stance: "support",
    importance: 3,
    confidence: 0.5,
    evidenceIds: [],
    status: "proposed",
    rootClaimId: newId(),
    revision: 1,
    relations: [],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z"
  };
  const openTask: RevalidationTask = {
    id: newId(),
    sessionId: SESSION_ID,
    sourceId: SOURCE_ID,
    sourceTitle: "季度回顾",
    triggerContentHash: "b".repeat(64),
    previousSnapshotId: null,
    currentSnapshotId: newId(),
    affectedEvidenceIds: [item.id],
    affectedClaimIds: [claim.id],
    reason: "来源内容发生变化",
    status: "open",
    createdAt: "2026-10-02T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z",
    resolvedAt: null,
    resolvedBy: null,
    resolutionNote: null
  };

  it("reports the open work and the version the material is at", () => {
    const warnings = deriveRevalidationWarnings({
      tasks: [openTask],
      claims: [claim],
      evidence: [item],
      sources: [source],
      latestSnapshots: [
        snapshot({ content: NEW_TEXT, hash: "b".repeat(64) })
      ]
    });
    expect(warnings.openTaskCount).toBe(1);
    expect(warnings.inReviewTaskCount).toBe(0);
    expect(warnings.changedSources).toHaveLength(1);
    expect(warnings.changedSources[0]?.title).toBe("季度回顾");
    expect(warnings.evidenceNeedingReconfirmation).toHaveLength(1);
    expect(warnings.evidenceNeedingReconfirmation[0]?.title).toBe(item.title);
    expect(warnings.affectedClaims[0]?.statement).toBe(claim.statement);
    expect(warnings.lastCheckedAt).toBe(openTask.updatedAt);
    expect(warnings.sourceVersions[0]?.contentHash).toBe("b".repeat(64));
  });

  it("stays empty when nothing is open", () => {
    const warnings = deriveRevalidationWarnings({
      tasks: [],
      claims: [claim],
      evidence: [item],
      sources: [source],
      latestSnapshots: []
    });
    expect(warnings.openTaskCount).toBe(0);
    expect(warnings.changedSources).toEqual([]);
    expect(warnings.evidenceNeedingReconfirmation).toEqual([]);
    expect(warnings.sourceVersions[0]?.contentHash).toBeNull();
  });
});
