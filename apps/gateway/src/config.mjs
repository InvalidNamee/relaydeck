import { resolve } from "node:path";

function integer(name, fallback, { minimum = 0, maximum = 65535 } = {}) {
  const raw = process.env[name];
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} 必须是 ${minimum}-${maximum} 之间的整数`);
  }
  return value;
}

function boolean(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (["1", "true", "yes"].includes(raw.toLowerCase())) return true;
  if (["0", "false", "no"].includes(raw.toLowerCase())) return false;
  throw new Error(`${name} 必须是 1/0 或 true/false`);
}

export function loadConfig() {
  const token = process.env.GATEWAY_TOKEN || "";
  if (token.length < 32) {
    throw new Error("GATEWAY_TOKEN 必须至少包含 32 个字符");
  }

  const dataDirectory = resolve(process.env.RELAYDECK_DATA_DIR || "data");
  return {
    host: process.env.GATEWAY_HOST || "0.0.0.0",
    port: integer("GATEWAY_PORT", 8788),
    token,
    cdpHttpUrl: (process.env.CDP_HTTP_URL || "http://127.0.0.1:9222").replace(/\/$/, ""),
    cdpPort: integer("CDP_PORT", 9222, { minimum: 1 }),
    defaultUrl: process.env.DEFAULT_URL || "https://ac.nowcoder.com/",
    dataDirectory,
    stateFile: resolve(dataDirectory, "workspace-state.json"),
    chromeProfileDirectory: resolve(
      process.env.CHROME_PROFILE_DIR || resolve(dataDirectory, "chrome-profile"),
    ),
    chromeBinary: process.env.CHROME_BIN || "",
    autoStartChrome: boolean("AUTO_START_CHROME", false),
    chromeHeadless: boolean("CHROME_HEADLESS", process.platform === "linux"),
    allowedOrigins: new Set(
      (process.env.GATEWAY_ALLOWED_ORIGINS || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  };
}
