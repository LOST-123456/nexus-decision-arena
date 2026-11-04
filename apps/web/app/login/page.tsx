"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import {
  createUser,
  getCurrentUser,
  listUsers,
  login,
  type AuthUser
} from "../../features/arena/api-client";

/**
 * 演示账号提示，口令值来自环境变量而不是源码。
 *
 * 这一段以前把口令直接印在登录页上。对一台放在公网的部署来说，那不是提示，
 * 是把钥匙挂在门上——而且部署方一旦换了口令，它说的还是旧值，照着输反而登不
 * 进去。现在只有显式配置了 NEXT_PUBLIC_DEMO_OWNER_PASSWORD 的那台机器才会渲染
 * 这一块，源码里不留任何口令字面量。
 */
const DEMO_OWNER_PASSWORD = process.env.NEXT_PUBLIC_DEMO_OWNER_PASSWORD ?? "";
const DEMO_VIEWER_PASSWORD = process.env.NEXT_PUBLIC_DEMO_VIEWER_PASSWORD ?? "";

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
    <main id="main" tabIndex={-1} className="auth-shell">
      <div className="auth-layout">
        <section className="auth-intro">
          <p className="eyebrow">TEAM ACCESS</p>
          <h1>账户与团队角色</h1>
          <p>Owner 可以管理成员；Reviewer 可以创建评审和人工裁决；Viewer 只能查看结果。</p>
          {DEMO_OWNER_PASSWORD ? (
            <div className="auth-demo-accounts">
              <strong>本机演示账号</strong>
              <code>owner / {DEMO_OWNER_PASSWORD}</code>
              {DEMO_VIEWER_PASSWORD ? (
                <code>viewer / {DEMO_VIEWER_PASSWORD}</code>
              ) : null}
              <p className="auth-demo-note">
                只在配置了 NEXT_PUBLIC_DEMO_OWNER_PASSWORD 的机器上出现；对公网
                开放的部署不显示账号信息。
              </p>
            </div>
          ) : null}
          <p className="auth-signup-note">
            没有账号？本系统不开放自助注册，请找团队里的 Owner 在「团队成员」
            里为你开通 Reviewer 或 Viewer 角色。
          </p>
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
