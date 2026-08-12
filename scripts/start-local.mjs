import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

const token = process.env.GATEWAY_TOKEN || randomBytes(32).toString("base64url");
const children = [];

function start(command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
  });
  children.push(child);
  child.on("exit", (code) => {
    if (code && code !== 0) console.error(`${command} exited with code ${code}`);
  });
}

console.log("");
console.log("Relaydeck 本地控制台");
console.log("  UI:      http://127.0.0.1:1420");
console.log(
  `  Gateway: ws://${process.env.GATEWAY_HOST || "0.0.0.0"}:${process.env.GATEWAY_PORT || "8788"}`,
);
console.log(`  Token:   ${token}`);
console.log("");

start("npm", ["run", "dev:client"]);
start(process.execPath, ["apps/gateway/src/server.mjs"], { GATEWAY_TOKEN: token });
if (process.env.AUTO_START_CHROME !== "1") {
  console.log("如需网关自动管理 Chrome，请设置 AUTO_START_CHROME=1。");
}

function shutdown(signal) {
  for (const child of children) child.kill(signal);
  setTimeout(() => process.exit(0), 300).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
