import { WebSocket } from "ws";

export class CdpConnection {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.closedListeners = new Set();
  }

  async open() {
    const socket = new WebSocket(this.url, {
      maxPayload: 64 * 1024 * 1024,
      perMessageDeflate: false,
    });
    this.socket = socket;
    await new Promise((resolve, reject) => {
      const onOpen = () => {
        socket.off("error", onError);
        resolve();
      };
      const onError = (error) => {
        socket.off("open", onOpen);
        reject(error);
      };
      socket.once("open", onOpen);
      socket.once("error", onError);
    });

    socket.on("message", (raw) => {
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

    socket.on("close", () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error("Chrome DevTools connection closed"));
      }
      this.pending.clear();
      for (const listener of this.closedListeners) listener();
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
    return () => this.listeners.delete(listener);
  }

  onClosed(listener) {
    this.closedListeners.add(listener);
    return () => this.closedListeners.delete(listener);
  }

  close() {
    this.socket?.close();
  }
}

export async function discoverChrome(cdpHttpUrl) {
  const response = await fetch(`${cdpHttpUrl}/json/version`, {
    signal: AbortSignal.timeout(2000),
  });
  if (!response.ok) throw new Error(`CDP discovery returned ${response.status}`);
  const version = await response.json();
  if (!version.webSocketDebuggerUrl) {
    throw new Error("Chrome did not publish a browser WebSocket URL");
  }
  return version.webSocketDebuggerUrl;
}
