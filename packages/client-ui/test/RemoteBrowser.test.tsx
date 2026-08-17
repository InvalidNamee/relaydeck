import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  RemoteBrowser,
  normalizeDefaultPageUrl,
  type ConnectionStore,
  type SavedConnection,
} from "../src/RemoteBrowser";

const TOKEN = "client-ui-test-token-32-characters";

class FakeSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeSocket[] = [];

  readyState = FakeSocket.CONNECTING;
  binaryType = "blob";
  sent: string[] = [];

  constructor(readonly url: string) {
    super();
    FakeSocket.instances.push(this);
  }

  send(value: string) {
    this.sent.push(value);
  }

  close(code = 1000, reason = "") {
    this.readyState = FakeSocket.CLOSED;
    this.dispatchEvent(new CloseEvent("close", { code, reason }));
  }

  open() {
    this.readyState = FakeSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  message(value: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
  }
}

function savedProfile(overrides: Partial<SavedConnection> = {}): SavedConnection {
  return {
    id: "profile-1",
    label: "测试网关",
    gatewayUrl: "ws://127.0.0.1:8788",
    token: TOKEN,
    clientName: "测试设备",
    ...overrides,
  };
}

function storeWith(profiles: SavedConnection[] = [savedProfile()]) {
  const store: ConnectionStore = {
    load: vi.fn(async () => profiles),
    save: vi.fn(async () => {}),
    activate: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  };
  return store;
}

async function online(store: ConnectionStore) {
  render(<RemoteBrowser connectionStore={store} />);
  await waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
  const socket = FakeSocket.instances[0];
  await act(async () => {
    socket.open();
    socket.message({
      type: "ready",
      protocol: 2,
      clientId: "client-1",
      clientName: "测试设备",
      capabilities: ["binaryFrames"],
    });
    socket.message({ type: "chrome", connected: true });
    socket.message({
      type: "state",
      targets: [],
      groups: [{
        id: "default",
        name: "默认工作区",
        color: "#d9ff43",
        ownerId: null,
        ownerName: null,
        targetCount: 0,
        deletable: false,
      }],
    });
  });
  await screen.findByText("Chrome 已连接");
  return socket;
}

function fillConnectionForm() {
  fireEvent.change(screen.getByRole("textbox", { name: "网关名称" }), { target: { value: "办公室网关" } });
  fireEvent.change(screen.getByRole("textbox", { name: "本设备名称" }), { target: { value: "MacBook" } });
  fireEvent.change(screen.getByRole("textbox", { name: "网关地址" }), { target: { value: "192.168.1.20:8788" } });
  fireEvent.change(screen.getByLabelText("访问令牌"), { target: { value: TOKEN } });
}

function target(id: string, ownerId: string | null = "client-1") {
  return {
    targetId: id,
    title: `页面 ${id}`,
    url: `https://example.com/${id}`,
    groupId: "default",
    ownerId,
    ownerName: ownerId ? "测试设备" : null,
    viewerCount: 1,
  };
}

