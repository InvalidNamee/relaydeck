import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";

const PORT = Number(process.env.GATEWAY_PORT || 8788);
const HOST = process.env.GATEWAY_HOST || "127.0.0.1";
const TOKEN = process.env.GATEWAY_TOKEN || "";
const CDP_HTTP_URL = (process.env.CDP_HTTP_URL || "http://127.0.0.1:9222").replace(/\/$/, "");
const DEFAULT_URL = process.env.DEFAULT_URL || "https://ac.nowcoder.com/";
const DEFAULT_GROUP_ID = "default";
const GROUP_COLORS = ["#d9ff43", "#ff7047", "#67d4ff", "#c6a8ff", "#ffcf5a"];

if (!TOKEN || TOKEN.length < 12) {
  console.error("GATEWAY_TOKEN is required and must be at least 12 characters.");
  process.exit(1);
}

const clients = new Map();
const targetSessions = new Map();
const sessionTargets = new Map();
const targetGroups = new Map();
const targetOpeners = new Map();
const targetOrder = [];
const groups = new Map([
  [
    DEFAULT_GROUP_ID,
    {
      id: DEFAULT_GROUP_ID,
      name: "默认工作区",
      color: GROUP_COLORS[0],
      ownerId: null,
      createdAt: 0,
    },
  ],
]);

let cdp = null;
let chromeConnected = false;
let reconnectTimer = null;
let lastChromeError = "";

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function broadcast(payload) {
  for (const client of clients.values()) send(client.socket, payload);
}

function broadcastFrame(targetId, data, metadata = {}) {
  const session = targetSessions.get(targetId);
  if (!session) return;
  const payload = { type: "frame", targetId, data, metadata };
  for (const clientId of session.viewers) {
    const client = clients.get(clientId);
    if (client) send(client.socket, payload);
  }
}

class CdpConnection {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
  }

  async open() {
    this.socket = new WebSocket(this.url, { maxPayload: 64 * 1024 * 1024 });
    await new Promise((resolve, reject) => {
      this.socket.once("open", resolve);
      this.socket.once("error", reject);
    });

    this.socket.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }

      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result || {});
        return;
      }

      for (const listener of this.listeners) listener(message);
    });

    this.socket.on("close", () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error("Chrome DevTools connection closed"));
      }
      this.pending.clear();
      onChromeClosed();
    });
  }

  command(method, params = {}, sessionId) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Chrome is not connected"));
    }
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify(payload));
    });
  }

  onEvent(listener) {
    this.listeners.add(listener);
  }
}

async function discoverChrome() {
  const response = await fetch(`${CDP_HTTP_URL}/json/version`, {
    signal: AbortSignal.timeout(2000),
  });
  if (!response.ok) throw new Error(`CDP discovery returned ${response.status}`);
  const version = await response.json();
  if (!version.webSocketDebuggerUrl) {
    throw new Error("Chrome did not publish a browser WebSocket URL");
  }
  return version.webSocketDebuggerUrl;
}

async function connectChrome() {
  if (chromeConnected || cdp) return;
  try {
    const websocketUrl = await discoverChrome();
    const nextConnection = new CdpConnection(websocketUrl);
    await nextConnection.open();
    cdp = nextConnection;
    cdp.onEvent(handleCdpEvent);
    await cdp.command("Target.setDiscoverTargets", { discover: true });
    chromeConnected = true;
    lastChromeError = "";
    broadcast({ type: "chrome", connected: true });
    await broadcastTargets();
  } catch (error) {
    cdp = null;
    chromeConnected = false;
    lastChromeError = `无法连接 Chrome：${error.message}`;
    scheduleReconnect();
  }
}

function onChromeClosed() {
  cdp = null;
  chromeConnected = false;
  for (const session of targetSessions.values()) {
    if (session.pollTimer) clearTimeout(session.pollTimer);
  }
  targetSessions.clear();
  sessionTargets.clear();
  broadcast({
    type: "chrome",
    connected: false,
    message: "Chrome 连接已断开，正在重试。",
  });
  scheduleReconnect();
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectChrome();
  }, 1800);
}

function isDescendantOf(targetId, ancestorId) {
  const visited = new Set();
  let currentId = targetOpeners.get(targetId);
  while (currentId && !visited.has(currentId)) {
    if (currentId === ancestorId) return true;
    visited.add(currentId);
    currentId = targetOpeners.get(currentId);
  }
  return false;
}

