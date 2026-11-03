import crypto from "node:crypto";

/**
 * 单人登录：一个账号（auth_user 只有 id=1 一行），密码 scrypt 加盐存库，
 * 会话 token 随机 32 字节、库里只存 sha256，cookie HttpOnly + SameSite=Lax。
 * 首次访问（表里没账号）走 /api/auth/setup 设密码，之后只能改不能无密码进入。
 */

const COOKIE = "luohu_sid";
const TTL_MS = 30 * 24 * 3600 * 1000;   // 会话 30 天
const TOUCH_MS = 6 * 3600 * 1000;       // 6 小时内不重复写 last_seen
const MAX_FAILS = 6;                    // 同一 IP 连错 6 次
const LOCK_MS = 5 * 60 * 1000;          // 锁 5 分钟
const MIN_PWD = 8;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function ensureAuthTables(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS auth_user (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  username TEXT NOT NULL,
  pwd_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  created_at TEXT NOT NULL,
  pwd_changed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_session (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  last_seen INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ua TEXT,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS auth_session_exp ON auth_session(expires_at);
`);
  const now = Date.now();
  db.prepare("DELETE FROM auth_session WHERE expires_at < ?").run(now);
}

function hashPwd(password, salt) {
  return crypto.scryptSync(password, salt, 64, SCRYPT).toString("hex");
}

function same(a, b) {
  const x = Buffer.from(String(a), "hex");
  const y = Buffer.from(String(b), "hex");
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** CLI / 脚本复用：写账号（不存在则建，存在则改） */
export function setPassword(db, username, password) {
  checkPassword(password);
  const salt = crypto.randomBytes(16).toString("hex");
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO auth_user(id, username, pwd_hash, salt, created_at, pwd_changed_at)
     VALUES(1, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       username = excluded.username,
       pwd_hash = excluded.pwd_hash,
       salt = excluded.salt,
       pwd_changed_at = excluded.pwd_changed_at`
  ).run(username.trim(), hashPwd(password, salt), salt, now, now);
  db.prepare("DELETE FROM auth_session").run();
}

function checkPassword(pwd) {
  if (typeof pwd !== "string" || pwd.length < MIN_PWD) throw new Error(`密码至少 ${MIN_PWD} 位`);
  if (pwd.length > 128) throw new Error("密码过长（≤128）");
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sha256(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function isSecure(req) {
  return req.protocol === "https" || String(req.headers["x-forwarded-proto"] || "").includes("https");
}

function cookieFor(token, secure, maxAgeSec) {
  const bits = [`${COOKIE}=${token}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeSec}`];
  if (secure) bits.push("Secure");
  return bits.join("; ");
}

export function registerAuth(app, db) {
  const fails = new Map(); // ip -> { n, until }

  const getUser = () => db.prepare("SELECT * FROM auth_user WHERE id = 1").get() || null;

  // 空库时建第一个账号：账号可用 LUOHU_USER 覆盖，密码只认 LUOHU_PASSWORD；
  // 没给就随机生成并打一次日志（仓库是公开的，不能把现役密码写死在源码里）
  if (!getUser()) {
    const u = String(process.env.LUOHU_USER || "admin").trim();
    const generated = !process.env.LUOHU_PASSWORD;
    const p = process.env.LUOHU_PASSWORD || crypto.randomBytes(9).toString("base64url");
    try {
      setPassword(db, u, p);
      if (generated) {
        console.warn(`[auth] 首次初始化账号 ${u}，随机密码：${p}  —— 请尽快 \`pnpm auth:reset\` 换掉`);
      }
    } catch { /* 密码不合规（<8 位）就留空库，走网页里的首次设置 */ }
  }

  function sessionOf(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return null;
    const row = db.prepare("SELECT * FROM auth_session WHERE token_hash = ?").get(sha256(token));
    if (!row) return null;
    const now = Date.now();
    if (row.expires_at < now) {
      db.prepare("DELETE FROM auth_session WHERE token_hash = ?").run(row.token_hash);
      return null;
    }
    if (now - row.last_seen > TOUCH_MS) {
      db.prepare("UPDATE auth_session SET last_seen = ? WHERE token_hash = ?").run(now, row.token_hash);
    }
    return { tokenHash: row.token_hash, user: getUser() };
  }

  function issue(req, reply, username) {
    const token = crypto.randomBytes(32).toString("base64url");
    const now = Date.now();
    db.prepare(
      "INSERT INTO auth_session(token_hash, user_id, created_at, last_seen, expires_at, ua, ip) VALUES(?,?,?,?,?,?,?)"
    ).run(sha256(token), 1, new Date(now).toISOString(), now, now + TTL_MS,
      String(req.headers["user-agent"] || "").slice(0, 200),
      String(req.ip || "").slice(0, 64));
    reply.header("set-cookie", cookieFor(token, isSecure(req), Math.floor(TTL_MS / 1000)));
    return username;
  }

  function tooMany(ip) {
    const f = fails.get(ip);
    if (!f) return 0;
    if (f.until && f.until > Date.now()) return Math.ceil((f.until - Date.now()) / 1000);
    if (f.until && f.until <= Date.now()) fails.delete(ip);
    return 0;
  }

  function bump(ip) {
    const f = fails.get(ip) || { n: 0, until: 0 };
    f.n += 1;
    if (f.n >= MAX_FAILS) { f.until = Date.now() + LOCK_MS; f.n = 0; }
    fails.set(ip, f);
  }

  /* ---------- 全局闸门：/api/* 除认证端点外都要登录 ---------- */
  app.addHook("onRequest", async (req, reply) => {
    const url = String(req.url || "/").split("?")[0];
    if (!url.startsWith("/api/")) return; // 静态资源放行：登录页本身得能加载

    const unsafe = !["GET", "HEAD", "OPTIONS"].includes(req.method);
    if (unsafe && req.headers.origin) {
      const hosts = [req.headers.host, req.headers["x-forwarded-host"]]
        .map((h) => String(h || "").split(",")[0].trim()).filter(Boolean);
      let ok = false;
      try { ok = hosts.includes(new URL(String(req.headers.origin)).host); } catch { ok = false; }
      if (!ok) return reply.code(403).send({ error: "跨站请求被拒绝" });
    }

    if (url.startsWith("/api/auth/")) return; // 认证端点各自校验

    const s = sessionOf(req);
    if (!s) return reply.code(401).send({ error: "unauthorized" });
    req.user = s.user;
  });

  app.get("/api/auth/me", async (req) => {
    const s = sessionOf(req);
    const user = getUser();
    return {
      authenticated: !!s,
      username: user ? user.username : null,
      setup: !user,
    };
  });

  app.post("/api/auth/setup", async (req, reply) => {
    if (getUser()) return reply.code(409).send({ ok: false, error: "已设置过账号" });
    const b = req.body || {};
    const username = String(b.username || "").trim() || "me";
    try {
      checkPassword(b.password);
      if (String(b.password) !== String(b.confirm ?? b.password)) {
        return reply.code(400).send({ ok: false, error: "两次输入的密码不一致" });
      }
      setPassword(db, username, String(b.password));
      issue(req, reply, username);
      return { ok: true, username };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: String(e.message || e) });
    }
  });

  app.post("/api/auth/login", async (req, reply) => {
    const ip = String(req.ip || "");
    const wait = tooMany(ip);
    if (wait) return reply.code(429).send({ ok: false, error: `尝试过于频繁，${wait} 秒后再试` });

    const user = getUser();
    if (!user) return reply.code(409).send({ ok: false, error: "还没有设置账号", setup: true });

    const b = req.body || {};
    const name = String(b.username || "").trim();
    const pwd = String(b.password || "");
    const okUser = name === user.username;
    const okPwd = pwd.length > 0 && same(hashPwd(pwd, user.salt), user.pwd_hash);

    if (!okUser || !okPwd) {
      bump(ip);
      return reply.code(401).send({ ok: false, error: "账号或密码不对" });
    }
    fails.delete(ip);
    issue(req, reply, user.username);
    return { ok: true, username: user.username };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) db.prepare("DELETE FROM auth_session WHERE token_hash = ?").run(sha256(token));
    reply.header("set-cookie", cookieFor("", isSecure(req), 0));
    return { ok: true };
  });

  app.post("/api/auth/password", async (req, reply) => {
    const s = sessionOf(req);
    if (!s) return reply.code(401).send({ ok: false, error: "unauthorized" });
    const user = getUser();
    const b = req.body || {};
    if (!same(hashPwd(String(b.current || ""), user.salt), user.pwd_hash)) {
      return reply.code(400).send({ ok: false, error: "当前密码不对" });
    }
    try {
      checkPassword(b.next);
      if (String(b.next) !== String(b.confirm ?? b.next)) {
        return reply.code(400).send({ ok: false, error: "两次输入的密码不一致" });
      }
      setPassword(db, user.username, String(b.next)); // 顺带清掉所有旧会话
      issue(req, reply, user.username);
      return { ok: true };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: String(e.message || e) });
    }
  });
}