async function showTargets(socket: FakeSocket, targets: ReturnType<typeof target>[], activeId = targets[0]?.targetId) {
  await act(async () => {
    socket.message({
      type: "state",
      targets,
      clients: [{ clientId: "client-1", clientName: "测试设备" }],
      groups: [{
        id: "default",
        name: "默认工作区",
        color: "#d9ff43",
        ownerId: targets[0]?.ownerId || null,
        ownerName: targets[0]?.ownerName || null,
        targetCount: targets.length,
        deletable: false,
      }],
    });
    if (activeId) socket.message({ type: "viewing", targetId: activeId });
  });
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      readText: vi.fn(async () => "本机文本"),
      writeText: vi.fn(async () => {}),
    },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("startup restoration", () => {
  test("automatically connects the most recent profile and activates it only after authentication", async () => {
    const store = storeWith();
    render(<RemoteBrowser connectionStore={store} />);
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    expect(screen.getByText("正在恢复网关连接")).toBeInTheDocument();
    expect(store.activate).not.toHaveBeenCalled();

    await act(async () => {
      FakeSocket.instances[0].open();
      FakeSocket.instances[0].message({ type: "ready", protocol: 2, clientId: "client-1", clientName: "测试设备", capabilities: ["binaryFrames"] });
    });
    await waitFor(() => expect(store.activate).toHaveBeenCalledWith("profile-1"));
  });

  test("does not open duplicate sockets under Strict Mode", async () => {
    render(<StrictMode><RemoteBrowser connectionStore={storeWith()} /></StrictMode>);
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
  });

  test("opens a clean new-profile settings screen when there is no history", async () => {
    render(<RemoteBrowser connectionStore={storeWith([])} />);
    expect(await screen.findByRole("dialog", { name: "客户端设置" })).toBeInTheDocument();
    expect(screen.getByText("尚未添加网关")).toBeInTheDocument();
    expect(FakeSocket.instances).toHaveLength(0);
  });

  test("keeps reconnecting after a transient close and lets the user stop", async () => {
    const socket = await online(storeWith());
    await act(async () => socket.close(1006, "network lost"));
    expect(screen.getByText("正在恢复网关连接")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "停止重连" }));
    expect(screen.getByText("网关连接已停止")).toBeInTheDocument();
  });

  test("opens the affected profile when its token is missing", async () => {
    render(<RemoteBrowser connectionStore={storeWith([savedProfile({ token: "" })])} />);
    expect(await screen.findByRole("dialog", { name: "客户端设置" })).toBeInTheDocument();
    expect(screen.getByText("请填写网关地址、访问令牌和本设备名称。")).toBeInTheDocument();
    expect(FakeSocket.instances).toHaveLength(0);
  });

  test("stops retrying and opens settings after authentication is rejected", async () => {
    render(<RemoteBrowser connectionStore={storeWith()} />);
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    await act(async () => {
      FakeSocket.instances[0].open();
      FakeSocket.instances[0].close(4001, "invalid token");
    });
    expect(await screen.findByRole("dialog", { name: "客户端设置" })).toBeInTheDocument();
    expect(screen.getByText("访问令牌无效")).toBeInTheDocument();
    expect(FakeSocket.instances).toHaveLength(1);
  });
});