function placeTarget(targetId, { openerId = null, afterTargetId = null } = {}) {
  const existingIndex = targetOrder.indexOf(targetId);
  if (existingIndex >= 0) targetOrder.splice(existingIndex, 1);
  if (openerId) targetOpeners.set(targetId, openerId);

  const anchorId = afterTargetId || openerId;
  const anchorIndex = anchorId ? targetOrder.indexOf(anchorId) : -1;
  if (anchorIndex < 0) {
    targetOrder.push(targetId);
    return;
  }

  let insertAt = anchorIndex + 1;
  if (openerId) {
    while (
      insertAt < targetOrder.length &&
      isDescendantOf(targetOrder[insertAt], openerId)
    ) {
      insertAt += 1;
    }
  }
  targetOrder.splice(insertAt, 0, targetId);
}

function forgetTarget(targetId) {
  const orderIndex = targetOrder.indexOf(targetId);
  if (orderIndex >= 0) targetOrder.splice(orderIndex, 1);
  targetOpeners.delete(targetId);
}

async function getTargets() {
  if (!cdp) return [];
  const { targetInfos = [] } = await cdp.command("Target.getTargets");
  const pageTargets = targetInfos
    .filter((target) => target.type === "page")
    .filter((target) => !/^(chrome|devtools|chrome-extension):/i.test(target.url || ""));
  for (const target of pageTargets) {
    if (!targetOrder.includes(target.targetId)) {
      placeTarget(target.targetId, { openerId: target.openerId || null });
    }
  }
  const orderIndexes = new Map(
    targetOrder.map((targetId, index) => [targetId, index]),
  );
  return pageTargets
    .sort(
      (left, right) =>
        (orderIndexes.get(left.targetId) ?? Number.MAX_SAFE_INTEGER) -
        (orderIndexes.get(right.targetId) ?? Number.MAX_SAFE_INTEGER),
    )
    .map((target) => {
      if (!targetGroups.has(target.targetId)) {
        const inheritedGroup = target.openerId
          ? targetGroups.get(target.openerId)
          : null;
        targetGroups.set(
          target.targetId,
          groups.has(inheritedGroup) ? inheritedGroup : DEFAULT_GROUP_ID,
        );
      }
      const groupId = targetGroups.get(target.targetId);
      const ownerId = groups.get(groupId)?.ownerId || null;
      const owner = ownerId ? clients.get(ownerId) : null;
      return {
        targetId: target.targetId,
        title: target.title || "新标签页",
        url: target.url || "about:blank",
        groupId,
        ownerId,
        ownerName: owner?.name || null,
        viewerCount: targetSessions.get(target.targetId)?.viewers.size || 0,
      };
    });
}

function getGroups(targets = []) {
  return [...groups.values()]
    .sort((left, right) => left.createdAt - right.createdAt)
    .map((group) => {
      const owner = group.ownerId ? clients.get(group.ownerId) : null;
      return {
        id: group.id,
        name: group.name,
        color: group.color,
        ownerId: group.ownerId,
        ownerName: owner?.name || null,
        targetCount: targets.filter((target) => target.groupId === group.id).length,
        deletable: group.id !== DEFAULT_GROUP_ID,
      };
    });
}

async function broadcastTargets(targetSocket = null) {
  if (!chromeConnected) return;
  try {
    const targets = await getTargets();
    const payload = { type: "state", targets, groups: getGroups(targets) };
    if (targetSocket) send(targetSocket, payload);
    else broadcast(payload);
  } catch (error) {
    console.error("Failed to list targets:", error.message);
  }
}

async function ensureTargetSession(targetId) {
  const existing = targetSessions.get(targetId);
  if (existing) return existing;
  if (!cdp) throw new Error("Chrome 未连接");

  const { sessionId } = await cdp.command("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  const session = {
    sessionId,
    viewers: new Set(),
    lastScreencastAt: 0,
    pollTimer: null,
  };
  targetSessions.set(targetId, session);
  sessionTargets.set(sessionId, targetId);

  await cdp.command("Page.enable", {}, sessionId);
  await cdp.command(
    "Page.startScreencast",
    {
      format: "jpeg",
      quality: 72,
      maxWidth: 2560,
      maxHeight: 1600,
      everyNthFrame: 1,
    },
    sessionId,
  );
  scheduleFrameFallback(targetId);
  return session;
}

