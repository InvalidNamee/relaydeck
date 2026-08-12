import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";

function candidates() {
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
  }
  if (process.platform === "win32") {
    const roots = [
      process.env.PROGRAMFILES,
      process.env["PROGRAMFILES(X86)"],
      process.env.LOCALAPPDATA,
    ].filter(Boolean);
    return roots.flatMap((root) => [
      `${root}\\Google\\Chrome\\Application\\chrome.exe`,
      `${root}\\Chromium\\Application\\chrome.exe`,
    ]);
  }
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
}

export class ChromeProcess {
  constructor(config) {
    this.config = config;
    this.child = null;
  }

  start() {
    if (this.child) return this.child;
    const executable = this.config.chromeBinary || candidates().find(existsSync);
    if (!executable) {
      throw new Error("找不到 Chrome，请通过 CHROME_BIN 指定可执行文件路径");
    }
    mkdirSync(this.config.chromeProfileDirectory, { recursive: true, mode: 0o700 });
    const child = spawn(
      executable,
      [
        `--user-data-dir=${this.config.chromeProfileDirectory}`,
        "--remote-debugging-address=127.0.0.1",
        `--remote-debugging-port=${this.config.cdpPort}`,
        "--no-first-run",
        "--no-default-browser-check",
        this.config.defaultUrl,
      ],
      { stdio: "inherit" },
    );
    child.once("exit", () => {
      if (this.child === child) this.child = null;
    });
    this.child = child;
    return child;
  }

  stop() {
    this.child?.kill("SIGTERM");
  }
}