describe("gateway settings", () => {
  test("places general settings before gateway settings", async () => {
    render(<RemoteBrowser connectionStore={storeWith([])} />);
    await screen.findByRole("dialog", { name: "客户端设置" });
    const navigation = screen.getByRole("navigation", { name: "设置分类" });
    expect(
      [...navigation.querySelectorAll("button")].map((button) => button.textContent),
    ).toEqual(["通用设置", "网关配置"]);
  });

  test("rejects a device name longer than the protocol limit", async () => {
    const store = storeWith([]);
    render(<RemoteBrowser connectionStore={store} />);
    await screen.findByRole("dialog", { name: "客户端设置" });
    fillConnectionForm();
    fireEvent.change(screen.getByRole("textbox", { name: "本设备名称" }), {
      target: { value: "设".repeat(41) },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(screen.getByText("本设备名称不能超过 40 个字符。")).toBeInTheDocument();
    expect(store.save).not.toHaveBeenCalled();
  });

  test("validates and saves a profile without changing the recent gateway", async () => {
    const store = storeWith([]);
    render(<RemoteBrowser connectionStore={store} />);
    await screen.findByRole("dialog", { name: "客户端设置" });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(screen.getByText("请填写网关地址、访问令牌和本设备名称。")).toBeInTheDocument();

    fillConnectionForm();
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(store.save).toHaveBeenCalledWith(expect.objectContaining({ label: "办公室网关", gatewayUrl: "ws://192.168.1.20:8788" })));
    expect(store.activate).not.toHaveBeenCalled();
    expect(FakeSocket.instances).toHaveLength(0);
  });

  test("saves and connects a new gateway, activating it after ready", async () => {
    const store = storeWith([]);
    render(<RemoteBrowser connectionStore={store} />);
    await screen.findByRole("dialog", { name: "客户端设置" });
    fillConnectionForm();
    fireEvent.click(screen.getByRole("button", { name: "保存并连接" }));
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    const socket = FakeSocket.instances[0];
    await act(async () => {
      socket.open();
      socket.message({ type: "ready", protocol: 2, clientId: "client-1", clientName: "MacBook", capabilities: ["binaryFrames"] });
    });
    await waitFor(() => expect(store.activate).toHaveBeenCalled());
    expect(screen.queryByRole("dialog", { name: "客户端设置" })).not.toBeInTheDocument();
  });

  test("switches from the connected gateway to another saved profile", async () => {
    const second = savedProfile({ id: "profile-2", label: "备用网关", gatewayUrl: "ws://192.168.1.30:8788" });
    const store = storeWith([savedProfile(), second]);
    const firstSocket = await online(store);
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    fireEvent.click(screen.getByRole("button", { name: /备用网关/ }));
    fireEvent.click(screen.getByRole("button", { name: "保存并连接" }));
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(2));
    expect(firstSocket.readyState).toBe(FakeSocket.CLOSED);
    const secondSocket = FakeSocket.instances[1];
    await act(async () => {
      secondSocket.open();
      secondSocket.message({ type: "ready", protocol: 2, clientId: "client-2", clientName: "测试设备", capabilities: ["binaryFrames"] });
    });
    await waitFor(() => expect(store.activate).toHaveBeenLastCalledWith("profile-2"));
  });

  test("deletes the connected profile with in-app confirmation and keeps settings open", async () => {
    const store = storeWith();
    await online(store);
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    fireEvent.click(screen.getByRole("button", { name: "删除配置" }));
    expect(screen.getByRole("alertdialog", { name: "删除“测试网关”？" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(store.remove).toHaveBeenCalledWith("profile-1"));
    expect(screen.getByRole("dialog", { name: "客户端设置" })).toBeInTheDocument();
    expect(screen.getByText("还没有保存的网关。")).toBeInTheDocument();
  });

  test("persists a global default page and uses it for new pages", async () => {
    const store = storeWith();
    const socket = await online(store);
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    fireEvent.click(screen.getByRole("button", { name: "通用设置" }));
    fireEvent.change(screen.getByRole("textbox", { name: "新页面默认地址" }), { target: { value: "https://example.com/start" } });
    fireEvent.click(screen.getByRole("button", { name: "保存通用设置" }));
    await waitFor(() => expect(localStorage.getItem("relaydeck.settings.v1")).toContain("https://example.com/start"));
    fireEvent.click(screen.getByRole("button", { name: "关闭设置" }));
    fireEvent.click(screen.getByRole("button", { name: "新建页面" }));
    expect(socket.sent.map((value) => JSON.parse(value))).toContainEqual(expect.objectContaining({ type: "create", url: "https://example.com/start" }));
  });
});

test("normalizes only HTTP and HTTPS default page addresses", () => {
  expect(normalizeDefaultPageUrl("  ")).toBe("");
  expect(normalizeDefaultPageUrl("https://example.com/start")).toBe("https://example.com/start");
  expect(() => normalizeDefaultPageUrl("ftp://example.com")).toThrow(/http:\/\//);
});

describe("browser shortcuts", () => {
  test("removes clipboard buttons while keeping keyboard copy and paste", async () => {
    const socket = await online(storeWith());
    await showTargets(socket, [target("one")]);
    expect(screen.queryByRole("button", { name: "复制出来" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "粘贴进去" })).not.toBeInTheDocument();

    socket.sent = [];
    const canvas = screen.getByLabelText("远程浏览器画面");
    fireEvent.keyDown(canvas, { key: "c", code: "KeyC", ctrlKey: true });
    fireEvent.keyDown(canvas, { key: "v", code: "KeyV", ctrlKey: true });
    await waitFor(() => expect(socket.sent.map((value) => JSON.parse(value))).toEqual([
      { type: "clipboard", action: "copy", targetId: "one" },
      { type: "clipboard", action: "paste", targetId: "one", text: "本机文本" },
    ]));
  });

  test("handles new, location, reload, and history shortcuts without forwarding key input", async () => {
    const socket = await online(storeWith());
    await showTargets(socket, [target("one")]);
    socket.sent = [];

    fireEvent.keyDown(window, { key: "t", ctrlKey: true });
    fireEvent.keyDown(window, { key: "r", metaKey: true });
    fireEvent.keyDown(window, { key: "F5" });
    fireEvent.keyDown(window, { key: "ArrowLeft", altKey: true });
    fireEvent.keyDown(window, { key: "]", metaKey: true });
    fireEvent.keyDown(window, { key: "l", ctrlKey: true });

    const messages = socket.sent.map((value) => JSON.parse(value));
    expect(messages).toContainEqual(expect.objectContaining({ type: "create", groupId: "default" }));
    expect(messages.filter((message) => message.type === "command")).toEqual([
      { type: "command", targetId: "one", command: "reload" },
      { type: "command", targetId: "one", command: "reload" },
      { type: "command", targetId: "one", command: "back" },
      { type: "command", targetId: "one", command: "forward" },
    ]);
    expect(messages.some((message) => message.type === "input")).toBe(false);
    expect(screen.getByRole("textbox", { name: "页面地址" })).toHaveFocus();
  });

  test("prevents viewers from creating tabs in an occupied group", async () => {
    const socket = await online(storeWith());
    await showTargets(socket, [target("one", "client-2")]);
    socket.sent = [];

    expect(screen.getByRole("button", { name: "在当前分组新建页面" })).toBeDisabled();
    fireEvent.keyDown(window, { key: "t", ctrlKey: true });

    expect(socket.sent.map((value) => JSON.parse(value))).not.toContainEqual(
      expect.objectContaining({ type: "create" }),
    );
    expect(screen.getByText("请先取得当前分组控制权，再新建页面。")).toBeInTheDocument();
  });

  test("cycles tabs with Windows and macOS shortcut families", async () => {
    const socket = await online(storeWith());
    await showTargets(socket, [target("one"), target("two"), target("three")], "one");
    socket.sent = [];

    fireEvent.keyDown(window, { key: "Tab", ctrlKey: true });
    fireEvent.keyDown(window, { key: "Tab", ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: "ArrowRight", metaKey: true, altKey: true });
    fireEvent.keyDown(window, { key: "[", metaKey: true, shiftKey: true });

    expect(socket.sent.map((value) => JSON.parse(value))).toEqual([
      { type: "view", targetId: "two" },
      { type: "view", targetId: "one" },
      { type: "view", targetId: "two" },
      { type: "view", targetId: "one" },
    ]);
  });

  test("closes the active tab and selects its nearest remaining neighbor", async () => {
    const socket = await online(storeWith());
    const first = target("one");
    const second = target("two");
    await showTargets(socket, [first, second], "one");
    socket.sent = [];

    fireEvent.keyDown(window, { key: "w", metaKey: true });
    expect(socket.sent.map((value) => JSON.parse(value))).toContainEqual({ type: "close", targetId: "one" });
    await showTargets(socket, [second], undefined);
    expect(socket.sent.map((value) => JSON.parse(value))).toContainEqual({ type: "view", targetId: "two" });
    expect(screen.getByRole("textbox", { name: "页面地址" })).toHaveValue(second.url);

    socket.sent = [];
    fireEvent.keyDown(window, { key: "w", ctrlKey: true });
    await showTargets(socket, [], undefined);
    expect(screen.getByText("选择一个共享窗口")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "页面地址" })).toHaveValue("");
  });

  test("blocks page shortcuts in dialogs and rejects owner-only actions in read-only mode", async () => {
    const socket = await online(storeWith());
    await showTargets(socket, [target("one", "another-client")]);
    socket.sent = [];
    fireEvent.keyDown(window, { key: "w", ctrlKey: true });
    expect(socket.sent.map((value) => JSON.parse(value))).not.toContainEqual(expect.objectContaining({ type: "close" }));
    expect(screen.getByText("请先取得当前分组控制权，再操作页面。")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    socket.sent = [];
    fireEvent.keyDown(window, { key: "t", ctrlKey: true });
    fireEvent.keyDown(window, { key: "F5" });
    expect(socket.sent).toHaveLength(0);
  });
});

describe("online members and control approval", () => {
  test("shows online devices and the groups they control", async () => {
    const socket = await online(storeWith());
    await act(async () => socket.message({
      type: "state",
      targets: [target("one")],
      clients: [
        { clientId: "client-1", clientName: "测试设备" },
        { clientId: "client-2", clientName: "同事的电脑" },
      ],
      groups: [{ id: "default", name: "默认工作区", color: "#d9ff43", ownerId: "client-2", ownerName: "同事的电脑", targetCount: 1, deletable: false }],
    }));
    const members = screen.getByRole("region", { name: "在线成员" });
    expect(members).toHaveTextContent("测试设备（本机）");
    expect(members).toHaveTextContent("同事的电脑");
    expect(members).toHaveTextContent("正在控制：默认工作区");
  });

  test("requests occupied control and waits for the current owner", async () => {
    const socket = await online(storeWith());
    await showTargets(socket, [target("one", "client-2")]);
    socket.sent = [];
    fireEvent.click(screen.getByRole("button", { name: "申请控制" }));
    expect(socket.sent.map((value) => JSON.parse(value))).toContainEqual({ type: "claim", targetId: "one" });
    await act(async () => socket.message({
      type: "claim:pending",
      requestId: "request-1",
      groupId: "default",
      ownerName: "同事的电脑",
      expiresAt: Date.now() + 30_000,
    }));
    expect(screen.getByRole("button", { name: "等待 同事的电脑 同意…" })).toBeDisabled();
  });

  test("lets the current owner approve a control request", async () => {
    const socket = await online(storeWith());
    await showTargets(socket, [target("one")]);
    socket.sent = [];
    await act(async () => socket.message({
      type: "claim:requested",
      request: {
        requestId: "request-1",
        groupId: "default",
        groupName: "默认工作区",
        requesterId: "client-2",
        requesterName: "同事的电脑",
        expiresAt: Date.now() + 30_000,
      },
    }));
    expect(screen.getByRole("alertdialog", { name: "控制权申请" })).toHaveTextContent("同事的电脑");
    fireEvent.click(screen.getByRole("button", { name: "同意并移交" }));
    expect(socket.sent.map((value) => JSON.parse(value))).toContainEqual({
      type: "claim:respond",
      requestId: "request-1",
      approved: true,
    });
  });
});

test("creates groups with acknowledgement and clears recovered Chrome errors", async () => {
  const socket = await online(storeWith());
  fireEvent.click(screen.getAllByRole("button", { name: "创建分组" }).at(-1)!);
  fireEvent.change(screen.getByRole("textbox", { name: "分组名称" }), { target: { value: "资料" } });
  fireEvent.click(screen.getAllByRole("button", { name: "创建分组" }).at(-1)!);
  expect(screen.getByRole("button", { name: "正在创建…" })).toBeDisabled();
  expect(socket.sent.map((value) => JSON.parse(value))).toContainEqual({ type: "group:create", name: "资料" });

  await act(async () => {
    socket.message({ type: "group:created", groupId: "group-1" });
    socket.message({ type: "chrome", connected: false, message: "Chrome 暂时不可用" });
  });
  expect(screen.queryByRole("dialog", { name: "创建分组" })).not.toBeInTheDocument();
  expect(screen.getByText("Chrome 暂时不可用")).toBeInTheDocument();
  await act(async () => socket.message({ type: "chrome", connected: true }));
  expect(screen.queryByText("Chrome 暂时不可用")).not.toBeInTheDocument();
});

test("clears a closed active page and returns to a clean idle screen", async () => {
  const socket = await online(storeWith());
  const target = { targetId: "target-1", title: "Example", url: "https://example.com/", groupId: "default", ownerId: "client-1", ownerName: "测试设备", viewerCount: 1 };
  await act(async () => {
    socket.message({ type: "state", targets: [target], groups: [{ id: "default", name: "默认工作区", color: "#d9ff43", ownerId: "client-1", ownerName: "测试设备", targetCount: 1, deletable: false }] });
    socket.message({ type: "viewing", targetId: "target-1" });
  });
  fireEvent.click(screen.getByText("Example").closest("button")!);
  expect(screen.getByRole("textbox", { name: "页面地址" })).toHaveValue("https://example.com/");
  await act(async () => socket.message({ type: "state", targets: [], groups: [{ id: "default", name: "默认工作区", color: "#d9ff43", ownerId: null, ownerName: null, targetCount: 0, deletable: false }] }));
  expect(screen.getByRole("textbox", { name: "页面地址" })).toHaveValue("");
  expect(screen.queryByText("画面已同步")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "断开此设备" }));
  expect(await screen.findByRole("button", { name: "重新连接" })).toBeEnabled();
});

test("keeps group deletion pending until gateway state confirms it", async () => {
  const socket = await online(storeWith());
  await act(async () => socket.message({ type: "state", targets: [], groups: [
    { id: "default", name: "默认工作区", color: "#d9ff43", ownerId: null, ownerName: null, targetCount: 0, deletable: false },
    { id: "group-1", name: "资料", color: "#ff7047", ownerId: "client-1", ownerName: "测试设备", targetCount: 0, deletable: true },
  ] }));
  fireEvent.change(screen.getByRole("combobox", { name: "选择标签页分组" }), { target: { value: "group-1" } });
  fireEvent.click(screen.getByRole("button", { name: "删除当前分组" }));
  fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
  expect(screen.getByRole("button", { name: "正在删除…" })).toBeDisabled();
  await act(async () => socket.message({ type: "state", targets: [], groups: [{ id: "default", name: "默认工作区", color: "#d9ff43", ownerId: null, ownerName: null, targetCount: 0, deletable: false }] }));
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
});
