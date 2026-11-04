import type { Metadata } from "next";
import { NotificationCenter } from "../../features/notifications/notification-center";

export const metadata: Metadata = {
  title: "消息 · Nexus Decision Arena"
};

export default function NotificationsPage() {
  return (
    <main id="main" tabIndex={-1} className="review-list-shell">
      <NotificationCenter />
    </main>
  );
}
