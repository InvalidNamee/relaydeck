import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

const [command, ...args] = process.argv.slice(2);

if (!command) {
  console.error("用法：node scripts/with-rust.mjs <command> [args...]");
  process.exit(2);
}

function cargoDirectory() {
  if (process.env.CARGO) return dirname(process.env.CARGO);
  try {
    const cargo = execFileSync("rustup", ["which", "cargo"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (cargo) return dirname(cargo);
  } catch {
    // Fall through to the regular PATH check below.
  }
  return "";
}

const pathEntries = [];
const rustCargoDirectory = cargoDirectory();
const userCargoDirectory = join(homedir(), ".cargo", "bin");
if (rustCargoDirectory) pathEntries.push(rustCargoDirectory);
if (existsSync(userCargoDirectory)) pathEntries.push(userCargoDirectory);
if (process.env.PATH) pathEntries.push(process.env.PATH);

const env = {
  ...process.env,
  PATH: pathEntries.filter(Boolean).join(delimiter),
};

const executable =
  process.platform === "win32" && ["tauri", "npm", "npx"].includes(command)
    ? `${command}.cmd`
    : command;
const child = spawn(executable, args, { env, stdio: "inherit" });

child.on("error", (error) => {
  console.error(`无法启动 ${command}：${error.message}`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
