import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  PROTOCOL_VERSION,
  encodeBinaryFrame,
  parseClientMessage,
} from "@relaydeck/protocol";
import { WebSocket, WebSocketServer } from "ws";
import { CdpConnection, discoverChrome } from "./cdp.mjs";
import { ChromeProcess } from "./chrome.mjs";
import { loadConfig, resolveTargetUrl } from "./config.mjs";
import { StateStore } from "./state-store.mjs";

const DEFAULT_GROUP_ID = "default";
const GROUP_COLORS = ["#d9ff43", "#ff7047", "#67d4ff", "#c6a8ff", "#ffcf5a"];
const AUTH_TIMEOUT_MS = 5_000;
const HEARTBEAT_INTERVAL_MS = 25_000;
const CLAIM_TIMEOUT_MS = 30_000;

let config;
try {
  config = loadConfig();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const stateStore = new StateStore(config.stateFile);
const savedState = await stateStore.load();
const savedGroups = savedState.groups.filter((group) => group.id !== DEFAULT_GROUP_ID);
const clients = new Map();
const claimRequests = new Map();
const claimQueues = new Map();
const targetSessions = new Map();
const sessionTargets = new Map();
const targetGroups = new Map(Object.entries(savedState.targetGroups));
const targetOpeners = new Map(Object.entries(savedState.targetOpeners));
const targetOrder = [...new Set(savedState.targetOrder)];
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
  ...savedGroups.map((group) => [group.id, { ...group, ownerId: null }]),
]);

let cdp = null;
let chromeConnected = false;
let reconnectTimer = null;
let lastChromeError = "";
let shuttingDown = false;
const chromeProcess = new ChromeProcess(config);

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function sendError(client, message, code = "request_failed", recoverable = true) {
  send(client.socket, { type: "error", message, code, recoverable });
}

function authenticatedClients() {
  return [...clients.values()].filter((client) => client.authenticated);
}

function onlineClients() {
  return authenticatedClients().map((client) => ({
    clientId: client.id,
    clientName: client.name,
  }));
}

function broadcast(payload) {
  for (const client of authenticatedClients()) send(client.socket, payload);
}

function broadcastFrame(targetId, data, metadata = {}) {
  const session = targetSessions.get(targetId);
  if (!session) return;
  const binary = encodeBinaryFrame({
    targetId,
    metadata,
    jpeg: Buffer.from(data, "base64"),
  });
  const json = { type: "frame", targetId, data, metadata };
  for (const clientId of session.viewers) {
    const client = clients.get(clientId);
    if (!client?.authenticated || client.socket.readyState !== WebSocket.OPEN) continue;
    if (client.capabilities.has("binaryFrames")) {
      client.socket.send(binary, { binary: true });
    } else {
      send(client.socket, json);
    }
  }
}

function workspaceSnapshot() {
  return {
    version: 1,
    groups: [...groups.values()]
      .filter((group) => group.id !== DEFAULT_GROUP_ID)
      .map(({ id, name, color, createdAt }) => ({ id, name, color, createdAt })),
    targetGroups: Object.fromEntries(targetGroups),
    targetOpeners: Object.fromEntries(targetOpeners),
    targetOrder,
  };
}

function persistWorkspace() {
  stateStore.schedule(workspaceSnapshot());
}

async function connectChrome() {
  if (shuttingDown || chromeConnected || cdp) return;
  try {
    const websocketUrl = await discoverChrome(config.cdpHttpUrl);
    const nextConnection = new CdpConnection(websocketUrl);
    await nextConnection.open();
    cdp = nextConnection;
    nextConnection.onEvent((message) => void handleCdpEvent(message));
    nextConnection.onClosed(onChromeClosed);
    await nextConnection.command("Target.setDiscoverTargets", { discover: true });
    chromeConnected = true;
    lastChromeError = "";
    broadcast({ type: "chrome", connected: true });
    await broadcastWorkspaceState();
  } catch (error) {
    cdp = null;
    chromeConnected = false;
    lastChromeError = `无法连接 Chrome：${error.message}`;
    scheduleReconnect();
  }
}

