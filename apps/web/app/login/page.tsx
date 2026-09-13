"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import {
  createUser,
  getCurrentUser,
  listUsers,
  login,
  type AuthUser
} from "../../features/arena/api-client";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [newUser, setNewUser] = useState({
    username: "",
    displayName: "",
    role: "reviewer" as AuthUser["role"],
    password: ""
  });

  useEffect(() => {
    getCurrentUser().then((user) => {
      setCurrentUser(user);
      if (user?.role === "owner") {
        listUsers().then(setUsers).catch(() => undefined);
      }
    });
  }, []);

  async function submitLogin(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    try {
      const user = await login(username, password);
      setCurrentUser(user);
      if (user.role === "owner") {
        setUsers(await listUsers());
      }
      router.push("/");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "登录失败");
    }
  }

  async function submitUser(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    try {
      const created = await createUser(newUser);
      setUsers((current) => [...current, created]);
      setNewUser({ username: "", displayName: "", role: "reviewer", password: "" });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "创建账户失败");
    }
  }

  return (
    <main className="auth-shell">
      <header className="auth-header">
        <Link className="brand-lockup brand-lockup-compact" href="/">
          <span className="brand-mark" aria-hidden="true">N</span>
          <span><strong>Nexus Decision Arena</strong><small>ACCOUNT & TEAM</small></span>
        </Link>
        <Link className="header-secondary-link" href="/">返回首页</Link>
      </header>
      <div className="auth-layout">
        <section className="auth-intro">
          <p className="eyebrow">TEAM ACCESS</p>
          <h1>账户与团队角色</h1>
          <p>Owner 可以管理成员；Reviewer 可以创建评审和人工裁决；Viewer 只能查看结果。</p>
          <div className="auth-demo-accounts">
            <strong>本演示默认账号</strong>
            <code>owner / nexus-owner</code>
            <code>viewer / nexus-viewer</code>
          </div>
        </section>
        <form className="auth-form" onSubmit={submitLogin}>
          <h2>{currentUser ? "切换账户" : "登录"}</h2>
          <label><span>用户名</span><input value={username} onChange={(e) => setUsername(e.target.value)} required /></label>
          <label><span>密码</span><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
          {error ? <div className="new-session-error"><p>{error}</p></div> : null}
          <button className="new-session-submit" type="submit">登录 <span aria-hidden="true">→</span></button>
          {currentUser ? <p className="small muted">当前登录：{currentUser.displayName} / {currentUser.role}</p> : null}
        </form>
      </div>
      {currentUser?.role === "owner" ? (
        <section className="team-management">
          <div><p className="eyebrow">TEAM MEMBERS</p><h2>团队成员</h2></div>
          <form onSubmit={submitUser}>
            <input placeholder="用户名" value={newUser.username} onChange={(e) => setNewUser({ ...newUser, username: e.target.value })} required />
            <input placeholder="显示名称" value={newUser.displayName} onChange={(e) => setNewUser({ ...newUser, displayName: e.target.value })} required />
            <select value={newUser.role} onChange={(e) => setNewUser({ ...newUser, role: e.target.value as AuthUser["role"] })}>
              <option value="owner">Owner</option><option value="reviewer">Reviewer</option><option value="viewer">Viewer</option>
            </select>
            <input type="password" placeholder="至少 8 位密码" value={newUser.password} onChange={(e) => setNewUser({ ...newUser, password: e.target.value })} required minLength={8} />
            <button type="submit">新增成员</button>
          </form>
          <ul>{users.map((user) => <li key={user.id}><span>{user.displayName}</span><small>{user.username} / {user.role}</small></li>)}</ul>
        </section>
      ) : null}
    </main>
  );
}
