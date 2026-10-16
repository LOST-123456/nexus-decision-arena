"use client";

import "./globals.css";
import { Button, HardActionLink } from "../components/ui/button";
import { FullPageNotice } from "../components/ui/notice";

/**
 * Last line of defence: this one catches a failure inside the root layout
 * itself, so it must render its own `<html>`/`<body>` and cannot rely on
 * `AppNav`. The theme is fixed to the product default because the bootstrap
 * script lives in the layout that just failed.
 *
 * Because there is no router context left, its links load a full document —
 * hence `HardActionLink` rather than `ActionLink`.
 */
export default function GlobalError({
  error,
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="zh-CN" data-theme="dark">
      <body>
        <FullPageNotice
          testId="global-error"
          role="alert"
          eyebrow="APPLICATION ERROR"
          title="应用无法启动"
          reason={error.message || "应用在加载基础界面时发生了错误。"}
          hint={`请重试；如果仍然失败，请把错误编号反馈给管理员${
            error.digest ? `（错误编号 ${error.digest}）` : ""
          }。`}
          actions={
            <>
              <Button onClick={reset}>重试</Button>
              <HardActionLink href="/">返回首页</HardActionLink>
            </>
          }
        />
      </body>
    </html>
  );
}
