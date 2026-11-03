import { useState } from "react";
import { login, setupAccount, type AuthResult } from "../lib/auth";

const Field = ({
  label, value, onChange, type = "text", autoComplete, hint, autoFocus,
}: {
  label: string; value: string; onChange: (v: string) => void;
  type?: string; autoComplete?: string; hint?: string; autoFocus?: boolean;
}) => (
  <label className="block mt-5">
    <span className="sans text-[10px] tracking-[.22em]" style={{ color: "var(--color-mute)" }}>{label}</span>
    <input
      className="w-full mt-1 text-[15px]"
      type={type}
      value={value}
      autoFocus={autoFocus}
      autoComplete={autoComplete}
      onChange={(e) => onChange(e.target.value)}
    />
    {hint ? (
      <span className="sans text-[10px] mt-1 block leading-[1.6]" style={{ color: "var(--color-mute)" }}>{hint}</span>
    ) : null}
  </label>
);

export default function Login({
  setup, onAuthed,
}: {
  setup: boolean;
  onAuthed: (m: { username: string }) => void;
}) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const r: AuthResult = setup
        ? await setupAccount(username, password, confirm)
        : await login(username, password);
      if (r.ok) {
        onAuthed({ username: r.username || username });
      } else {
        setMsg(r.error || "登录失败");
        if (r.setup) location.reload();
      }
    } catch (err) {
      setMsg(`接口未启动：${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col justify-center px-6 py-16">
      <div className="w-full max-w-[372px] mx-auto">
        <div className="flex items-center gap-3">
          <span className="spine-mark" aria-hidden>京</span>
          <div className="min-w-0">
            <div className="spine-title">积分落户</div>
            <div className="sans text-[10px] tracking-[.22em] mt-1" style={{ color: "var(--color-mute)" }}>
              核算台 · 单人自用
            </div>
          </div>
        </div>

        <div className="rule-red mt-5" />
        <div className="rule-red-thin mt-1" />

        <div className="sans text-[11px] tracking-[.2em] mt-7" style={{ color: "var(--color-seal)" }}>
          {setup ? "首次启用 · 设置访问密码" : "访问校验"}
        </div>
        <p className="text-[12.5px] leading-[1.9] mt-2" style={{ color: "var(--color-ink-2)" }}>
          {setup
            ? "这份档案只给一个人看。先设一个密码，之后每次打开都要过这道门；密码只存加盐摘要，忘了用 pnpm auth:reset 重设。"
            : "档案里有申报人信息与选房进度，输密码才能进来。"}
        </p>

        <form onSubmit={submit} className="mt-1">
          <Field
            label="账号"
            value={username}
            onChange={setUsername}
            autoComplete="username"
            hint={setup ? "之后登录用这个账号，默认 admin" : undefined}
          />
          <Field
            label="密码"
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete={setup ? "new-password" : "current-password"}
            hint={setup ? "至少 8 位" : undefined}
            autoFocus={!setup}
          />
          {setup ? (
            <Field
              label="再输一遍"
              type="password"
              value={confirm}
              onChange={setConfirm}
              autoComplete="new-password"
            />
          ) : null}

          {msg ? (
            <div className="sans text-[11.5px] mt-5 leading-[1.7]" style={{ color: "var(--color-seal)" }}>{msg}</div>
          ) : null}

          <button type="submit" className="spine-stamp mt-7" disabled={busy}>
            {busy ? "校验中…" : setup ? "设 置 并 进 入" : "进 入"}
          </button>
        </form>

        <div className="sans text-[10px] leading-[1.9] mt-8" style={{ color: "var(--color-mute)" }}>
          会话 30 天 · HttpOnly Cookie · 连续输错 6 次锁 5 分钟
        </div>
      </div>
    </div>
  );
}