function scheduleFrameFallback(targetId, delay = 120) {
  const session = targetSessions.get(targetId);
  if (!session || session.pollTimer) return;
  session.pollTimer = setTimeout(async () => {
    session.pollTimer = null;
    if (!targetSessions.has(targetId) || !cdp) return;

    if (session.viewers.size === 0) {
      scheduleFrameFallback(targetId, 500);
      return;
    }

    try {
      if (Date.now() - session.lastScreencastAt > 350) {
        const [capture, metrics] = await Promise.all([
          cdp.command(
            "Page.captureScreenshot",
            {
              format: "jpeg",
              quality: 72,
              fromSurface: true,
              captureBeyondViewport: false,
            },
            session.sessionId,
          ),
          cdp.command("Page.getLayoutMetrics", {}, session.sessionId),
        ]);
        const viewport =
          metrics.cssVisualViewport || metrics.visualViewport || {};
        broadcastFrame(targetId, capture.data, {
          deviceWidth: viewport.clientWidth,
          deviceHeight: viewport.clientHeight,
          pageScaleFactor: viewport.scale || 1,
        });
      }
    } catch (error) {
      if (chromeConnected) {
        console.error(`Frame capture failed for ${targetId}:`, error.message);
      }
    } finally {
      scheduleFrameFallback(targetId, 120);
    }
  }, delay);
}

async function viewTarget(client, targetId) {
  const targets = await getTargets();
  if (!targets.some((target) => target.targetId === targetId)) {
    throw new Error("页面不存在或已经关闭");
  }

  if (client.targetId && targetSessions.has(client.targetId)) {
    targetSessions.get(client.targetId).viewers.delete(client.id);
  }

  const session = await ensureTargetSession(targetId);
  session.viewers.add(client.id);
  client.targetId = targetId;
  send(client.socket, { type: "viewing", targetId });
  await broadcastTargets();
}

async function handleCdpEvent(message) {
  if (message.method === "Page.screencastFrame" && message.sessionId) {
    const targetId = sessionTargets.get(message.sessionId);
    const session = targetId ? targetSessions.get(targetId) : null;
    if (targetId && session) {
      session.lastScreencastAt = Date.now();
      broadcastFrame(
        targetId,
        message.params.data,
        message.params.metadata || {},
      );
      cdp
        ?.command(
          "Page.screencastFrameAck",
          { sessionId: message.params.sessionId },
          message.sessionId,
        )
        .catch(() => {});
    }
    return;
  }

  if (
    message.method === "Target.targetCreated" ||
    message.method === "Target.targetInfoChanged" ||
    message.method === "Target.targetDestroyed"
  ) {
    if (message.method === "Target.targetDestroyed") {
      const targetId = message.params.targetId;
      targetGroups.delete(targetId);
      forgetTarget(targetId);
      const session = targetSessions.get(targetId);
      if (session) {
        sessionTargets.delete(session.sessionId);
        if (session.pollTimer) clearTimeout(session.pollTimer);
      }
      targetSessions.delete(targetId);
      for (const client of clients.values()) {
        if (client.targetId === targetId) client.targetId = null;
      }
    } else if (message.method === "Target.targetCreated") {
      const target = message.params.targetInfo;
      if (target?.type === "page" && !targetGroups.has(target.targetId)) {
        const inheritedGroup = target.openerId
          ? targetGroups.get(target.openerId)
          : null;
        targetGroups.set(
          target.targetId,
          groups.has(inheritedGroup) ? inheritedGroup : DEFAULT_GROUP_ID,
        );
      }
      if (target?.type === "page" && !targetOrder.includes(target.targetId)) {
        placeTarget(target.targetId, { openerId: target.openerId || null });
      }
    }
    await broadcastTargets();
    if (message.method === "Target.targetCreated") {
      const target = message.params.targetInfo;
      const groupId = targetGroups.get(target?.targetId);
      const owner = groupId ? clients.get(groups.get(groupId)?.ownerId) : null;
      if (target?.openerId && owner?.targetId === target.openerId) {
        await viewTarget(owner, target.targetId);
      }
    }
  }
}

function requireOwner(client, targetId) {
  const groupId = targetGroups.get(targetId) || DEFAULT_GROUP_ID;
  if (groups.get(groupId)?.ownerId !== client.id) {
    throw new Error("此分组当前为只读，请先取得分组控制权");
  }
}

async function pageCommand(targetId, method, params = {}) {
  const session = await ensureTargetSession(targetId);
  return cdp.command(method, params, session.sessionId);
}

function normalizedViewport(width, height) {
  return {
    width: Math.max(320, Math.min(2560, Math.round(Number(width) || 0))),
    height: Math.max(240, Math.min(1600, Math.round(Number(height) || 0))),
  };
}

async function setTargetViewport(targetId, viewport) {
  const session = await ensureTargetSession(targetId);
  if (
    session.viewport?.width === viewport.width &&
    session.viewport?.height === viewport.height
  ) {
    return;
  }
  await cdp.command(
    "Emulation.setDeviceMetricsOverride",
    {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: viewport.width,
      screenHeight: viewport.height,
    },
    session.sessionId,
  );
  session.viewport = viewport;
}

