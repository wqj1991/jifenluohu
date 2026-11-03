import readline from "node:readline";
import { open } from "../server/db.mjs";
import { ensureAuthTables, setPassword } from "../server/auth.mjs";

/**
 * 重置访问密码（不经过网页，服务器上直接跑）。
 * 用法：
 *   pnpm auth:reset -- --user me --password '新密码'
 *   pnpm auth:reset            # 交互式输入，不回显
 * 副作用：所有已登录会话立即失效。
 */

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};

const user = arg("user", "admin");
let password = arg("password");

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const onData = (ch) => {
      // 关闭回显：把用户输入重画成空
      readline.clearLine(process.stdout, 0);
      process.stdout.write(`\r${question}${"*".repeat(rl.line.length)}`);
    };
    process.stdin.on("data", onData);
    rl.question(question, (answer) => {
      process.stdin.off("data", onData);
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

if (!password) password = await ask("新密码（至少 8 位）：");
if (!password) {
  console.error("密码为空，已取消");
  process.exit(1);
}

const db = open();
ensureAuthTables(db);
try {
  setPassword(db, user, password);
  console.log(`已设置账号「${user}」的访问密码，旧会话全部失效。`);
} catch (e) {
  console.error(String(e.message || e));
  process.exitCode = 1;
} finally {
  db.close();
}
