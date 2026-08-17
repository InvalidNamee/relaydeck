export const PROTOCOL_VERSION = 2 as const;
export const FRAME_MAGIC = "RDF1";

export type ClientCapability = "binaryFrames";

export type HelloMessage = {
  type: "hello";
  protocol: typeof PROTOCOL_VERSION;
  token: string;
  name: string;
  capabilities?: ClientCapability[];
};

export type MouseInputMessage = {
  type: "input";
  targetId: string;
  method: "mouse";
  eventType: "mousePressed" | "mouseReleased" | "mouseMoved";
  x: number;
  y: number;
  button?: "none" | "left" | "middle" | "right";
  buttons?: number;
  clickCount?: number;
};

export type WheelInputMessage = {
  type: "input";
  targetId: string;
  method: "wheel";
  x: number;
  y: number;
  deltaX?: number;
  deltaY?: number;
};

export type KeyInputMessage = {
  type: "input";
  targetId: string;
  method: "key";
  eventType: "keyDown" | "keyUp" | "rawKeyDown" | "char";
  key?: string;
  code?: string;
  text?: string;
  modifiers?: number;
  windowsVirtualKeyCode?: number;
};

export type ClientMessage =
  | HelloMessage
  | { type: "list" }
  | { type: "view"; targetId: string }
  | { type: "viewport"; targetId: string; width: number; height: number }
  | {
      type: "clipboard";
      targetId: string;
      action: "copy" | "paste";
      text?: string;
    }
  | {
      type: "create";
      url?: string;
      groupId?: string;
      afterTargetId?: string;
    }
  | { type: "claim"; targetId?: string; groupId?: string }
  | { type: "release" | "close"; targetId: string }
  | { type: "claim:respond"; requestId: string; approved: boolean }
  | { type: "group:create"; name: string }
  | { type: "group:delete"; groupId: string }
  | { type: "navigate"; targetId: string; url: string }
  | {
      type: "command";
      targetId: string;
      command: "reload" | "back" | "forward";
    }
  | MouseInputMessage
  | WheelInputMessage
  | KeyInputMessage
  | { type: "text"; targetId: string; text: string };

export type Target = {
  targetId: string;
  title: string;
  url: string;
  groupId: string;
  ownerId: string | null;
  ownerName: string | null;
  viewerCount: number;
};

export type Group = {
  id: string;
  name: string;
  color: string;
  ownerId: string | null;
  ownerName: string | null;
  targetCount: number;
  deletable: boolean;
};

export type OnlineClient = {
  clientId: string;
  clientName: string;
};

export type ClaimRequest = {
  requestId: string;
  groupId: string;
  groupName: string;
  requesterId: string;
  requesterName: string;
  expiresAt: number;
};

export type FrameMetadata = {
  deviceWidth?: number;
  deviceHeight?: number;
  pageScaleFactor?: number;
  scrollOffsetX?: number;
  scrollOffsetY?: number;
  timestamp?: number;
};

export type ServerMessage =
  | {
      type: "ready";
      protocol: typeof PROTOCOL_VERSION;
      clientId: string;
      clientName: string;
      capabilities: ClientCapability[];
    }
  | { type: "state"; targets: Target[]; groups: Group[]; clients: OnlineClient[] }
  | { type: "group:created"; groupId: string }
  | { type: "claim:requested"; request: ClaimRequest }
  | { type: "claim:pending"; requestId: string; groupId: string; ownerName: string; expiresAt: number }
  | { type: "claim:resolved"; requestId: string; groupId: string; approved: boolean; message: string }
  | { type: "viewing"; targetId: string }
  | { type: "clipboard:text"; text: string }
  | {
      type: "frame";
      targetId: string;
      data: string;
      metadata: FrameMetadata;
    }
  | {
      type: "error";
      message: string;
      code?: string;
      recoverable?: boolean;
    }
  | { type: "chrome"; connected: boolean; message?: string };

