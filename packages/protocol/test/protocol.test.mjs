import assert from "node:assert/strict";
import test from "node:test";
import {
  PROTOCOL_VERSION,
  decodeBinaryFrame,
  encodeBinaryFrame,
  parseClientMessage,
} from "../dist/index.js";

test("parses and normalizes hello messages", () => {
  assert.deepEqual(
    parseClientMessage({
      type: "hello",
      protocol: PROTOCOL_VERSION,
      token: "long-enough-secret",
      name: "MacBook",
      capabilities: ["binaryFrames", "binaryFrames"],
    }),
    {
      type: "hello",
      protocol: PROTOCOL_VERSION,
      token: "long-enough-secret",
      name: "MacBook",
      capabilities: ["binaryFrames"],
    },
  );
});

test("rejects invalid commands and numeric values", () => {
  assert.throws(
    () => parseClientMessage({ type: "command", targetId: "abc", command: "erase" }),
    /不受支持/,
  );
  assert.throws(
    () =>
      parseClientMessage({
        type: "viewport",
        targetId: "abc",
        width: Number.NaN,
        height: 900,
      }),
    /有限数字/,
  );
});

test("round trips binary jpeg frames", () => {
  const encoded = encodeBinaryFrame({
    targetId: "target-123",
    metadata: { deviceWidth: 1280, deviceHeight: 720, pageScaleFactor: 1 },
    jpeg: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]),
  });
  const decoded = decodeBinaryFrame(encoded);
  assert.equal(decoded.targetId, "target-123");
  assert.deepEqual(decoded.metadata, {
    deviceWidth: 1280,
    deviceHeight: 720,
    pageScaleFactor: 1,
  });
  assert.deepEqual([...decoded.jpeg], [0xff, 0xd8, 0xff, 0xd9]);
});

test("rejects truncated binary frames", () => {
  assert.throws(() => decodeBinaryFrame(Uint8Array.from([82, 68, 70, 49, 0, 5, 0, 0])));
});