function onChromeClosed() {
  if (shuttingDown) return;
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
  void broadcastWorkspaceState();
  scheduleReconnect();
}

function scheduleReconnect() {
  if (shuttingDown || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connectChrome();
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
    persistWorkspace();
    return;
  }
  let insertAt = anchorIndex + 1;
  if (openerId) {
    while (insertAt < targetOrder.length && isDescendantOf(targetOrder[insertAt], openerId)) {
      insertAt += 1;
    }
  }
  targetOrder.splice(insertAt, 0, targetId);
  persistWorkspace();
}

function forgetTarget(targetId) {
  const orderIndex = targetOrder.indexOf(targetId);
  if (orderIndex >= 0) targetOrder.splice(orderIndex, 1);
  targetOpeners.delete(targetId);
  targetGroups.delete(targetId);
  persistWorkspace();
}

async function getTargets() {
  if (!cdp) return [];
  const { targetInfos = [] } = await cdp.command("Target.getTargets");
  const pageTargets = targetInfos
    .filter((target) => target.type === "page")
    .filter((target) => !/^(chrome|devtools|chrome-extension):/i.test(target.url || ""));
  const liveIds = new Set(pageTargets.map((target) => target.targetId));
  for (const targetId of [...targetOrder]) {
    if (!liveIds.has(targetId)) forgetTarget(targetId);
  }
  for (const target of pageTargets) {
    if (!targetOrder.includes(target.targetId)) {
      placeTarget(target.targetId, { openerId: target.openerId || null });
    }
  }
  const orderIndexes = new Map(targetOrder.map((targetId, index) => [targetId, index]));
  return pageTargets
    .sort(
      (left, right) =>
        (orderIndexes.get(left.targetId) ?? Number.MAX_SAFE_INTEGER) -
        (orderIndexes.get(right.targetId) ?? Number.MAX_SAFE_INTEGER),
    )
    .map((target) => {
      if (!targetGroups.has(target.targetId)) {
        const inheritedGroup = target.openerId ? targetGroups.get(target.openerId) : null;
        targetGroups.set(
          target.targetId,
          groups.has(inheritedGroup) ? inheritedGroup : DEFAULT_GROUP_ID,
        );
        persistWorkspace();
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

async function broadcastWorkspaceState(targetSocket = null) {
  let targets = [];
  try {
    if (chromeConnected) targets = await getTargets();
  } catch (error) {
    console.error("Failed to list targets:", error.message);
  }
  const payload = { type: "state", targets, groups: getGroups(targets), clients: onlineClients() };
  if (targetSocket) send(targetSocket, payload);
  else broadcast(payload);
}

function claimQueue(groupId) {
  const queue = claimQueues.get(groupId) || [];
  claimQueues.set(groupId, queue);
  return queue;
}

function removeClaimRequest(request) {
  clearTimeout(request.timer);
  claimRequests.delete(request.id);
  const queue = claimQueues.get(request.groupId) || [];
  const remaining = queue.filter((requestId) => requestId !== request.id);
  if (remaining.length) claimQueues.set(request.groupId, remaining);
  else claimQueues.delete(request.groupId);
}

function sendClaimResolution(request, approved, message) {
  const payload = {
    type: "claim:resolved",
    requestId: request.id,
    groupId: request.groupId,
    approved,
    message,
  };
  const requester = clients.get(request.requesterId);
  if (requester?.authenticated) send(requester.socket, payload);
  const ownerId = groups.get(request.groupId)?.ownerId;
  const owner = ownerId ? clients.get(ownerId) : null;
  if (owner?.authenticated && owner.id !== requester?.id) send(owner.socket, payload);
}

function notifyNextClaim(groupId) {
  const group = groups.get(groupId);
  if (!group) return;
  const queue = claimQueue(groupId);
  while (queue.length) {
    const request = claimRequests.get(queue[0]);
    const requester = request ? clients.get(request.requesterId) : null;
    if (request && requester?.authenticated) break;
    if (request) removeClaimRequest(request);
    else queue.shift();
  }
  if (!queue.length) {
    claimQueues.delete(groupId);
    return;
  }
  const request = claimRequests.get(queue[0]);
  if (!group.ownerId) {
    group.ownerId = request.requesterId;
    removeClaimRequest(request);
    sendClaimResolution(request, true, `“${group.name}”已交给你控制。`);
    notifyNextClaim(groupId);
    void broadcastWorkspaceState();
    return;
  }
  const owner = clients.get(group.ownerId);
  if (!owner?.authenticated) {
    group.ownerId = null;
    notifyNextClaim(groupId);
    return;
  }
  send(owner.socket, {
    type: "claim:requested",
    request: {
      requestId: request.id,
      groupId,
      groupName: group.name,
      requesterId: request.requesterId,
      requesterName: clients.get(request.requesterId)?.name || "未知设备",
      expiresAt: request.expiresAt,
    },
  });
}

function enqueueClaim(client, group) {
  const duplicate = [...claimRequests.values()].find(
    (request) => request.groupId === group.id && request.requesterId === client.id,
  );
  if (duplicate) {
    const owner = clients.get(group.ownerId);
    send(client.socket, {
      type: "claim:pending",
      requestId: duplicate.id,
      groupId: group.id,
      ownerName: owner?.name || "当前控制者",
      expiresAt: duplicate.expiresAt,
    });
    return;
  }
  const request = {
    id: randomUUID(),
    groupId: group.id,
    requesterId: client.id,
    expiresAt: Date.now() + CLAIM_TIMEOUT_MS,
    timer: null,
  };
  request.timer = setTimeout(() => {
    if (!claimRequests.has(request.id)) return;
    const wasFirst = claimQueues.get(group.id)?.[0] === request.id;
    removeClaimRequest(request);
    sendClaimResolution(request, false, "控制权申请已超时。");
    if (wasFirst) notifyNextClaim(group.id);
  }, CLAIM_TIMEOUT_MS);
  claimRequests.set(request.id, request);
  const queue = claimQueue(group.id);
  queue.push(request.id);
  const owner = clients.get(group.ownerId);
  send(client.socket, {
    type: "claim:pending",
    requestId: request.id,
    groupId: group.id,
    ownerName: owner?.name || "当前控制者",
    expiresAt: request.expiresAt,
  });
  if (queue.length === 1) notifyNextClaim(group.id);
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
    viewport: null,
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
        const viewport = metrics.cssVisualViewport || metrics.visualViewport || {};
        broadcastFrame(targetId, capture.data, {
          deviceWidth: viewport.clientWidth,
          deviceHeight: viewport.clientHeight,
          pageScaleFactor: viewport.scale || 1,
        });
      }
    } catch (error) {
      if (chromeConnected) console.error(`Frame capture failed for ${targetId}:`, error.message);
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
  await broadcastWorkspaceState();
}

async function handleCdpEvent(message) {
  if (message.method === "Page.screencastFrame" && message.sessionId) {
    const targetId = sessionTargets.get(message.sessionId);
    const session = targetId ? targetSessions.get(targetId) : null;
    if (targetId && session) {
      session.lastScreencastAt = Date.now();
      broadcastFrame(targetId, message.params.data, message.params.metadata || {});
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
    message.method !== "Target.targetCreated" &&
    message.method !== "Target.targetInfoChanged" &&
    message.method !== "Target.targetDestroyed"
  ) {
    return;
  }
  if (message.method === "Target.targetDestroyed") {
    const targetId = message.params.targetId;
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
      const inheritedGroup = target.openerId ? targetGroups.get(target.openerId) : null;
      targetGroups.set(
        target.targetId,
        groups.has(inheritedGroup) ? inheritedGroup : DEFAULT_GROUP_ID,
      );
      persistWorkspace();
    }
    if (target?.type === "page" && !targetOrder.includes(target.targetId)) {
      placeTarget(target.targetId, { openerId: target.openerId || null });
    }
  }
  await broadcastWorkspaceState();
  if (message.method === "Target.targetCreated") {
    const target = message.params.targetInfo;
    const groupId = targetGroups.get(target?.targetId);
    const owner = groupId ? clients.get(groups.get(groupId)?.ownerId) : null;
    if (target?.openerId && owner?.targetId === target.openerId) {
      await viewTarget(owner, target.targetId);
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
    width: Math.max(320, Math.min(2560, Math.round(width || 0))),
    height: Math.max(240, Math.min(1600, Math.round(height || 0))),
  };
}

async function setTargetViewport(targetId, viewport) {
  const session = await ensureTargetSession(targetId);
  if (session.viewport?.width === viewport.width && session.viewport?.height === viewport.height) {
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
  switch (message.type) {
    case "list":
      await broadcastWorkspaceState(client.socket);
      break;
    case "view":
      await viewTarget(client, message.targetId);
      break;
    case "viewport": {
      requireOwner(client, message.targetId);
      const viewport = normalizedViewport(message.width, message.height);
      client.viewport = viewport;
      await setTargetViewport(message.targetId, viewport);
      break;
    }
    case "clipboard": {
      requireOwner(client, message.targetId);
      if (message.action === "paste") {
        await pageCommand(message.targetId, "Input.insertText", { text: message.text || "" });
      } else {
        const result = await pageCommand(message.targetId, "Runtime.evaluate", {
          expression: `(() => {
            const active = document.activeElement;
            if (
              active &&
              (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) &&
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
      const requestedGroupId = message.groupId || DEFAULT_GROUP_ID;
      const groupId = groups.has(requestedGroupId) ? requestedGroupId : DEFAULT_GROUP_ID;
      const group = groups.get(groupId);
      if (group.ownerId && group.ownerId !== client.id) {
        throw new Error("此分组当前为只读，请先取得分组控制权");
      }
      if (!cdp) throw new Error("Chrome 未连接");
      const claimedUnownedGroup = !group.ownerId;
      if (claimedUnownedGroup) group.ownerId = client.id;
      const requestedUrl = message.url || config.defaultUrl;
      const url = resolveTargetUrl(requestedUrl);
      let targetId;
      try {
        ({ targetId } = await cdp.command("Target.createTarget", {
          url,
          background: true,
        }));
      } catch (error) {
        if (claimedUnownedGroup && group.ownerId === client.id) group.ownerId = null;
        throw error;
      }
      targetGroups.set(targetId, groupId);
      const afterTargetId = message.afterTargetId || "";
      placeTarget(targetId, {
        afterTargetId: targetGroups.get(afterTargetId) === groupId ? afterTargetId : null,
      });
      persistWorkspace();
      await viewTarget(client, targetId);
      await broadcastWorkspaceState();
      break;
    }
    case "claim": {
      const groupId = message.groupId || targetGroups.get(message.targetId) || DEFAULT_GROUP_ID;
      const group = groups.get(groupId);
      if (!group) throw new Error("分组不存在");
      if (!group.ownerId || group.ownerId === client.id) {
        group.ownerId = client.id;
        await broadcastWorkspaceState();
      } else {
        enqueueClaim(client, group);
      }
      break;
    }
    case "claim:respond": {
      const request = claimRequests.get(message.requestId);
      if (!request) throw new Error("控制权申请已失效");
      const group = groups.get(request.groupId);
      if (!group || group.ownerId !== client.id) throw new Error("只有当前控制者可以处理申请");
      if (claimQueues.get(group.id)?.[0] !== request.id) throw new Error("请先处理更早的控制权申请");
      const requester = clients.get(request.requesterId);
      removeClaimRequest(request);
      if (message.approved && requester?.authenticated) {
        send(client.socket, {
          type: "claim:resolved",
          requestId: request.id,
          groupId: request.groupId,
          approved: true,
          message: `已将“${group.name}”移交给 ${requester.name}。`,
        });
        group.ownerId = requester.id;
        sendClaimResolution(request, true, `${client.name} 已同意你的控制权申请。`);
      } else {
        sendClaimResolution(
          request,
          false,
          message.approved ? "申请设备已经离线。" : `${client.name} 拒绝了你的控制权申请。`,
        );
      }
      notifyNextClaim(group.id);
      await broadcastWorkspaceState();
      break;
    }
    case "release": {
      const groupId = targetGroups.get(message.targetId) || DEFAULT_GROUP_ID;
      const group = groups.get(groupId);
      if (group?.ownerId === client.id) {
        group.ownerId = null;
        notifyNextClaim(groupId);
      }
      await broadcastWorkspaceState();
      break;
    }
    case "close":
      requireOwner(client, message.targetId);
      if (!cdp) throw new Error("Chrome 未连接");
      await cdp.command("Target.closeTarget", { targetId: message.targetId });
      break;
    case "group:create": {
      const name = message.name.trim();
      if (!name) throw new Error("分组名称不能为空");
      const id = randomUUID();
      groups.set(id, {
        id,
        name,
        color: GROUP_COLORS[groups.size % GROUP_COLORS.length],
        ownerId: client.id,
        createdAt: Date.now(),
      });
      persistWorkspace();
      send(client.socket, { type: "group:created", groupId: id });
      await broadcastWorkspaceState();
      break;
    }
    case "group:delete": {
      if (message.groupId === DEFAULT_GROUP_ID) throw new Error("默认工作区不能删除");
      const group = groups.get(message.groupId);
      if (!group) throw new Error("分组不存在");
      if (group.ownerId && group.ownerId !== client.id) {
        throw new Error("只有当前分组控制者可以删除分组");
      }
      const defaultGroup = groups.get(DEFAULT_GROUP_ID);
      if (!defaultGroup.ownerId) defaultGroup.ownerId = group.ownerId;
      for (const [targetId, groupId] of targetGroups.entries()) {
        if (groupId === message.groupId) targetGroups.set(targetId, DEFAULT_GROUP_ID);
      }
      for (const requestId of [...(claimQueues.get(message.groupId) || [])]) {
        const request = claimRequests.get(requestId);
        if (!request) continue;
        removeClaimRequest(request);
        sendClaimResolution(request, false, "分组已被删除。");
      }
      groups.delete(message.groupId);
      persistWorkspace();
      await broadcastWorkspaceState();
      break;
    }
    case "navigate": {
      requireOwner(client, message.targetId);
      const url = new URL(message.url);
      if (!["http:", "https:"].includes(url.protocol)) {
        throw new Error("只允许打开 HTTP 或 HTTPS 地址");
      }
      await pageCommand(message.targetId, "Page.navigate", { url: url.href });
      break;
    }
    case "command": {
      requireOwner(client, message.targetId);
      if (message.command === "reload") {
        await pageCommand(message.targetId, "Page.reload", { ignoreCache: false });
      } else {
        const history = await pageCommand(message.targetId, "Page.getNavigationHistory");
        const delta = message.command === "back" ? -1 : 1;
        const entry = history.entries?.[history.currentIndex + delta];
        if (entry) {
          await pageCommand(message.targetId, "Page.navigateToHistoryEntry", {
            entryId: entry.id,
          });
        }
      }
      break;
    }
    case "text":
      requireOwner(client, message.targetId);
      await pageCommand(message.targetId, "Input.insertText", { text: message.text });
      break;
    case "input": {
      requireOwner(client, message.targetId);
      if (message.method === "mouse") {
        await pageCommand(message.targetId, "Input.dispatchMouseEvent", {
          type: message.eventType,
          x: message.x,
          y: message.y,
          button: message.button || "none",
          buttons: message.buttons || 0,
          clickCount: message.clickCount || 0,
          pointerType: "mouse",
        });
      } else if (message.method === "wheel") {
        await pageCommand(message.targetId, "Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: message.x,
          y: message.y,
          deltaX: message.deltaX || 0,
          deltaY: message.deltaY || 0,
        });
      } else {
        const modifiers = message.modifiers || 0;
        const isSelectAll =
          message.eventType === "keyDown" &&
          (modifiers & (2 | 4)) !== 0 &&
          (message.key || "").toLowerCase() === "a";
        await pageCommand(message.targetId, "Input.dispatchKeyEvent", {
          type: message.eventType,
          key: message.key || "",
          code: message.code || "",
          text: message.text || "",
          modifiers,
          windowsVirtualKeyCode: message.windowsVirtualKeyCode || 0,
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
  if (client.disconnected) return;
  client.disconnected = true;
  clearTimeout(client.authTimer);
  clients.delete(client.id);
  if (client.targetId && targetSessions.has(client.targetId)) {
    targetSessions.get(client.targetId).viewers.delete(client.id);
  }
  const affectedQueues = new Set();
  for (const request of [...claimRequests.values()]) {
    if (request.requesterId !== client.id) continue;
    affectedQueues.add(request.groupId);
    sendClaimResolution(request, false, `${client.name} 已离线，控制权申请已取消。`);
    removeClaimRequest(request);
  }
  for (const group of groups.values()) {
    if (group.ownerId === client.id) {
      group.ownerId = null;
      affectedQueues.add(group.id);
    }
  }
  for (const groupId of affectedQueues) notifyNextClaim(groupId);
  void broadcastWorkspaceState();
}

function originAllowed(request) {
  if (config.allowedOrigins.size === 0) return true;
  const origin = request.headers.origin;
  return !origin || config.allowedOrigins.has(origin);
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
        clients: authenticatedClients().length,
        chrome: chromeConnected,
        protocol: PROTOCOL_VERSION,
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
      protocol: PROTOCOL_VERSION,
    }),
  );
});

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 256 * 1024,
  perMessageDeflate: false,
});

server.on("upgrade", (request, socket, head) => {
  if (!originAllowed(request)) {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (websocket) => {
    const client = {
      id: randomUUID(),
      name: "",
      socket: websocket,
      targetId: null,
      viewport: null,
      authenticated: false,
      capabilities: new Set(),
      alive: true,
      disconnected: false,
      authTimer: null,
    };
    clients.set(client.id, client);
    client.authTimer = setTimeout(() => websocket.close(4001, "authentication timeout"), AUTH_TIMEOUT_MS);

    websocket.on("pong", () => {
      client.alive = true;
    });
    websocket.on("message", async (raw, isBinary) => {
      try {
        if (isBinary) throw new Error("客户端不能发送二进制消息");
        const message = parseClientMessage(JSON.parse(String(raw)));
        if (!client.authenticated) {
          if (message.type !== "hello" || !safeEqual(message.token, config.token)) {
            websocket.close(4001, "authentication failed");
            return;
          }
          clearTimeout(client.authTimer);
          client.authenticated = true;
          client.name = message.name.trim() || "未命名设备";
          client.capabilities = new Set(message.capabilities || []);
          send(websocket, {
            type: "ready",
            protocol: PROTOCOL_VERSION,
            clientId: client.id,
            clientName: client.name,
            capabilities: ["binaryFrames"],
          });
          send(websocket, {
            type: "chrome",
            connected: chromeConnected,
            message: chromeConnected ? undefined : lastChromeError || "正在等待 Chrome。",
          });
          await broadcastWorkspaceState();
          return;
        }
        if (message.type === "hello") throw new Error("连接已经完成认证");
        await handleClientMessage(client, message);
      } catch (error) {
        if (client.authenticated) sendError(client, error.message || "请求失败");
        else websocket.close(4002, "invalid handshake");
      }
    });
    websocket.on("close", () => disconnectClient(client));
    websocket.on("error", () => disconnectClient(client));
  });
});

const heartbeat = setInterval(() => {
  for (const client of clients.values()) {
    if (!client.alive) {
      client.socket.terminate();
      continue;
    }
    client.alive = false;
    client.socket.ping();
  }
}, HEARTBEAT_INTERVAL_MS);
heartbeat.unref();

server.listen(config.port, config.host, () => {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.port;
  console.log(`Relaydeck gateway listening on ws://${config.host}:${port}`);
  console.log(`Chrome discovery: ${config.cdpHttpUrl}`);
  if (config.autoStartChrome) {
    try {
      chromeProcess.start();
    } catch (error) {
      lastChromeError = error.message;
      console.error(error.message);
    }
  }
  void connectChrome();
});

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(heartbeat);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  for (const request of claimRequests.values()) clearTimeout(request.timer);
  for (const client of clients.values()) client.socket.close(1001, "server shutdown");
  wss.close();
  cdp?.close();
  chromeProcess.stop();
  await stateStore.flush();
  await new Promise((resolve) => server.close(resolve));
}

process.on("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.on("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
