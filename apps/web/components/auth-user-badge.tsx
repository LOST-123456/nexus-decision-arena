"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  getCurrentUser,
  logout,
  type AuthUser
} from "../features/arena/api-client";

export function AuthUserBadge() {
  const [user, setUser] = useState<AuthUser | null | undefined>(undefined);

  async function refresh(): Promise<void> {
    setUser(await getCurrentUser().catch(() => null));
  }

  useEffect(() => {
    void refresh();
  }, []);

  if (user === undefined) {
    return <span className="auth-user-badge">AUTH...</span>;
  }

  if (!user) {
    return (
      <Link className="auth-user-badge" href="/login">
        登录 / 团队
      </Link>
    );
  }

  return (
    <div className="auth-user-badge auth-user-active">
      <span>{user.displayName}</span>
      <small>{user.role.toUpperCase()}</small>
      <button
        type="button"
        onClick={async () => {
          await logout();
          setUser(null);
        }}
      >
        退出
      </button>
    </div>
  );
}
