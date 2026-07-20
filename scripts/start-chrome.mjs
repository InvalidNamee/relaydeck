import { existsSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const candidates =
  process.platform === "darwin"
    ? [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
      ]
    : [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
      ];

const executable = process.env.CHROME_BIN || candidates.find(existsSync);
if (!executable) {
  console.error("找不到 Chrome。请通过 CHROME_BIN 指定可执行文件路径。");
  process.exit(1);
}

const profile = resolve(process.env.CHROME_PROFILE_DIR || "data/chrome-profile");
mkdirSync(profile, { recursive: true, mode: 0o700 });

const child = spawn(
  executable,
  [
    `--user-data-dir=${profile}`,
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${process.env.CDP_PORT || "9222"}`,
    "--no-first-run",
    "--no-default-browser-check",
    process.env.DEFAULT_URL || "https://ac.nowcoder.com/",
  ],
  { stdio: "inherit" },
);

child.on("exit", (code) => process.exit(code ?? 0));
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
