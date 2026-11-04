import { describe, expect, it } from "vitest";
import { isFocusTarget, workspaceFocusHref } from "./focus-link";

/**
 * The link vocabulary shared by the report (which writes the link) and the
 * workspace page (which reads the query string). If these two disagree, a
 * citation in a report links to a page that opens nothing — which is exactly
 * how the report citation block was a dead end before.
 */
describe("focus links", () => {
  it("carries the target and only that target's id", () => {
    expect(
      workspaceFocusHref("session-1", { kind: "evidence", evidenceId: "ev-1" })
    ).toBe("/research/session-1?focus=evidence&evidenceId=ev-1");
    expect(
      workspaceFocusHref("session-1", { kind: "claim", claimId: "claim-1" })
    ).toBe("/research/session-1?focus=claim&claimId=claim-1");
  });

  it("accepts exactly the two targets the page understands", () => {
    expect(isFocusTarget("claim")).toBe(true);
    expect(isFocusTarget("evidence")).toBe(true);
    expect(isFocusTarget("report")).toBe(false);
    expect(isFocusTarget(undefined)).toBe(false);
  });

  it("round-trips through the query string the page reads", () => {
    const href = workspaceFocusHref("s-1", {
      kind: "evidence",
      evidenceId: "ev-1"
    });
    const query = new URLSearchParams(href.split("?")[1]);

    expect(isFocusTarget(query.get("focus") ?? undefined)).toBe(true);
    expect(query.get("evidenceId")).toBe("ev-1");
    expect(query.get("claimId")).toBeNull();
  });
});
