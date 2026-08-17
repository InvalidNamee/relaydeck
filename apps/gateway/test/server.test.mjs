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

function messageQueue(socket) {
  const queued = [];
  const waiters = [];
  socket.on("message", (data) => {
    const value = JSON.parse(String(data));
    const waiter = waiters.shift();
    if (waiter) waiter(value);
    else queued.push(value);
  });
  return {
    next() {
      if (queued.length) return Promise.resolve(queued.shift());
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

async function nextOfType(queue, type) {
  while (true) {
    const message = await queue.next();
    if (message.type === type) return message;
  }
}

async function connectClient(port, name) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  await once(socket, "open");
  const messages = messageQueue(socket);
  socket.send(JSON.stringify({ type: "hello", protocol: 2, token: TOKEN, name }));
  const ready = await nextOfType(messages, "ready");
  await nextOfType(messages, "chrome");
  const state = await nextOfType(messages, "state");
  return { socket, messages, ready, state };
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

test("authenticates a v2 client and reports gateway health", async (t) => {
  const { port } = await startGateway(t);
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).protocol, 2);

  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  await once(socket, "open");
  socket.send(
    JSON.stringify({
      type: "hello",
      protocol: 2,
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

test("broadcasts workspace groups while Chrome is unavailable", async (t) => {
  const { port } = await startGateway(t);
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  await once(socket, "open");
  const messages = messageQueue(socket);
  socket.send(
    JSON.stringify({
      type: "hello",
      protocol: 2,
      token: TOKEN,
      name: "group-client",
    }),
  );

  assert.equal((await messages.next()).type, "ready");
  const chrome = await messages.next();
  assert.equal(chrome.type, "chrome");
  assert.equal(chrome.connected, false);
  assert.equal(typeof chrome.message, "string");
  const initialState = await messages.next();
  assert.equal(initialState.type, "state");
  assert.deepEqual(initialState.targets, []);
  assert.deepEqual(initialState.groups.map((group) => group.id), ["default"]);

  socket.send(JSON.stringify({ type: "group:create", name: "资料" }));
  const created = await messages.next();
  assert.equal(created.type, "group:created");
  const createdState = await messages.next();
  assert.equal(createdState.type, "state");
  assert.deepEqual(createdState.targets, []);
  assert.deepEqual(
    createdState.groups.map((group) => group.name),
    ["默认工作区", "资料"],
  );

  socket.send(JSON.stringify({ type: "group:delete", groupId: created.groupId }));
  const deletedState = await messages.next();
  assert.equal(deletedState.type, "state");
  assert.deepEqual(deletedState.groups.map((group) => group.id), ["default"]);
  socket.close();
});

test("rejects an invalid token", async (t) => {
  const { port } = await startGateway(t);
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  await once(socket, "open");
  socket.send(
    JSON.stringify({
      type: "hello",
      protocol: 2,
      token: "wrong-token-value",
      name: "intruder",
    }),
  );
  const [code] = await once(socket, "close");
  assert.equal(code, 4001);
});

test("lists online clients and requires owner approval before transferring a group", async (t) => {
  const { port } = await startGateway(t);
  const owner = await connectClient(port, "owner-device");
  assert.deepEqual(owner.state.clients.map((client) => client.clientName), ["owner-device"]);

  owner.socket.send(JSON.stringify({ type: "group:create", name: "协作分组" }));
  const created = await nextOfType(owner.messages, "group:created");
  await nextOfType(owner.messages, "state");

  const requester = await connectClient(port, "requester-device");
  assert.deepEqual(
    requester.state.clients.map((client) => client.clientName).sort(),
    ["owner-device", "requester-device"],
  );
  requester.socket.send(JSON.stringify({ type: "create", groupId: created.groupId }));
  const createRejected = await nextOfType(requester.messages, "error");
  assert.match(createRejected.message, /只读|控制权/);
  requester.socket.send(JSON.stringify({ type: "claim", groupId: created.groupId }));

  const pending = await nextOfType(requester.messages, "claim:pending");
  assert.equal(pending.ownerName, "owner-device");
  const requested = await nextOfType(owner.messages, "claim:requested");
  assert.equal(requested.request.requesterName, "requester-device");
  owner.socket.send(JSON.stringify({
    type: "claim:respond",
    requestId: requested.request.requestId,
    approved: true,
  }));

  const resolved = await nextOfType(requester.messages, "claim:resolved");
  assert.equal(resolved.approved, true);
  const transferred = await nextOfType(requester.messages, "state");
  assert.equal(
    transferred.groups.find((group) => group.id === created.groupId).ownerId,
    requester.ready.clientId,
  );
  owner.socket.close();
  requester.socket.close();
});

test("grants the oldest pending request when the current owner disconnects", async (t) => {
  const { port } = await startGateway(t);
  const owner = await connectClient(port, "owner-device");
  owner.socket.send(JSON.stringify({ type: "group:create", name: "待移交分组" }));
  const created = await nextOfType(owner.messages, "group:created");
  await nextOfType(owner.messages, "state");
  const requester = await connectClient(port, "waiting-device");
  requester.socket.send(JSON.stringify({ type: "claim", groupId: created.groupId }));
  await nextOfType(requester.messages, "claim:pending");
  await nextOfType(owner.messages, "claim:requested");

  owner.socket.close();
  const resolved = await nextOfType(requester.messages, "claim:resolved");
  assert.equal(resolved.approved, true);
  const state = await nextOfType(requester.messages, "state");
  assert.equal(
    state.groups.find((group) => group.id === created.groupId).ownerId,
    requester.ready.clientId,
  );
  requester.socket.close();
});

test("notifies the owner when a pending requester disconnects", async (t) => {
  const { port } = await startGateway(t);
  const owner = await connectClient(port, "owner-device");
  owner.socket.send(JSON.stringify({ type: "group:create", name: "审批分组" }));
  const created = await nextOfType(owner.messages, "group:created");
  await nextOfType(owner.messages, "state");

  const requester = await connectClient(port, "requester-device");
  requester.socket.send(JSON.stringify({ type: "claim", groupId: created.groupId }));
  await nextOfType(requester.messages, "claim:pending");
  const requested = await nextOfType(owner.messages, "claim:requested");

  requester.socket.close();
  const resolved = await nextOfType(owner.messages, "claim:resolved");
  assert.equal(resolved.requestId, requested.request.requestId);
  assert.equal(resolved.approved, false);
  assert.match(resolved.message, /已离线/);
  owner.socket.close();
});
