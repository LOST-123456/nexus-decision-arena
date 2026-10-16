import type { Metadata } from "next";
import { ActionLink } from "../components/ui/button";
import { FullPageNotice } from "../components/ui/notice";

export const metadata: Metadata = {
  title: "页面不存在 · Nexus Decision Arena"
};

/**
 * Without this file Next answers an unknown path with its own English 404
 * page, which drops the operator out of the product's language and design
 * system. This keeps 404 inside the same shell as everything else and points
 * at the two entrances that actually exist.
 *
 * The neutral tone is deliberate: a missing page is not a service failure, so
 * it must not borrow the danger styling.
 */
export default function NotFound() {
  return (
    <FullPageNotice
      testId="not-found"
      tone="neutral"
      role="alert"
      eyebrow="404 / NOT FOUND"
      title="页面不存在"
      reason="这个地址没有对应的页面，它可能已经改名或被删除了。"
      hint="请检查链接是否正确，或从下面的入口重新开始。"
      actions={
        <>
          <ActionLink href="/">返回首页</ActionLink>
          <ActionLink href="/research">研究与事实核查</ActionLink>
        </>
      }
    />
  );
}
