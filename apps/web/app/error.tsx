"use client";

import { useEffect } from "react";
import { ActionLink, Button } from "../components/ui/button";
import { FullPageNotice } from "../components/ui/notice";

/**
 * Route-level error boundary. Without it an uncaught render error falls back
 * to Next's own error screen, which says nothing an operator can act on. Here
 * the message, a retry and a way out are all present, and the digest is kept
 * so a report can be traced back to a server log line.
 */
export default function RouteError({
  error,
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Route error:", error);
  }, [error]);

  return (
    <FullPageNotice
      testId="route-error"
      role="alert"
      eyebrow="UNEXPECTED ERROR"
      title="页面出错了"
      reason={error.message || "渲染这个页面时发生了未预期的错误。"}
      hint={`可以先重试；如果反复出现，请把页面地址反馈给管理员${
        error.digest ? `（错误编号 ${error.digest}）` : ""
      }。`}
      actions={
        <>
          <Button onClick={reset}>重试</Button>
          <ActionLink href="/">返回首页</ActionLink>
        </>
      }
    />
  );
}
