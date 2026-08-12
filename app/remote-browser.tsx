"use client";

import {
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type Target = {
  targetId: string;
  title: string;
  url: string;
  groupId: string;
  ownerId: string | null;
  ownerName: string | null;
  viewerCount: number;
};

type Group = {
  id: string;
  name: string;
  color: string;
  ownerId: string | null;
  ownerName: string | null;
  targetCount: number;
  deletable: boolean;
};

type FrameMetadata = {
  deviceWidth?: number;
  deviceHeight?: number;
};

type ServerMessage =
  | { type: "ready"; clientId: string; clientName: string }
  | { type: "state"; targets: Target[]; groups: Group[] }
  | { type: "group:created"; groupId: string }
  | { type: "viewing"; targetId: string }
  | { type: "clipboard:text"; text: string }
  | {
      type: "frame";
      targetId: string;
      data: string;
      metadata: FrameMetadata;
    }
  | { type: "error"; message: string }
  | { type: "chrome"; connected: boolean; message?: string };

type ConnectionState = "setup" | "connecting" | "online" | "offline";

const KEY_CODES: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Escape: 27,
  Space: 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
};

function hostGatewayUrl() {
  if (typeof window === "undefined") return "ws://127.0.0.1:8788";
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${window.location.hostname}:8788`;
}

function compactUrl(value: string) {
  try {
    const parsed = new URL(value);
    return `${parsed.hostname}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return value;
  }
}

async function writeLocalClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("copy failed");
}