async function handleClientMessage(client, message) {
  if (!message || typeof message !== "object") return;

  switch (message.type) {
    case "list":
      await broadcastTargets(client.socket);
      break;
    case "view":
      await viewTarget(client, String(message.targetId));
      break;
    case "viewport": {
      const targetId = String(message.targetId);
      requireOwner(client, targetId);
      const viewport = normalizedViewport(message.width, message.height);
      client.viewport = viewport;
      await setTargetViewport(targetId, viewport);
      break;
    }
    case "clipboard": {
      const targetId = String(message.targetId);
      requireOwner(client, targetId);
      if (message.action === "paste") {
        const text = String(message.text || "").slice(0, 200_000);
        await pageCommand(targetId, "Input.insertText", { text });
      } else if (message.action === "copy") {
        const result = await pageCommand(targetId, "Runtime.evaluate", {
          expression: `(() => {
            const active = document.activeElement;
            if (
              active &&
              (active instanceof HTMLInputElement ||
                active instanceof HTMLTextAreaElement) &&
              typeof active.selectionStart === "number" &&
              typeof active.selectionEnd === "number"
            ) {
              return active.value.slice(active.selectionStart, active.selectionEnd);
            }
            return window.getSelection()?.toString() || "";
          })()`,
          returnByValue: true,
        });
        send(client.socket, {
          type: "clipboard:text",
          text: String(result.result?.value || ""),
        });
      }
      break;
    }
    case "create": {
      if (!cdp) throw new Error("Chrome 未连接");
      const requestedGroupId = String(message.groupId || DEFAULT_GROUP_ID);
      const groupId = groups.has(requestedGroupId)
        ? requestedGroupId
        : DEFAULT_GROUP_ID;
      const { targetId } = await cdp.command("Target.createTarget", {
        url: typeof message.url === "string" ? message.url : DEFAULT_URL,
        background: true,
      });
      targetGroups.set(targetId, groupId);
      const afterTargetId = String(message.afterTargetId || "");
      placeTarget(targetId, {
        afterTargetId:
          targetGroups.get(afterTargetId) === groupId ? afterTargetId : null,
      });
      if (!groups.get(groupId).ownerId) groups.get(groupId).ownerId = client.id;
      await viewTarget(client, targetId);
      await broadcastTargets();
      break;
    }
    case "claim": {
      const targetId = String(message.targetId);
      const groupId = targetGroups.get(targetId) || DEFAULT_GROUP_ID;
      groups.get(groupId).ownerId = client.id;
      await broadcastTargets();
      break;
    }
    case "release": {
      const targetId = String(message.targetId);
      const groupId = targetGroups.get(targetId) || DEFAULT_GROUP_ID;
      const group = groups.get(groupId);
      if (group?.ownerId === client.id) group.ownerId = null;
      await broadcastTargets();
      break;
    }
    case "close": {
      const targetId = String(message.targetId);
      requireOwner(client, targetId);
      if (!cdp) throw new Error("Chrome 未连接");
      await cdp.command("Target.closeTarget", { targetId });
      break;
    }
    case "group:create": {
      const name = String(message.name || "").trim().slice(0, 30);
      if (!name) throw new Error("分组名称不能为空");
      const id = randomUUID();
      const group = {
        id,
        name,
        color: GROUP_COLORS[groups.size % GROUP_COLORS.length],
        ownerId: client.id,
        createdAt: Date.now(),
      };
      groups.set(id, group);
      send(client.socket, { type: "group:created", groupId: id });
      await broadcastTargets();
      break;
    }
    case "group:delete": {
      const groupId = String(message.groupId);
      if (groupId === DEFAULT_GROUP_ID) throw new Error("默认工作区不能删除");
      const group = groups.get(groupId);
      if (!group) throw new Error("分组不存在");
      if (group.ownerId && group.ownerId !== client.id) {
        throw new Error("只有当前分组控制者可以删除分组");
      }
      const defaultGroup = groups.get(DEFAULT_GROUP_ID);
      if (!defaultGroup.ownerId) defaultGroup.ownerId = group.ownerId;
      for (const [targetId, targetGroupId] of targetGroups.entries()) {
        if (targetGroupId === groupId) {
          targetGroups.set(targetId, DEFAULT_GROUP_ID);
        }
      }
      groups.delete(groupId);
      await broadcastTargets();
      break;
    }
    case "navigate": {
      const targetId = String(message.targetId);
      requireOwner(client, targetId);
      const url = new URL(String(message.url));
      if (!["http:", "https:"].includes(url.protocol)) {
        throw new Error("只允许打开 HTTP 或 HTTPS 地址");
      }
      await pageCommand(targetId, "Page.navigate", { url: url.href });
      break;
    }
    case "command": {
      const targetId = String(message.targetId);
      requireOwner(client, targetId);
      if (message.command === "reload") {
        await pageCommand(targetId, "Page.reload", { ignoreCache: false });
      } else if (message.command === "back" || message.command === "forward") {
        const history = await pageCommand(targetId, "Page.getNavigationHistory");
        const delta = message.command === "back" ? -1 : 1;
        const entry = history.entries?.[history.currentIndex + delta];
        if (entry) {
          await pageCommand(targetId, "Page.navigateToHistoryEntry", {
            entryId: entry.id,
          });
        }
      }
      break;
    }
    case "input": {
      const targetId = String(message.targetId);
      requireOwner(client, targetId);
      if (message.method === "mouse") {
        await pageCommand(targetId, "Input.dispatchMouseEvent", {
          type: message.eventType,
          x: Number(message.x),
          y: Number(message.y),
          button: message.button || "none",
          buttons: Number(message.buttons || 0),
          clickCount: Number(message.clickCount || 0),
          pointerType: "mouse",
        });
      } else if (message.method === "wheel") {
        await pageCommand(targetId, "Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: Number(message.x),
          y: Number(message.y),
          deltaX: Number(message.deltaX || 0),
          deltaY: Number(message.deltaY || 0),
        });
      } else if (message.method === "key") {
        const modifiers = Number(message.modifiers || 0);
        const isSelectAll =
          message.eventType === "keyDown" &&
          (modifiers & (2 | 4)) !== 0 &&
          String(message.key || "").toLowerCase() === "a";
        await pageCommand(targetId, "Input.dispatchKeyEvent", {
          type: message.eventType,
          key: String(message.key || ""),
          code: String(message.code || ""),
          text: String(message.text || ""),
          modifiers,
          windowsVirtualKeyCode: Number(message.windowsVirtualKeyCode || 0),
          commands: isSelectAll ? ["selectAll"] : undefined,
        });
      }
      break;
    }
    default:
      break;
  }
}

