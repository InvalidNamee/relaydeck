import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";

const TOKEN = "integration-test-secret-32-characters";

async function startGateway(t) {
  const dataDirectory = await mkdtemp(join(tmpdir(), "relaydeck-gateway-"));
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      GATEWAY_TOKEN: TOKEN,
      GATEWAY_HOST: "127.0.0.1",
      GATEWAY_PORT: "0",
      CDP_HTTP_URL: "http://127.0.0.1:9",
      RELAYDECK_DATA_DIR: dataDirectory,
      AUTO_START_CHROME: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`gateway startup timeout: ${stderr}`)), 8_000);
    child.stdout.on("data", (chunk) => {
      const match = String(chunk).match(/127\.0\.0\.1:(\d+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve(Number(match[1]));
    });
    child.once("exit", (code) => reject(new Error(`gateway exited with ${code}: ${stderr}`)));
  });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
  });
  return { child, port };
}

function nextMessage(socket) {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => resolve(JSON.parse(String(data))));
    socket.once("error", reject);
  });
}

test("rejects a gateway token shorter than 32 characters", async () => {
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, GATEWAY_TOKEN: "too-short" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const [code] = await once(child, "exit");
  assert.equal(code, 1);
  assert.match(stderr, /至少包含 32 个字符/);
});

test("authenticates a v1 client and reports gateway health", async (t) => {
  const { port } = await startGateway(t);
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).protocol, 1);

  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  await once(socket, "open");
  socket.send(
    JSON.stringify({
      type: "hello",
      protocol: 1,
      token: TOKEN,
      name: "test-client",
      capabilities: ["binaryFrames"],
    }),
  );
  const ready = await nextMessage(socket);
  assert.equal(ready.type, "ready");
  assert.equal(ready.clientName, "test-client");
  assert.deepEqual(ready.capabilities, ["binaryFrames"]);
  socket.close();
});

test("rejects an invalid token", async (t) => {
  const { port } = await startGateway(t);
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  await once(socket, "open");
  socket.send(
    JSON.stringify({
      type: "hello",
      protocol: 1,
      token: "wrong-token-value",
      name: "intruder",
    }),
  );
  const [code] = await once(socket, "close");
  assert.equal(code, 4001);
});