export function RemoteBrowser() {
  const [connection, setConnection] = useState<ConnectionState>("setup");
  const [gatewayUrl, setGatewayUrl] = useState("");
  const [token, setToken] = useState("");
  const [clientName, setClientName] = useState("");
  const [clientId, setClientId] = useState("");
  const [chromeConnected, setChromeConnected] = useState(false);
  const [targets, setTargets] = useState<Target[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState("default");
  const [activeTargetId, setActiveTargetId] = useState<string | null>(null);
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  const [frameInfo, setFrameInfo] = useState<FrameMetadata>({});
  const [lastFrameAt, setLastFrameAt] = useState(0);

  const socketRef = useRef<WebSocket | null>(null);
  const activeTargetRef = useRef<string | null>(null);
  const selectedGroupRef = useRef("default");
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const canvasWrapRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const latestFrameRef = useRef<string | null>(null);
  const drawPendingRef = useRef(false);
  const wheelTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wheelDeltaRef = useRef({ x: 0, y: 0 });

  const activeTarget = useMemo(
    () => targets.find((target) => target.targetId === activeTargetId) ?? null,
    [activeTargetId, targets],
  );
  const activeGroup = useMemo(
    () => groups.find((group) => group.id === selectedGroupId) ?? null,
    [groups, selectedGroupId],
  );
  const visibleTargets = useMemo(
    () => targets.filter((target) => target.groupId === selectedGroupId),
    [selectedGroupId, targets],
  );
  const isOwner = activeTarget?.ownerId === clientId;

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setGatewayUrl(
        sessionStorage.getItem("relaydeck.gateway") || hostGatewayUrl(),
      );
      setToken(sessionStorage.getItem("relaydeck.token") || "");
      setClientName(
        sessionStorage.getItem("relaydeck.name") ||
          `设备-${Math.floor(100 + Math.random() * 900)}`,
      );
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    activeTargetRef.current = activeTargetId;
  }, [activeTargetId]);

  useEffect(() => {
    selectedGroupRef.current = selectedGroupId;
  }, [selectedGroupId]);

  const send = useCallback((message: Record<string, unknown>) => {
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }, []);

  useEffect(() => {
    const canvasWrap = canvasWrapRef.current;
    if (!canvasWrap || !activeTargetId || !isOwner) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const syncViewport = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const bounds = canvasWrap.getBoundingClientRect();
        send({
          type: "viewport",
          targetId: activeTargetId,
          width: Math.floor(bounds.width - 36),
          height: Math.floor(bounds.height - 36),
        });
      }, 80);
    };
    const observer = new ResizeObserver(syncViewport);
    observer.observe(canvasWrap);
    syncViewport();
    return () => {
      observer.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [activeTargetId, isOwner, send]);

  const drawFrame = useCallback((data: string) => {
    latestFrameRef.current = data;
    if (drawPendingRef.current) return;
    drawPendingRef.current = true;

    requestAnimationFrame(() => {
      drawPendingRef.current = false;
      const nextFrame = latestFrameRef.current;
      const canvas = canvasRef.current;
      if (!nextFrame || !canvas) return;

      let image = imageRef.current;
      if (!image) {
        image = new Image();
        imageRef.current = image;
      }
      image.onload = () => {
        const currentCanvas = canvasRef.current;
        if (!currentCanvas || !image) return;
        currentCanvas.width = image.naturalWidth;
        currentCanvas.height = image.naturalHeight;
        const context = currentCanvas.getContext("2d", { alpha: false });
        context?.drawImage(image, 0, 0);
        setLastFrameAt(Date.now());
      };
      image.src = `data:image/jpeg;base64,${nextFrame}`;
    });
  }, []);

  const disconnect = useCallback(() => {
    socketRef.current?.close();
    socketRef.current = null;
    setConnection("offline");
    setClientId("");
    setActiveTargetId(null);
    setTargets([]);
    setGroups([]);
  }, []);

  const connect = useCallback(() => {
    if (!gatewayUrl.trim() || !token.trim() || !clientName.trim()) {
      setError("请填写网关地址、访问令牌和设备名称。");
      return;
    }

    disconnect();
    setError("");
    setConnection("connecting");

    let url: URL;
    try {
      url = new URL(gatewayUrl.trim());
    } catch {
      setConnection("offline");
      setError("网关地址格式不正确。");
      return;
    }
    url.searchParams.set("token", token.trim());
    url.searchParams.set("name", clientName.trim());
    const socket = new WebSocket(url);
    socketRef.current = socket;

    socket.addEventListener("open", () => {
      sessionStorage.setItem("relaydeck.gateway", gatewayUrl.trim());
      sessionStorage.setItem("relaydeck.token", token.trim());
      sessionStorage.setItem("relaydeck.name", clientName.trim());
      setConnection("online");
    });

    socket.addEventListener("message", (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }

      if (message.type === "ready") {
        setClientId(message.clientId);
      } else if (message.type === "state") {
        setTargets(message.targets);
        setGroups(message.groups);
        if (
          !message.groups.some(
            (group) => group.id === selectedGroupRef.current,
          )
        ) {
          selectedGroupRef.current = "default";
          setSelectedGroupId("default");
        }
        const viewed = message.targets.find(
          (target) => target.targetId === activeTargetRef.current,
        );
        if (viewed) setAddress(viewed.url);
      } else if (message.type === "group:created") {
        selectedGroupRef.current = message.groupId;
        setSelectedGroupId(message.groupId);
      } else if (message.type === "viewing") {
        activeTargetRef.current = message.targetId;
        setActiveTargetId(message.targetId);
      } else if (message.type === "clipboard:text") {
        if (!message.text) {
          setError("远端页面中没有检测到选中的文本。");
          return;
        }
        void writeLocalClipboard(message.text).catch(() => {
          setError("浏览器拒绝写入本机剪贴板，请允许剪贴板权限。");
        });
      } else if (message.type === "frame") {
        if (
          message.targetId === activeTargetRef.current ||
          !activeTargetRef.current
        ) {
          setFrameInfo(message.metadata);
          drawFrame(message.data);
        }
      } else if (message.type === "chrome") {
        setChromeConnected(message.connected);
        if (message.message) setError(message.message);
      } else if (message.type === "error") {
        setError(message.message);
      }
    });

    socket.addEventListener("close", (event) => {
      if (socketRef.current === socket) {
        setConnection("offline");
        setChromeConnected(false);
        if (event.code === 4001) setError("访问令牌无效。");
      }
    });

    socket.addEventListener("error", () => {
      setError("无法连接网关，请确认本地服务已经启动。");
    });
  }, [clientName, disconnect, drawFrame, gatewayUrl, token]);

  const openTarget = (targetId: string) => {
    activeTargetRef.current = targetId;
    setActiveTargetId(targetId);
    const nextTarget = targets.find((target) => target.targetId === targetId);
    if (nextTarget) setAddress(nextTarget.url);
    send({ type: "view", targetId });
    requestAnimationFrame(() => canvasRef.current?.focus());
  };

  const createTarget = () => {
    send({
      type: "create",
      url: "https://ac.nowcoder.com/",
      groupId: selectedGroupId,
      afterTargetId:
        activeTarget?.groupId === selectedGroupId
          ? activeTarget.targetId
          : undefined,
    });
  };

  const selectGroup = (groupId: string) => {
    selectedGroupRef.current = groupId;
    setSelectedGroupId(groupId);
    const firstTarget = targets.find((target) => target.groupId === groupId);
    if (firstTarget) {
      openTarget(firstTarget.targetId);
    } else {
      activeTargetRef.current = null;
      setActiveTargetId(null);
    }
  };

  const createGroup = () => {
    const name = window.prompt("新分组名称");
    if (!name?.trim()) return;
    send({ type: "group:create", name: name.trim() });
  };

  const deleteGroup = () => {
    if (!activeGroup?.deletable) return;
    const confirmed = window.confirm(
      `删除“${activeGroup.name}”？组内标签页会保留并移入默认工作区。`,
    );
    if (confirmed) {
      send({ type: "group:delete", groupId: activeGroup.id });
    }
  };

  const closeTarget = (target: Target) => {
    if (target.ownerId !== clientId) {
      setError("请先取得该分组控制权，再关闭标签页。");
      return;
    }
    send({ type: "close", targetId: target.targetId });
  };

  const navigate = (event: FormEvent) => {
    event.preventDefault();
    if (!activeTargetId || !isOwner) return;
    let nextUrl = address.trim();
    if (!/^https?:\/\//i.test(nextUrl)) nextUrl = `https://${nextUrl}`;
    send({ type: "navigate", targetId: activeTargetId, url: nextUrl });
  };

  const copyFromRemote = () => {
    if (!activeTargetId || !isOwner) return;
    send({
      type: "clipboard",
      action: "copy",
      targetId: activeTargetId,
    });
  };

  const pasteToRemote = async () => {
    if (!activeTargetId || !isOwner) return;
    let text = "";
    try {
      text = await navigator.clipboard.readText();
    } catch {
      text = window.prompt("粘贴要发送到远端页面的文本") || "";
    }
    if (!text) return;
    send({
      type: "clipboard",
      action: "paste",
      targetId: activeTargetId,
      text,
    });
  };

  const coordinateFor = (event: ReactMouseEvent | ReactWheelEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const bounds = canvas.getBoundingClientRect();
    const width = frameInfo.deviceWidth || canvas.width || bounds.width;
    const height = frameInfo.deviceHeight || canvas.height || bounds.height;
    return {
      x: ((event.clientX - bounds.left) / bounds.width) * width,
      y: ((event.clientY - bounds.top) / bounds.height) * height,
    };
  };

  const mouse = (
    type: "mousePressed" | "mouseReleased" | "mouseMoved",
    event: ReactMouseEvent<HTMLCanvasElement>,
  ) => {
    if (!activeTargetId || !isOwner) return;
    const point = coordinateFor(event);
    const button =
      event.button === 2 ? "right" : event.button === 1 ? "middle" : "left";
    send({
      type: "input",
      targetId: activeTargetId,
      method: "mouse",
      eventType: type,
      ...point,
      button: type === "mouseMoved" ? "none" : button,
      buttons: event.buttons,
      clickCount: type === "mousePressed" ? event.detail || 1 : 0,
    });
  };

  const wheel = (event: ReactWheelEvent<HTMLCanvasElement>) => {
    if (!activeTargetId || !isOwner) return;
    event.preventDefault();
    wheelDeltaRef.current.x += event.deltaX;
    wheelDeltaRef.current.y += event.deltaY;
    const point = coordinateFor(event);
    if (wheelTimerRef.current) return;
    wheelTimerRef.current = setTimeout(() => {
      wheelTimerRef.current = null;
      send({
        type: "input",
        targetId: activeTargetId,
        method: "wheel",
        ...point,
        deltaX: wheelDeltaRef.current.x,
        deltaY: wheelDeltaRef.current.y,
      });
      wheelDeltaRef.current = { x: 0, y: 0 };
    }, 20);
  };

  const keyboard = (event: ReactKeyboardEvent<HTMLCanvasElement>) => {
    if (!activeTargetId || !isOwner || event.key === "F5") return;
    event.preventDefault();
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") {
      copyFromRemote();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") {
      void pasteToRemote();
      return;
    }
    const modifiers =
      (event.altKey ? 1 : 0) |
      (event.ctrlKey ? 2 : 0) |
      (event.metaKey ? 4 : 0) |
      (event.shiftKey ? 8 : 0);
    const keyCode =
      KEY_CODES[event.key] ||
      (event.key.length === 1 ? event.key.toUpperCase().charCodeAt(0) : 0);
    send({
      type: "input",
      targetId: activeTargetId,
      method: "key",
      eventType: "keyDown",
      key: event.key,
      code: event.code,
      text: event.key.length === 1 && !event.ctrlKey && !event.metaKey ? event.key : "",
      modifiers,
      windowsVirtualKeyCode: keyCode,
    });
    send({
      type: "input",
      targetId: activeTargetId,
      method: "key",
      eventType: "keyUp",
      key: event.key,
      code: event.code,
      text: "",
      modifiers,
      windowsVirtualKeyCode: keyCode,
    });
  };

  if (connection === "setup" || connection === "offline") {
    return (
      <main className="connect-shell">
        <section className="connect-copy">
          <div className="brand-mark">RD</div>
          <p className="eyebrow">RELAYDECK / LOCAL GATEWAY</p>
          <h1>
            一个 Chrome。
            <br />
            两台设备，各自操作。
          </h1>
          <p className="connect-lede">
            页面共享可见，输入按标签页隔离。认证状态留在服务器上的同一个
            Chrome Profile 中。
          </p>
          <div className="feature-grid">
            <div>
              <span>01</span>
              <strong>独立页面输入</strong>
              <p>每台设备绑定自己的页面目标。</p>
            </div>
            <div>
              <span>02</span>
              <strong>显式控制权</strong>
              <p>同一页面只允许一个写入者。</p>
            </div>
            <div>
              <span>03</span>
              <strong>凭证不出站</strong>
              <p>客户端只接收画面，不接收 Cookie。</p>
            </div>
          </div>
        </section>

        <section className="connect-panel">
          <div className="panel-heading">
            <span className="status-dot" />
            <div>
              <p>连接控制端</p>
              <span>需要本地网关访问令牌</span>
            </div>
          </div>
          <label>
            设备名称
            <input
              value={clientName}
              onChange={(event) => setClientName(event.target.value)}
            />
          </label>
          <label>
            网关地址
            <input
              value={gatewayUrl}
              onChange={(event) => setGatewayUrl(event.target.value)}
              placeholder="ws://127.0.0.1:8788"
            />
          </label>
          <label>
            访问令牌
            <input
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && connect()}
            />
          </label>
          {error && <p className="form-error">{error}</p>}
          <button className="primary-button" onClick={connect}>
            {connection === "offline" ? "重新连接" : "进入控制台"}
          </button>
          <p className="security-note">CDP 端口应始终只监听 127.0.0.1。</p>
        </section>
      </main>
    );
  }

  return (
    <main className="workspace-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="brand-mark small">RD</div>
          <div>
            <strong>Relaydeck</strong>
            <span>shared browser</span>
          </div>
        </div>

        <div className="connection-card">
          <span
            className={`status-dot ${chromeConnected ? "online" : "warning"}`}
          />
          <div>
            <strong>{chromeConnected ? "Chrome 已连接" : "等待 Chrome"}</strong>
            <span>{clientName}</span>
          </div>
        </div>

        <div className="target-heading">
          <span>共享窗口</span>
          <span>{visibleTargets.length} tabs</span>
        </div>

        <div className="group-toolbar">
          <span
            className="group-color"
            style={{ backgroundColor: activeGroup?.color || "#d9ff43" }}
          />
          <select
            value={selectedGroupId}
            onChange={(event) => selectGroup(event.target.value)}
            aria-label="选择标签页分组"
          >
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name} · {group.targetCount}
              </option>
            ))}
          </select>
          <button onClick={createGroup} aria-label="创建分组" title="创建分组">
            G+
          </button>
          <button
            onClick={deleteGroup}
            disabled={!activeGroup?.deletable}
            aria-label="删除当前分组"
            title="删除当前分组，标签页移入默认工作区"
          >
            G−
          </button>
          <button
            onClick={createTarget}
            disabled={!chromeConnected}
            aria-label="在当前分组新建页面"
            title="在当前分组新建页面"
          >
            ＋
          </button>
        </div>

        <nav className="target-list" aria-label="共享页面列表">
          {visibleTargets.map((target, index) => (
            <div
              key={target.targetId}
              className={`target-row ${
                activeTargetId === target.targetId ? "active" : ""
              }`}
            >
              <button
                className="target-item"
                onClick={() => openTarget(target.targetId)}
              >
                <span className="target-index">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="target-copy">
                  <strong>{target.title || "新标签页"}</strong>
                  <span>{compactUrl(target.url)}</span>
                </span>
                <span
                  className={`owner-light ${target.ownerId ? "claimed" : ""}`}
                />
              </button>
              <button
                className="target-close"
                onClick={() => closeTarget(target)}
                disabled={target.ownerId !== clientId}
                aria-label={`关闭 ${target.title || "标签页"}`}
                title={
                  target.ownerId === clientId
                    ? "关闭标签页"
                    : "取得分组控制权后可关闭"
                }
              >
                ×
              </button>
            </div>
          ))}
          {!visibleTargets.length && (
            <div className="empty-targets">
              当前分组还没有标签页。点击＋在这里创建第一个页面。
            </div>
          )}
        </nav>

        <div className="sidebar-footer">
          <button onClick={disconnect}>断开此设备</button>
          <span>{clientId.slice(0, 8) || "connecting"}</span>
        </div>
      </aside>

      <section className="browser-stage">
        <header className="browser-toolbar">
          <div className="nav-buttons">
            <button
              onClick={() =>
                send({
                  type: "command",
                  targetId: activeTargetId,
                  command: "back",
                })
              }
              disabled={!isOwner}
            >
              ←
            </button>
            <button
              onClick={() =>
                send({
                  type: "command",
                  targetId: activeTargetId,
                  command: "forward",
                })
              }
              disabled={!isOwner}
            >
              →
            </button>
            <button
              onClick={() =>
                send({
                  type: "command",
                  targetId: activeTargetId,
                  command: "reload",
                })
              }
              disabled={!isOwner}
            >
              ↻
            </button>
          </div>
          <form className="address-form" onSubmit={navigate}>
            <span className="secure-mark">◆</span>
            <input
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              disabled={!activeTarget}
              aria-label="页面地址"
            />
          </form>
          <div className="clipboard-actions">
            <button
              onClick={copyFromRemote}
              disabled={!isOwner}
              title="把远端选中的文本复制到本机"
            >
              复制出来
            </button>
            <button
              onClick={() => void pasteToRemote()}
              disabled={!isOwner}
              title="把本机剪贴板文本粘贴到远端焦点"
            >
              粘贴进去
            </button>
          </div>
          {activeTarget && (
            <button
              className={`claim-button ${isOwner ? "owned" : ""}`}
              onClick={() =>
                send({
                  type: isOwner ? "release" : "claim",
                  targetId: activeTarget.targetId,
                })
              }
            >
              {isOwner
                ? "释放分组"
                : activeTarget.ownerId
                  ? "接管分组"
                  : "控制此分组"}
            </button>
          )}
        </header>

        <div className="stage-meta">
          <div>
            <span className={`mode-pill ${isOwner ? "write" : ""}`}>
              {isOwner ? "可操作" : "只读观看"}
            </span>
            {activeTarget?.ownerName && !isOwner && (
              <span>当前分组由 {activeTarget.ownerName} 操作</span>
            )}
          </div>
          <div>
            {activeTarget && <span>{activeTarget.viewerCount} 个观看端</span>}
            {lastFrameAt > 0 && <span>画面已同步</span>}
          </div>
        </div>

        <div className="canvas-wrap" ref={canvasWrapRef}>
          {activeTarget ? (
            <>
              <canvas
                ref={canvasRef}
                tabIndex={0}
                className={isOwner ? "interactive" : ""}
                onMouseMove={(event) => mouse("mouseMoved", event)}
                onMouseDown={(event) => {
                  event.currentTarget.focus();
                  mouse("mousePressed", event);
                }}
                onMouseUp={(event) => mouse("mouseReleased", event)}
                onContextMenu={(event) => event.preventDefault()}
                onWheel={wheel}
                onKeyDown={keyboard}
                aria-label="远程浏览器画面"
              />
              {!isOwner && (
                <div className="readonly-banner">
                  <span>VIEW ONLY</span>
                  <p>取得分组控制权后即可操作组内全部标签页。</p>
                </div>
              )}
            </>
          ) : (
            <div className="stage-empty">
              <div className="empty-orbit">
                <span />
              </div>
              <p>选择一个共享窗口</p>
              <span>或创建新的牛客页面开始操作</span>
              <button onClick={createTarget} disabled={!chromeConnected}>
                新建页面
              </button>
            </div>
          )}
        </div>

        {error && (
          <div className="toast">
            <span>!</span>
            <p>{error}</p>
            <button onClick={() => setError("")}>×</button>
          </div>
        )}
      </section>
    </main>
  );
}