function disconnectClient(client) {
  clients.delete(client.id);
  if (client.targetId && targetSessions.has(client.targetId)) {
    targetSessions.get(client.targetId).viewers.delete(client.id);
  }
  for (const group of groups.values()) {
    if (group.ownerId === client.id) group.ownerId = null;
  }
  broadcastTargets();
}

const server = createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(chromeConnected ? 200 : 503, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(
      JSON.stringify({
        ok: chromeConnected,
        clients: clients.size,
        chrome: chromeConnected,
        cdp: CDP_HTTP_URL,
      }),
    );
    return;
  }

  response.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(
    JSON.stringify({
      name: "Relaydeck Gateway",
      websocket: true,
      chrome: chromeConnected,
    }),
  );
});

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 256 * 1024,
  perMessageDeflate: false,
});

server.on("upgrade", (request, socket, head) => {
  let requestUrl;
  try {
    requestUrl = new URL(
      request.url,
      `http://${request.headers.host || "localhost"}`,
    );
  } catch {
    socket.destroy();
    return;
  }

  if (!safeEqual(requestUrl.searchParams.get("token") || "", TOKEN)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (websocket) => {
    const client = {
      id: randomUUID(),
      name: (requestUrl.searchParams.get("name") || "未命名设备").slice(0, 40),
      socket: websocket,
      targetId: null,
      viewport: null,
    };
    clients.set(client.id, client);

    send(websocket, {
      type: "ready",
      clientId: client.id,
      clientName: client.name,
    });
    send(websocket, {
      type: "chrome",
      connected: chromeConnected,
      message: chromeConnected ? undefined : lastChromeError || "正在等待 Chrome。",
    });
    if (chromeConnected) {
      broadcastTargets(websocket).catch(() => {});
    }

    websocket.on("message", async (raw) => {
      try {
        await handleClientMessage(client, JSON.parse(String(raw)));
      } catch (error) {
        send(websocket, {
          type: "error",
          message: error.message || "请求失败",
        });
      }
    });
    websocket.on("close", () => disconnectClient(client));
    websocket.on("error", () => disconnectClient(client));
    broadcastTargets();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Relaydeck gateway listening on ws://${HOST}:${PORT}`);
  console.log(`Chrome discovery: ${CDP_HTTP_URL}`);
  connectChrome();
});

process.on("SIGINT", () => server.close(() => process.exit(0)));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
