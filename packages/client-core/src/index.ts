import {
  PROTOCOL_VERSION,
  decodeBinaryFrame,
  type BinaryFrame,
  type ClientMessage,
  type ServerMessage,
} from "@relaydeck/protocol";

export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "authenticating"
  | "online"
  | "reconnecting"
  | "offline"
  | "auth-failed";

export type ConnectionSnapshot = {
  status: ConnectionStatus;
  attempt: number;
  error: string;
};

export type ConnectionOptions = {
  url: string;
  token: string;
  name: string;
  reconnect?: boolean;
};

type WebSocketLike = Pick<
  WebSocket,
  | "readyState"
  | "binaryType"
  | "send"
  | "close"
  | "addEventListener"
  | "removeEventListener"
>;

type WebSocketFactory = (url: string) => WebSocketLike;

type TimerApi = {
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(timer: unknown): void;
};

const defaultTimer: TimerApi = {
  setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeout: (timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export function normalizeGatewayUrl(value: string): string {
  let candidate = value.trim();
  if (!candidate) throw new Error("请输入网关地址");
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(candidate)) candidate = `ws://${candidate}`;
  const url = new URL(candidate);
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("网关地址必须使用 ws:// 或 wss://");
  }
  if (url.username || url.password) throw new Error("网关地址不能包含用户名或密码");
  url.hash = "";
  url.search = "";
  if (url.pathname === "/") url.pathname = "";
  return url.toString().replace(/\/$/, "");
}

export class RelayConnection {
  private socket: WebSocketLike | null = null;
  private generation = 0;
  private stopped = true;
  private reconnectTimer: unknown = null;
  private attempt = 0;
  private snapshot: ConnectionSnapshot = { status: "idle", attempt: 0, error: "" };
  private readonly stateListeners = new Set<(snapshot: ConnectionSnapshot) => void>();
  private readonly messageListeners = new Set<(message: ServerMessage) => void>();
  private readonly frameListeners = new Set<(frame: BinaryFrame) => void>();

  constructor(
    private readonly options: ConnectionOptions,
    private readonly socketFactory: WebSocketFactory = (url) => new WebSocket(url),
    private readonly timer: TimerApi = defaultTimer,
  ) {
    this.options = { ...options, url: normalizeGatewayUrl(options.url) };
  }

  get state(): ConnectionSnapshot {
    return { ...this.snapshot };
  }

  onState(listener: (snapshot: ConnectionSnapshot) => void): () => void {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => this.stateListeners.delete(listener);
  }

  onMessage(listener: (message: ServerMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onFrame(listener: (frame: BinaryFrame) => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  connect(): void {
    this.stopped = false;
    this.attempt = 0;
    this.clearReconnect();
    this.open(false);
  }

  disconnect(): void {
    this.stopped = true;
    this.generation += 1;
    this.clearReconnect();
    this.socket?.close(1000, "client disconnect");
    this.socket = null;
    this.update({ status: "idle", attempt: this.attempt, error: "" });
  }

  send(message: Exclude<ClientMessage, { type: "hello" }>): boolean {
    if (this.snapshot.status !== "online" || this.socket?.readyState !== WebSocket.OPEN) {
      return false;
    }
    this.socket.send(JSON.stringify(message));
    return true;
  }

  private open(reconnecting: boolean): void {
    const generation = ++this.generation;
    this.update({
      status: reconnecting ? "reconnecting" : "connecting",
      attempt: this.attempt,
      error: "",
    });
    let socket: WebSocketLike;
    try {
      socket = this.socketFactory(this.options.url);
    } catch (error) {
      this.handleUnavailable(generation, error instanceof Error ? error.message : "无法创建连接");
      return;
    }
    socket.binaryType = "arraybuffer";
    this.socket = socket;

    const active = () => !this.stopped && generation === this.generation && this.socket === socket;
    socket.addEventListener("open", () => {
      if (!active()) return;
      this.update({ status: "authenticating", attempt: this.attempt, error: "" });
      socket.send(
        JSON.stringify({
          type: "hello",
          protocol: PROTOCOL_VERSION,
          token: this.options.token,
          name: this.options.name,
          capabilities: ["binaryFrames"],
        }),
      );
    });
    socket.addEventListener("message", (event) => {
      if (!active()) return;
      void this.handleMessage((event as MessageEvent).data);
    });
    socket.addEventListener("close", (event) => {
      if (!active()) return;
      this.socket = null;
      const closeEvent = event as CloseEvent;
      if (closeEvent.code === 4001 || closeEvent.code === 4002) {
        this.stopped = true;
        this.update({
          status: "auth-failed",
          attempt: this.attempt,
          error: closeEvent.code === 4001 ? "访问令牌无效" : "客户端协议不受支持",
        });
        return;
      }
      this.handleUnavailable(generation, "网关连接已断开");
    });
    socket.addEventListener("error", () => {
      if (!active()) return;
      this.update({ ...this.snapshot, error: "无法连接网关" });
    });
  }

  private async handleMessage(data: unknown): Promise<void> {
    if (data instanceof ArrayBuffer) {
      this.emitFrame(decodeBinaryFrame(data));
      return;
    }
    if (ArrayBuffer.isView(data)) {
      const view = data as ArrayBufferView;
      this.emitFrame(
        decodeBinaryFrame(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)),
      );
      return;
    }
    if (typeof Blob !== "undefined" && data instanceof Blob) {
      this.emitFrame(decodeBinaryFrame(await data.arrayBuffer()));
      return;
    }
    if (typeof data !== "string") return;
    let message: ServerMessage;
    try {
      message = JSON.parse(data) as ServerMessage;
    } catch {
      return;
    }
    if (message.type === "ready") {
      this.attempt = 0;
      this.update({ status: "online", attempt: 0, error: "" });
    }
    for (const listener of this.messageListeners) listener(message);
  }

  private emitFrame(frame: BinaryFrame): void {
    for (const listener of this.frameListeners) listener(frame);
  }

  private handleUnavailable(generation: number, message: string): void {
    if (this.stopped || generation !== this.generation) return;
    if (this.options.reconnect === false) {
      this.stopped = true;
      this.update({ status: "offline", attempt: this.attempt, error: message });
      return;
    }
    this.attempt += 1;
    const delay = Math.min(15_000, 500 * 2 ** Math.min(this.attempt - 1, 5));
    this.update({ status: "reconnecting", attempt: this.attempt, error: message });
    this.clearReconnect();
    this.reconnectTimer = this.timer.setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.open(true);
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) {
      this.timer.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private update(snapshot: ConnectionSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.stateListeners) listener(this.state);
  }
}
