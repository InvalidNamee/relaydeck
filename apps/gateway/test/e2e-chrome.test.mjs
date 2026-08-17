import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { decodeBinaryFrame } from "@relaydeck/protocol";
import { WebSocket } from "ws";

const RUN_E2E = process.env.RELAYDECK_E2E === "1";
const TOKEN = "real-chrome-integration-secret-32-chars";

async function unusedPort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function messageQueue(socket) {
  const queued = [];
  const waiters = [];
  socket.on("message", (raw, isBinary) => {
    const value = isBinary
      ? { binary: true, value: decodeBinaryFrame(raw) }
      : { binary: false, value: JSON.parse(String(raw)) };
    const waiterIndex = waiters.findIndex((waiter) => waiter.predicate(value));
    if (waiterIndex >= 0) {
      const [waiter] = waiters.splice(waiterIndex, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(value);
    } else {
      queued.push(value);
    }
  });
  return {
    next(predicate, timeout = 20_000) {
      const queuedIndex = queued.findIndex(predicate);
      if (queuedIndex >= 0) return Promise.resolve(queued.splice(queuedIndex, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error("timed out waiting for gateway message"));
        }, timeout);
        waiters.push(waiter);
      });
    },
  };
}

test(
  "streams a real Chrome target as a binary jpeg frame",
  { skip: !RUN_E2E, timeout: 45_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "relaydeck-real-chrome-"));
    const cdpPort = await unusedPort();
    const child = spawn(process.execPath, ["src/server.mjs"], {
      cwd: new URL("..", import.meta.url),
      env: {
        ...process.env,
        GATEWAY_TOKEN: TOKEN,
        GATEWAY_HOST: "127.0.0.1",
        GATEWAY_PORT: "0",
        CDP_HTTP_URL: `http://127.0.0.1:${cdpPort}`,
        CDP_PORT: String(cdpPort),
        DEFAULT_URL: "about:blank",
        RELAYDECK_DATA_DIR: join(directory, "data"),
        CHROME_PROFILE_DIR: join(directory, "chrome-profile"),
        AUTO_START_CHROME: "1",
        CHROME_HEADLESS: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    t.after(async () => {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await once(child, "exit");
      }
    });

    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`gateway startup timeout: ${stderr}`)), 10_000);
      child.stdout.on("data", (chunk) => {
        const match = String(chunk).match(/127\.0\.0\.1:(\d+)/);
        if (!match) return;
        clearTimeout(timer);
        resolve(Number(match[1]));
      });
      child.once("exit", (code) => reject(new Error(`gateway exited with ${code}: ${stderr}`)));
    });

    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    t.after(() => socket.close());
    await once(socket, "open");
    const messages = messageQueue(socket);
    socket.send(
      JSON.stringify({
        type: "hello",
        protocol: 2,
        token: TOKEN,
        name: "real-chrome-test",
        capabilities: ["binaryFrames"],
      }),
    );
    await messages.next((message) => message.value.type === "ready");
    await messages.next(
      (message) => message.value.type === "chrome" && message.value.connected === true,
    );
    const state = await messages.next(
      (message) => message.value.type === "state" && message.value.targets.length > 0,
    );
    const targetId = state.value.targets[0].targetId;
    socket.send(JSON.stringify({ type: "claim", targetId }));
    socket.send(JSON.stringify({ type: "view", targetId }));
    const frameMessage = await messages.next(
      (message) => message.binary && message.value.targetId === targetId,
    );
    assert.equal(frameMessage.value.jpeg[0], 0xff);
    assert.equal(frameMessage.value.jpeg[1], 0xd8);
    assert.ok(frameMessage.value.jpeg.byteLength > 100);
  },
);
