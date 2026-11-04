import { describe, expect, it } from "vitest";
import {
  commentTargetTypeLabel,
  reviewRequestTypeLabel,
  REVIEW_REQUEST_TYPE_LABELS
} from "./collaboration";

/**
 * 词汇只能有一份。
 *
 * 审核表单的下拉框和消息中心生成的卡片说的是同一件事，如果两处各写一份，
 * 迟早会把 `report_review` 在一个地方叫「报告审核」、在另一个地方叫「报告评审」。
 * 读的人会以为这是两件事。
 */
describe("collaboration labels", () => {
  it("names every review request type in words a person reads", () => {
    expect(reviewRequestTypeLabel("claim_review")).toBe("主张审核");
    expect(reviewRequestTypeLabel("source_review")).toBe("来源审核");
    expect(reviewRequestTypeLabel("report_review")).toBe("报告审核");
    expect(reviewRequestTypeLabel("conflict_review")).toBe("冲突审核");
    // One map, so the list and the labels cannot drift apart.
    expect(Object.keys(REVIEW_REQUEST_TYPE_LABELS)).toHaveLength(4);
  });

  it("names every comment target in words a person reads", () => {
    expect(commentTargetTypeLabel("claim")).toBe("主张");
    expect(commentTargetTypeLabel("evidence")).toBe("证据");
    expect(commentTargetTypeLabel("report_snapshot")).toBe("报告快照");
    expect(commentTargetTypeLabel("revalidation_task")).toBe("复核任务");
  });

  it("shows the raw value when the database holds one nothing knows yet", () => {
    // These columns are `text`, not enums: a value the interface has not been
    // taught yet is possible, and a row that renders as nothing is worse than
    // a row that shows an unfamiliar word.
    expect(commentTargetTypeLabel("some_future_target")).toBe(
      "some_future_target"
    );
    expect(reviewRequestTypeLabel("some_future_review")).toBe(
      "some_future_review"
    );
  });
});
