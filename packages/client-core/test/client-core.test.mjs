import assert from "node:assert/strict";
import test from "node:test";
import { RelayConnection, normalizeGatewayUrl } from "../dist/index.js";
import { encodeBinaryFrame } from "../../protocol/dist/index.js";

class FakeSocket extends EventTarget {
  static OPEN = 1;
  readyState = 0;
  binaryType = "blob";
  sent = [];

  send(value) {
    this.sent.push(value);
  }

  close(code = 1000, reason = "") {
    this.readyState = 3;
    this.dispatchEvent(new CloseEvent("close", { code, reason }));
  }

  open() {
    this.readyState = FakeSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  message(value) {
    this.dispatchEvent(new MessageEvent("message", { data: value }));
  }
}

test("normalizes LAN gateway addresses", () => {
  assert.equal(normalizeGatewayUrl("192.168.1.8:8788"), "ws://192.168.1.8:8788");
  assert.equal(normalizeGatewayUrl("wss://relay.example/ws?secret=bad"), "wss://relay.example/ws");
  assert.throws(() => normalizeGatewayUrl("https://example.com"), /ws:\/\//);
});

test("authenticates before sending control messages", () => {
  const socket = new FakeSocket();
  const connection = new RelayConnection(
    { url: "ws://127.0.0.1:8788", token: "secret-value", name: "Mac" },
    () => socket,
  );
  connection.connect();
  assert.equal(connection.send({ type: "list" }), false);
  socket.open();
  const hello = JSON.parse(socket.sent[0]);
  assert.equal(hello.type, "hello");
  assert.equal(hello.token, "secret-value");
  assert.match(socket.sent[0], /binaryFrames/);
  socket.message(
    JSON.stringify({
      type: "ready",
      protocol: 2,
      clientId: "client",
      clientName: "Mac",
      capabilities: ["binaryFrames"],
    }),
  );
  assert.equal(connection.state.status, "online");
  assert.equal(connection.send({ type: "list" }), true);
});

test("does not reconnect after authentication failure", () => {
  const socket = new FakeSocket();
  const timers = [];
  const connection = new RelayConnection(
    { url: "ws://127.0.0.1:8788", token: "bad", name: "Mac" },
    () => socket,
    {
      setTimeout(callback) {
        timers.push(callback);
        return callback;
      },
      clearTimeout() {},
    },
  );
  connection.connect();
  socket.open();
  socket.close(4001, "authentication failed");
  assert.equal(connection.state.status, "auth-failed");
  assert.equal(timers.length, 0);
});

test("reconnects after a transient gateway disconnect", () => {
  const firstSocket = new FakeSocket();
  const secondSocket = new FakeSocket();
  const sockets = [firstSocket, secondSocket];
  const timers = [];
  const connection = new RelayConnection(
    { url: "ws://127.0.0.1:8788", token: "secret", name: "Mac" },
    () => sockets.shift(),
    {
      setTimeout(callback, delay) {
        timers.push({ callback, delay });
        return callback;
      },
      clearTimeout() {},
    },
  );
  connection.connect();
  assert.equal(connection.state.status, "connecting");
  firstSocket.open();
  firstSocket.message(
    JSON.stringify({
      type: "ready",
      protocol: 2,
      clientId: "first",
      clientName: "Mac",
      capabilities: ["binaryFrames"],
    }),
  );
  firstSocket.close(1006, "network lost");
  assert.equal(connection.state.status, "reconnecting");
  assert.equal(timers[0].delay, 500);
  timers[0].callback();
  assert.equal(connection.state.status, "reconnecting");
  secondSocket.open();
  assert.equal(connection.state.status, "authenticating");
});

test("returns to idle after an intentional disconnect", () => {
  const socket = new FakeSocket();
  const connection = new RelayConnection(
    { url: "ws://127.0.0.1:8788", token: "secret", name: "Mac" },
    () => socket,
  );
  connection.connect();
  socket.open();
  connection.disconnect();
  assert.equal(connection.state.status, "idle");
  assert.equal(connection.state.error, "");
});

test("decodes binary frames from the gateway", () => {
  const socket = new FakeSocket();
  const connection = new RelayConnection(
    { url: "ws://127.0.0.1:8788", token: "secret", name: "Mac" },
    () => socket,
  );
  let frame;
  connection.onFrame((value) => {
    frame = value;
  });
  connection.connect();
  socket.open();
  socket.message(
    encodeBinaryFrame({
      targetId: "target",
      metadata: { deviceWidth: 800 },
      jpeg: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]),
    }).buffer,
  );
  assert.equal(frame.targetId, "target");
  assert.equal(frame.metadata.deviceWidth, 800);
});