export type BinaryFrame = {
  targetId: string;
  metadata: FrameMetadata;
  jpeg: Uint8Array;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(
  object: Record<string, unknown>,
  key: string,
  options: { optional?: boolean; max?: number } = {},
): string | undefined {
  const value = object[key];
  if (value === undefined && options.optional) return undefined;
  if (typeof value !== "string") throw new Error(`${key} 必须是字符串`);
  if (value.length > (options.max ?? 2048)) throw new Error(`${key} 过长`);
  return value;
}

function finiteNumber(
  object: Record<string, unknown>,
  key: string,
  options: { optional?: boolean } = {},
): number | undefined {
  const value = object[key];
  if (value === undefined && options.optional) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} 必须是有限数字`);
  }
  return value;
}

function booleanField(object: Record<string, unknown>, key: string): boolean {
  const value = object[key];
  if (typeof value !== "boolean") throw new Error(`${key} 必须是布尔值`);
  return value;
}

function targetId(object: Record<string, unknown>): string {
  return stringField(object, "targetId", { max: 128 })!;
}

function oneOf<T extends string>(
  value: unknown,
  key: string,
  choices: readonly T[],
): T {
  if (typeof value !== "string" || !choices.includes(value as T)) {
    throw new Error(`${key} 不受支持`);
  }
  return value as T;
}

export function parseClientMessage(value: unknown): ClientMessage {
  if (!isRecord(value)) throw new Error("消息必须是对象");
  const type = stringField(value, "type", { max: 32 });

  switch (type) {
    case "hello": {
      if (value.protocol !== PROTOCOL_VERSION) {
        throw new Error(`不支持的协议版本：${String(value.protocol)}`);
      }
      const rawCapabilities = value.capabilities ?? [];
      if (!Array.isArray(rawCapabilities)) throw new Error("capabilities 必须是数组");
      const capabilities = rawCapabilities.map((item) =>
        oneOf(item, "capability", ["binaryFrames"] as const),
      );
      return {
        type,
        protocol: PROTOCOL_VERSION,
        token: stringField(value, "token", { max: 512 })!,
        name: stringField(value, "name", { max: 40 })!,
        capabilities: [...new Set(capabilities)],
      };
    }
    case "list":
      return { type };
    case "view":
      return { type, targetId: targetId(value) };
    case "viewport":
      return {
        type,
        targetId: targetId(value),
        width: finiteNumber(value, "width")!,
        height: finiteNumber(value, "height")!,
      };
    case "clipboard": {
      const action = oneOf(value.action, "action", ["copy", "paste"] as const);
      return {
        type,
        targetId: targetId(value),
        action,
        text: stringField(value, "text", { optional: action === "copy", max: 200_000 }),
      };
    }
    case "create":
      return {
        type,
        url: stringField(value, "url", { optional: true, max: 8192 }),
        groupId: stringField(value, "groupId", { optional: true, max: 128 }),
        afterTargetId: stringField(value, "afterTargetId", { optional: true, max: 128 }),
      };
    case "claim": {
      const parsedTargetId = stringField(value, "targetId", { optional: true, max: 128 });
      const groupId = stringField(value, "groupId", { optional: true, max: 128 });
      if (!parsedTargetId && !groupId) throw new Error("claim 必须包含 targetId 或 groupId");
      return { type, targetId: parsedTargetId, groupId };
    }
    case "release":
    case "close":
      return { type, targetId: targetId(value) };
    case "claim:respond":
      return {
        type,
        requestId: stringField(value, "requestId", { max: 128 })!,
        approved: booleanField(value, "approved"),
      };
    case "group:create":
      return { type, name: stringField(value, "name", { max: 30 })! };
    case "group:delete":
      return { type, groupId: stringField(value, "groupId", { max: 128 })! };
    case "navigate":
      return {
        type,
        targetId: targetId(value),
        url: stringField(value, "url", { max: 8192 })!,
      };
    case "command":
      return {
        type,
        targetId: targetId(value),
        command: oneOf(value.command, "command", ["reload", "back", "forward"] as const),
      };
    case "text":
      return {
        type,
        targetId: targetId(value),
        text: stringField(value, "text", { max: 200_000 })!,
      };
    case "input": {
      const method = oneOf(value.method, "method", ["mouse", "wheel", "key"] as const);
      if (method === "mouse") {
        return {
          type,
          targetId: targetId(value),
          method,
          eventType: oneOf(value.eventType, "eventType", [
            "mousePressed",
            "mouseReleased",
            "mouseMoved",
          ] as const),
          x: finiteNumber(value, "x")!,
          y: finiteNumber(value, "y")!,
          button:
            value.button === undefined
              ? undefined
              : oneOf(value.button, "button", ["none", "left", "middle", "right"] as const),
          buttons: finiteNumber(value, "buttons", { optional: true }),
          clickCount: finiteNumber(value, "clickCount", { optional: true }),
        };
      }
      if (method === "wheel") {
        return {
          type,
          targetId: targetId(value),
          method,
          x: finiteNumber(value, "x")!,
          y: finiteNumber(value, "y")!,
          deltaX: finiteNumber(value, "deltaX", { optional: true }),
          deltaY: finiteNumber(value, "deltaY", { optional: true }),
        };
      }
      return {
        type,
        targetId: targetId(value),
        method,
        eventType: oneOf(value.eventType, "eventType", [
          "keyDown",
          "keyUp",
          "rawKeyDown",
          "char",
        ] as const),
        key: stringField(value, "key", { optional: true, max: 128 }),
        code: stringField(value, "code", { optional: true, max: 128 }),
        text: stringField(value, "text", { optional: true, max: 4096 }),
        modifiers: finiteNumber(value, "modifiers", { optional: true }),
        windowsVirtualKeyCode: finiteNumber(value, "windowsVirtualKeyCode", {
          optional: true,
        }),
      };
    }
    default:
      throw new Error(`不支持的消息类型：${String(type)}`);
  }
}

export function encodeBinaryFrame(frame: BinaryFrame): Uint8Array {
  const target = encoder.encode(frame.targetId);
  const metadata = encoder.encode(JSON.stringify(frame.metadata));
  if (target.byteLength > 0xffff || metadata.byteLength > 0xffff) {
    throw new Error("帧头信息过长");
  }
  const result = new Uint8Array(8 + target.byteLength + metadata.byteLength + frame.jpeg.byteLength);
  result.set(encoder.encode(FRAME_MAGIC), 0);
  const view = new DataView(result.buffer);
  view.setUint16(4, target.byteLength);
  view.setUint16(6, metadata.byteLength);
  result.set(target, 8);
  result.set(metadata, 8 + target.byteLength);
  result.set(frame.jpeg, 8 + target.byteLength + metadata.byteLength);
  return result;
}

export function decodeBinaryFrame(input: ArrayBuffer | Uint8Array): BinaryFrame {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < 8 || decoder.decode(bytes.subarray(0, 4)) !== FRAME_MAGIC) {
    throw new Error("无效的二进制帧");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const targetLength = view.getUint16(4);
  const metadataLength = view.getUint16(6);
  const payloadOffset = 8 + targetLength + metadataLength;
  if (payloadOffset > bytes.byteLength) throw new Error("二进制帧已截断");
  const targetId = decoder.decode(bytes.subarray(8, 8 + targetLength));
  const metadataValue = JSON.parse(
    decoder.decode(bytes.subarray(8 + targetLength, payloadOffset)),
  ) as unknown;
  if (!isRecord(metadataValue)) throw new Error("帧元数据无效");
  const metadata: FrameMetadata = {};
  for (const key of [
    "deviceWidth",
    "deviceHeight",
    "pageScaleFactor",
    "scrollOffsetX",
    "scrollOffsetY",
    "timestamp",
  ] as const) {
    const value = metadataValue[key];
    if (value !== undefined) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error("帧元数据无效");
      }
      metadata[key] = value;
    }
  }
  return { targetId, metadata, jpeg: bytes.slice(payloadOffset) };
}
