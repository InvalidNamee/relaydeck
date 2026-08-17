"use client";

import {
  CompositionEvent as ReactCompositionEvent,
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
import {
  RelayConnection,
  normalizeGatewayUrl,
  type ConnectionStatus,
} from "@relaydeck/client-core";
import type {
  BinaryFrame,
  ClaimRequest,
  ClientMessage,
  FrameMetadata,
  Group,
  OnlineClient,
  ServerMessage,
  Target,
} from "@relaydeck/protocol";

export type SavedConnection = {
  id: string;
  label: string;
  gatewayUrl: string;
  token: string;
  clientName: string;
};

export type ConnectionStore = {
  load(): Promise<SavedConnection[]>;
  save(value: SavedConnection): Promise<void>;
  activate(id: string): Promise<void>;
  remove(id: string): Promise<void>;
};

const PROFILES_KEY = "relaydeck.profiles.v1";
const ACTIVE_PROFILE_KEY = "relaydeck.activeProfile.v1";
const SETTINGS_KEY = "relaydeck.settings.v1";
const MAX_CLIENT_NAME_LENGTH = 40;

type ClientSettings = {
  defaultPageUrl: string;
};

type Confirmation =
  | { kind: "profile"; profileId: string; title: string; description: string }
  | { kind: "group"; title: string; description: string }
  | null;

type StoredProfile = Omit<SavedConnection, "token">;

function loadClientSettings(): ClientSettings {
  try {
    const value = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") as unknown;
    if (
      value &&
      typeof value === "object" &&
      "defaultPageUrl" in value &&
      typeof value.defaultPageUrl === "string"
    ) {
      return { defaultPageUrl: value.defaultPageUrl };
    }
  } catch {
    // Invalid settings fall back to the safe blank-page default.
  }
  return { defaultPageUrl: "" };
}

export function normalizeDefaultPageUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const url = new URL(trimmed);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("默认地址必须使用 http:// 或 https://");
  }
  return url.href;
}

function parseStoredProfiles(): StoredProfile[] {
  try {
    const value = JSON.parse(localStorage.getItem(PROFILES_KEY) || "[]") as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter(
      (profile): profile is StoredProfile =>
        Boolean(profile) &&
        typeof profile.id === "string" &&
        typeof profile.label === "string" &&
        typeof profile.gatewayUrl === "string" &&
        typeof profile.clientName === "string",
    );
  } catch {
    return [];
  }
}

function clearLegacyProfileStorage() {
  localStorage.removeItem("relaydeck.gateway");
  localStorage.removeItem("relaydeck.name");
  sessionStorage.removeItem("relaydeck.gateway");
  sessionStorage.removeItem("relaydeck.name");
  sessionStorage.removeItem("relaydeck.token");
}

const browserConnectionStore: ConnectionStore = {
  async load() {
    let profiles = parseStoredProfiles();
    if (!profiles.length && localStorage.getItem("relaydeck.gateway")) {
      profiles = [
        {
          id: "default",
          label: "默认网关",
          gatewayUrl: localStorage.getItem("relaydeck.gateway") || "",
          clientName: localStorage.getItem("relaydeck.name") || "",
        },
      ];
    }
    const activeId = localStorage.getItem(ACTIVE_PROFILE_KEY);
    profiles.sort((left, right) => Number(right.id === activeId) - Number(left.id === activeId));
    return profiles.map((profile) => ({
      ...profile,
      token: sessionStorage.getItem(`relaydeck.token.${profile.id}`) || "",
    }));
  },
  async save(value) {
    const profiles = parseStoredProfiles().filter((profile) => profile.id !== value.id);
    profiles.push({
      id: value.id,
      label: value.label,
      gatewayUrl: value.gatewayUrl,
      clientName: value.clientName,
    });
    localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles));
    sessionStorage.setItem(`relaydeck.token.${value.id}`, value.token);
    clearLegacyProfileStorage();
  },
  async activate(id) {
    localStorage.setItem(ACTIVE_PROFILE_KEY, id);
  },
  async remove(id) {
    localStorage.setItem(
      PROFILES_KEY,
      JSON.stringify(parseStoredProfiles().filter((profile) => profile.id !== id)),
    );
    sessionStorage.removeItem(`relaydeck.token.${id}`);
    clearLegacyProfileStorage();
    if (localStorage.getItem(ACTIVE_PROFILE_KEY) === id) {
      localStorage.removeItem(ACTIVE_PROFILE_KEY);
    }
  },
};

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
  if (!window.location.protocol.startsWith("http")) return "ws://127.0.0.1:8788";
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

function newConnectionProfile(): SavedConnection {
  return {
    id: crypto.randomUUID(),
    label: "新网关",
    gatewayUrl: "ws://",
    token: "",
    clientName: `设备-${Math.floor(100 + Math.random() * 900)}`,
  };
}

function validateConnectionProfile(value: SavedConnection): SavedConnection {
  if (!value.gatewayUrl.trim() || !value.token.trim() || !value.clientName.trim()) {
    throw new Error("请填写网关地址、访问令牌和本设备名称。");
  }
  if (value.token.trim().length < 32 || value.token.trim().length > 512) {
    throw new Error("网关访问令牌长度必须为 32-512 个字符。");
  }
  if (value.clientName.trim().length > MAX_CLIENT_NAME_LENGTH) {
    throw new Error(`本设备名称不能超过 ${MAX_CLIENT_NAME_LENGTH} 个字符。`);
  }
  return {
    ...value,
    label: value.label.trim() || "未命名网关",
    gatewayUrl: normalizeGatewayUrl(value.gatewayUrl),
    token: value.token.trim(),
    clientName: value.clientName.trim(),
  };
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

function SettingsDialog({
  profiles,
  draft,
  recentProfileId,
  connectedProfileId,
  connection,
  defaultPageUrl,
  error,
  pending,
  profilePending,
  onSelect,
  onNew,
  onDraftChange,
  onDefaultPageUrlChange,
  onResetDefaultPageUrl,
  onDelete,
  onClose,
  onSave,
  onSaveAndConnect,
  onSaveGeneral,
  onClearError,
}: {
  profiles: SavedConnection[];
  draft: SavedConnection;
  recentProfileId: string;
  connectedProfileId: string;
  connection: ConnectionStatus;
  defaultPageUrl: string;
  error: string;
  pending: boolean;
  profilePending: boolean;
  onSelect(value: SavedConnection): void;
  onNew(): void;
  onDraftChange(value: SavedConnection): void;
  onDefaultPageUrlChange(value: string): void;
  onResetDefaultPageUrl(): void;
  onDelete(): void;
  onClose(): void;
  onSave(): void;
  onSaveAndConnect(): void;
  onSaveGeneral(): void;
  onClearError(): void;
}) {
  const [section, setSection] = useState<"gateways" | "general">("gateways");
  return (
    <div className="group-dialog-backdrop" role="presentation">
      <section
        className="group-dialog settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
      >
        <header className="settings-header">
          <div>
            <p className="dialog-eyebrow">CLIENT SETTINGS</p>
            <h2 id="settings-dialog-title">客户端设置</h2>
          </div>
          <button type="button" className="settings-close" onClick={onClose} aria-label="关闭设置">×</button>
        </header>
        <div className="settings-layout">
          <aside className="settings-profiles">
            <nav className="settings-navigation" aria-label="设置分类">
              <button type="button" className={section === "general" ? "active" : ""} onClick={() => { setSection("general"); onClearError(); }}>通用设置</button>
              <button type="button" className={section === "gateways" ? "active" : ""} onClick={() => { setSection("gateways"); onClearError(); }}>网关配置</button>
            </nav>
            {section === "gateways" && <>
              <div className="settings-section-title">
                <span>已保存的网关</span>
                <button type="button" onClick={onNew}>新增</button>
              </div>
              <div className="settings-profile-list">
                {profiles.map((profile) => {
                  const connected = profile.id === connectedProfileId;
                  const reconnecting = connected && connection === "reconnecting";
                  return (
                    <button
                      type="button"
                      key={profile.id}
                      className={profile.id === draft.id ? "active" : ""}
                      onClick={() => onSelect(profile)}
                    >
                      <strong>{profile.label}</strong>
                      <span>{compactUrl(profile.gatewayUrl)}</span>
                      <small>
                        {connected ? (reconnecting ? "正在重连" : "已连接") : profile.id === recentProfileId ? "最近使用" : ""}
                      </small>
                    </button>
                  );
                })}
                {!profiles.length && <p>还没有保存的网关。</p>}
              </div>
            </>}
          </aside>
          <div className="settings-editor">
            {section === "gateways" ? <section>
              <div className="settings-section-title"><span>网关连接</span></div>
              <div className="settings-fields two-columns">
                <label>
                  网关名称
                  <input aria-label="网关名称" autoFocus value={draft.label} maxLength={40} onChange={(event) => onDraftChange({ ...draft, label: event.target.value })} />
                  <small>仅用于在本机区分不同服务器，例如“办公室网关”。</small>
                </label>
                <label>
                  本设备名称
                  <input aria-label="本设备名称" value={draft.clientName} maxLength={MAX_CLIENT_NAME_LENGTH} onChange={(event) => onDraftChange({ ...draft, clientName: event.target.value })} />
                  <small>连接后会展示给其他在线成员，例如“亚飞的 MacBook”。</small>
                </label>
                <label className="full-column">
                  网关地址
                  <input value={draft.gatewayUrl} placeholder="ws://192.168.1.20:8788" onChange={(event) => onDraftChange({ ...draft, gatewayUrl: event.target.value })} />
                </label>
                <label className="full-column">
                  访问令牌
                  <input type="password" value={draft.token} minLength={32} maxLength={512} onChange={(event) => onDraftChange({ ...draft, token: event.target.value })} />
                </label>
              </div>
              <div className="settings-profile-actions">
                <button type="button" className="danger-link" onClick={onDelete} disabled={!profiles.some((profile) => profile.id === draft.id) || profilePending}>删除配置</button>
                <span />
                <button type="button" onClick={onSave} disabled={profilePending}>{profilePending ? "正在保存…" : "保存"}</button>
                <button type="button" className="primary-inline" onClick={onSaveAndConnect} disabled={profilePending}>保存并连接</button>
              </div>
            </section> : <section className="general-settings standalone-settings">
              <div className="settings-section-title"><span>新页面</span></div>
              <h3>新页面默认地址</h3>
              <p>此设置应用于当前客户端连接的所有网关。</p>
              <label>
                默认地址
                <input aria-label="新页面默认地址" autoFocus value={defaultPageUrl} onChange={(event) => onDefaultPageUrlChange(event.target.value)} placeholder="留空时打开空白页" />
              </label>
              <div className="settings-help-row">
                <p className="dialog-help">仅支持完整的 HTTP 或 HTTPS 地址。</p>
                <button type="button" onClick={onResetDefaultPageUrl}>恢复为空白页</button>
              </div>
              <div className="settings-general-actions">
                <button type="button" className="primary-inline" onClick={onSaveGeneral} disabled={pending}>保存通用设置</button>
              </div>
            </section>}
            {error && <p className="dialog-error settings-error">{error}</p>}
          </div>
        </div>
      </section>
    </div>
  );
}

function ConfirmDialog({
  value,
  pending,
  onCancel,
  onConfirm,
}: {
  value: Exclude<Confirmation, null>;
  pending: boolean;
  onCancel(): void;
  onConfirm(): void;
}) {
  return (
    <div className="group-dialog-backdrop" role="presentation">
      <section
        className="group-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
      >
        <p className="dialog-eyebrow">CONFIRM ACTION</p>
        <h2 id="confirm-dialog-title">{value.title}</h2>
        <p>{value.description}</p>
        <div className="group-dialog-actions">
          <button type="button" onClick={onCancel} disabled={pending}>取消</button>
          <button type="button" className="danger-button" onClick={onConfirm} disabled={pending}>
            {pending ? "正在删除…" : "确认删除"}
          </button>
        </div>
      </section>
    </div>
  );
}

function ClaimApprovalDialog({
  request,
  pending,
  onRespond,
}: {
  request: ClaimRequest;
  pending: boolean;
  onRespond(approved: boolean): void;
}) {
  return (
    <div className="group-dialog-backdrop" role="presentation">
      <section className="group-dialog" role="alertdialog" aria-modal="true" aria-labelledby="claim-dialog-title">
        <p className="dialog-eyebrow">CONTROL REQUEST</p>
        <h2 id="claim-dialog-title">控制权申请</h2>
        <p><strong>{request.requesterName}</strong> 想要控制“{request.groupName}”。同意后，你将立即失去该分组的操作权。</p>
        <div className="group-dialog-actions">
          <button type="button" onClick={() => onRespond(false)} disabled={pending}>拒绝</button>
          <button type="button" onClick={() => onRespond(true)} disabled={pending}>{pending ? "正在处理…" : "同意并移交"}</button>
        </div>
      </section>
    </div>
  );
}

export function RemoteBrowser({
  connectionStore = browserConnectionStore,
}: {
  connectionStore?: ConnectionStore;
} = {}) {
  const [connection, setConnection] = useState<ConnectionStatus>("idle");
  const [profiles, setProfiles] = useState<SavedConnection[]>([]);
  const [profilesLoaded, setProfilesLoaded] = useState(false);
  const [recentProfileId, setRecentProfileId] = useState("");
  const [connectedProfileId, setConnectedProfileId] = useState("");
  const [profileId, setProfileId] = useState("default");
  const [clientName, setClientName] = useState("");
  const [clientId, setClientId] = useState("");
  const [chromeConnected, setChromeConnected] = useState(false);
  const [targets, setTargets] = useState<Target[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [onlineClients, setOnlineClients] = useState<OnlineClient[]>([]);
  const [incomingClaims, setIncomingClaims] = useState<ClaimRequest[]>([]);
  const [pendingClaims, setPendingClaims] = useState<Record<string, { requestId: string; ownerName: string }>>({});
  const [claimResponsePending, setClaimResponsePending] = useState(false);
  const [selectedGroupId, setSelectedGroupId] = useState("default");
  const [activeTargetId, setActiveTargetId] = useState<string | null>(null);
  const [address, setAddress] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [actionError, setActionError] = useState("");
  const [chromeError, setChromeError] = useState("");
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [groupCreatePending, setGroupCreatePending] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const [confirmationPending, setConfirmationPending] = useState(false);
  const [defaultPageUrl, setDefaultPageUrl] = useState("");
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
  const [settingsProfileDraft, setSettingsProfileDraft] = useState<SavedConnection>(() => newConnectionProfile());
  const [settingsDefaultPageDraft, setSettingsDefaultPageDraft] = useState("");
  const [settingsError, setSettingsError] = useState("");
  const [settingsPending, setSettingsPending] = useState(false);
  const [frameInfo, setFrameInfo] = useState<FrameMetadata>({});
  const [lastFrameAt, setLastFrameAt] = useState(0);

  const connectionRef = useRef<RelayConnection | null>(null);
  const connectionCleanupRef = useRef<(() => void) | null>(null);
  const activeTargetRef = useRef<string | null>(null);
  const selectedGroupRef = useRef("default");
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const canvasWrapRef = useRef<HTMLDivElement | null>(null);
  const addressInputRef = useRef<HTMLInputElement | null>(null);
  const imeInputRef = useRef<HTMLTextAreaElement | null>(null);
  const composingRef = useRef(false);
  const frameSequenceRef = useRef(0);
  const pendingGroupDeleteRef = useRef<string | null>(null);
  const wheelTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wheelDeltaRef = useRef({ x: 0, y: 0 });
  const startupRestoreRef = useRef(false);
  const activationSequenceRef = useRef(0);
  const pendingCloseFallbackRef = useRef<string[] | null>(null);

  const resetViewerState = useCallback(() => {
    activeTargetRef.current = null;
    setActiveTargetId(null);
    setAddress("");
    setFrameInfo({});
    setLastFrameAt(0);
    frameSequenceRef.current += 1;
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
      canvas.width = 0;
      canvas.height = 0;
    }
  }, []);

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
    activeTargetRef.current = activeTargetId;
  }, [activeTargetId]);

  useEffect(() => {
    selectedGroupRef.current = selectedGroupId;
  }, [selectedGroupId]);

  const send = useCallback((message: Exclude<ClientMessage, { type: "hello" }>) => {
    return connectionRef.current?.send(message) ?? false;
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

  const drawBlob = useCallback(async (blob: Blob) => {
    const sequence = ++frameSequenceRef.current;
    const bitmap = await createImageBitmap(blob);
    if (sequence !== frameSequenceRef.current) {
      bitmap.close();
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) {
      bitmap.close();
      return;
    }
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d", { alpha: false })?.drawImage(bitmap, 0, 0);
    bitmap.close();
    setLastFrameAt(Date.now());
  }, []);

  const drawBinaryFrame = useCallback(
    (frame: BinaryFrame) => {
      if (frame.targetId !== activeTargetRef.current && activeTargetRef.current) return;
      setFrameInfo(frame.metadata);
      const bytes = frame.jpeg.slice();
      void drawBlob(new Blob([bytes.buffer], { type: "image/jpeg" })).catch(() => {
        setActionError("无法解码远程画面。");
      });
    },
    [drawBlob],
  );

  const handleServerMessage = useCallback(
    (message: ServerMessage) => {
      if (message.type === "ready") {
        setClientId(message.clientId);
      } else if (message.type === "state") {
        setTargets(message.targets);
        setGroups(message.groups);
        setOnlineClients(message.clients || []);
        if (
          pendingGroupDeleteRef.current &&
          !message.groups.some((group) => group.id === pendingGroupDeleteRef.current)
        ) {
          pendingGroupDeleteRef.current = null;
          setConfirmationPending(false);
          setConfirmation(null);
          setActionError("");
        }
        if (!message.groups.some((group) => group.id === selectedGroupRef.current)) {
          selectedGroupRef.current = "default";
          setSelectedGroupId("default");
        }
        const viewed = message.targets.find(
          (target) => target.targetId === activeTargetRef.current,
        );
        if (viewed) {
          setAddress(viewed.url);
        } else if (activeTargetRef.current) {
          const fallback = pendingCloseFallbackRef.current
            ?.map((targetId) => message.targets.find((target) => target.targetId === targetId))
            .find((target): target is Target => Boolean(target));
          pendingCloseFallbackRef.current = null;
          if (fallback) {
            activeTargetRef.current = fallback.targetId;
            setActiveTargetId(fallback.targetId);
            setAddress(fallback.url);
            connectionRef.current?.send({ type: "view", targetId: fallback.targetId });
          } else {
            resetViewerState();
          }
        }
      } else if (message.type === "group:created") {
        resetViewerState();
        selectedGroupRef.current = message.groupId;
        setSelectedGroupId(message.groupId);
        setGroupCreatePending(false);
        setGroupDialogOpen(false);
        setActionError("");
      } else if (message.type === "claim:requested") {
        setIncomingClaims((current) => [
          ...current.filter((request) => request.requestId !== message.request.requestId),
          message.request,
        ]);
      } else if (message.type === "claim:pending") {
        setPendingClaims((current) => ({
          ...current,
          [message.groupId]: { requestId: message.requestId, ownerName: message.ownerName },
        }));
        setActionError(`已向 ${message.ownerName} 发送控制权申请。`);
      } else if (message.type === "claim:resolved") {
        setClaimResponsePending(false);
        setIncomingClaims((current) => current.filter((request) => request.requestId !== message.requestId));
        setPendingClaims((current) => {
          const next = { ...current };
          if (next[message.groupId]?.requestId === message.requestId) delete next[message.groupId];
          return next;
        });
        setActionError(message.message);
      } else if (message.type === "viewing") {
        activeTargetRef.current = message.targetId;
        setActiveTargetId(message.targetId);
      } else if (message.type === "clipboard:text") {
        if (!message.text) {
          setActionError("远端页面中没有检测到选中的文本。");
          return;
        }
        void writeLocalClipboard(message.text).catch(() => {
          setActionError("系统拒绝写入剪贴板，请检查客户端权限。");
        });
      } else if (message.type === "frame") {
        if (message.targetId === activeTargetRef.current || !activeTargetRef.current) {
          setFrameInfo(message.metadata);
          const binary = Uint8Array.from(atob(message.data), (char) => char.charCodeAt(0));
          void drawBlob(new Blob([binary.buffer], { type: "image/jpeg" }));
        }
      } else if (message.type === "chrome") {
        setChromeConnected(message.connected);
        if (message.connected) {
          setChromeError("");
        } else {
          resetViewerState();
          setChromeError(message.message || "正在等待 Chrome。");
        }
      } else if (message.type === "error") {
        setClaimResponsePending(false);
        setGroupCreatePending(false);
        pendingGroupDeleteRef.current = null;
        pendingCloseFallbackRef.current = null;
        setConfirmationPending(false);
        setActionError(message.message);
      }
    },
    [drawBlob, resetViewerState],
  );

  const disconnect = useCallback(() => {
    connectionCleanupRef.current?.();
    connectionCleanupRef.current = null;
    connectionRef.current?.disconnect();
    connectionRef.current = null;
    setConnection("idle");
    setClientId("");
    setConnectedProfileId("");
    setChromeConnected(false);
    setTargets([]);
    setGroups([]);
    setOnlineClients([]);
    setIncomingClaims([]);
    setPendingClaims({});
    setConnectionError("");
    setActionError("");
    setChromeError("");
    setGroupDialogOpen(false);
    setGroupCreatePending(false);
    setConfirmation(null);
    setConfirmationPending(false);
    pendingGroupDeleteRef.current = null;
    pendingCloseFallbackRef.current = null;
    resetViewerState();
  }, [resetViewerState]);

  const connectProfile = useCallback((candidate: SavedConnection, closeSettingsOnSuccess = false) => {
    let nextProfile: SavedConnection;
    try {
      nextProfile = validateConnectionProfile(candidate);
    } catch (nextError) {
      const message = nextError instanceof Error ? nextError.message : "连接配置不完整。";
      setConnectionError("");
      setSettingsError(message);
      setSettingsProfileDraft(candidate);
      setSettingsDialogOpen(true);
      setConnection("idle");
      return false;
    }
    connectionCleanupRef.current?.();
    connectionRef.current?.disconnect();
    connectionCleanupRef.current = null;
    connectionRef.current = null;
    setClientId("");
    setConnectedProfileId("");
    setChromeConnected(false);
    setTargets([]);
    setGroups([]);
    setOnlineClients([]);
    setIncomingClaims([]);
    setPendingClaims({});
    pendingCloseFallbackRef.current = null;
    resetViewerState();
    setConnectionError("");
    setActionError("");
    setChromeError("");
    setConnection("connecting");
    setProfileId(nextProfile.id);
    setClientName(nextProfile.clientName);
    const relay = new RelayConnection({
      url: nextProfile.gatewayUrl,
      token: nextProfile.token,
      name: nextProfile.clientName,
    });
    connectionRef.current = relay;
    const cleanups = [
      relay.onState((snapshot) => {
        setConnection(snapshot.status);
        if (snapshot.error) setConnectionError(snapshot.error);
        if (snapshot.status === "reconnecting" || snapshot.status === "offline") {
          setClientId("");
          setChromeConnected(false);
          setTargets([]);
          setGroups([]);
          setOnlineClients([]);
          setIncomingClaims([]);
          setPendingClaims({});
          pendingCloseFallbackRef.current = null;
          resetViewerState();
        }
        if (snapshot.status === "auth-failed") {
          setClientId("");
          setChromeConnected(false);
          setConnectionError("");
          setSettingsProfileDraft(nextProfile);
          setSettingsError(snapshot.error || "网关认证失败，请检查连接配置。");
          setSettingsDialogOpen(true);
        }
        if (snapshot.status === "online") {
          const activationSequence = ++activationSequenceRef.current;
          setConnectionError("");
          setConnectedProfileId(nextProfile.id);
          setRecentProfileId(nextProfile.id);
          void connectionStore
            .save(nextProfile)
            .then(() => {
              setProfiles((current) => [nextProfile, ...current.filter((item) => item.id !== nextProfile.id)]);
              if (activationSequence !== activationSequenceRef.current) return;
              return connectionStore.activate(nextProfile.id);
            })
            .then(() => {
              if (activationSequence !== activationSequenceRef.current) return;
              if (closeSettingsOnSuccess) setSettingsDialogOpen(false);
            })
            .catch((saveError) => {
              setActionError(saveError instanceof Error ? saveError.message : "无法保存连接配置");
            });
        }
      }),
      relay.onMessage(handleServerMessage),
      relay.onFrame(drawBinaryFrame),
    ];
    connectionCleanupRef.current = () => cleanups.forEach((cleanup) => cleanup());
    relay.connect();
    return true;
  }, [
    connectionStore,
    drawBinaryFrame,
    handleServerMessage,
    resetViewerState,
  ]);

  const removeProfile = () => {
    if (!profiles.some((profile) => profile.id === settingsProfileDraft.id)) return;
    setActionError("");
    setConfirmation({
      kind: "profile",
      profileId: settingsProfileDraft.id,
      title: `删除“${settingsProfileDraft.label}”？`,
      description: "该网关地址和保存在系统凭据库中的访问令牌都会从本机移除。",
    });
  };

  const openSettings = () => {
    const selected = profiles.find((profile) => profile.id === connectedProfileId)
      || profiles.find((profile) => profile.id === profileId)
      || profiles[0]
      || newConnectionProfile();
    setSettingsProfileDraft(selected);
    setSettingsDefaultPageDraft(defaultPageUrl);
    setSettingsError("");
    setSettingsDialogOpen(true);
  };

  const persistSettingsDraft = async () => {
    try {
      setSettingsPending(true);
      const saved = validateConnectionProfile(settingsProfileDraft);
      await connectionStore.save(saved);
      setProfiles((current) => [saved, ...current.filter((profile) => profile.id !== saved.id)]);
      setSettingsProfileDraft(saved);
      setSettingsError("");
      setActionError("");
      return saved;
    } catch (settingsSaveError) {
      setSettingsError(
        settingsSaveError instanceof Error ? settingsSaveError.message : "无法保存客户端设置。",
      );
      return null;
    } finally {
      setSettingsPending(false);
    }
  };

  const saveAndConnect = async () => {
    const saved = await persistSettingsDraft();
    if (saved) connectProfile(saved, true);
  };

  const persistGeneralSettings = () => {
    try {
      const normalized = normalizeDefaultPageUrl(settingsDefaultPageDraft);
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ defaultPageUrl: normalized }));
      setDefaultPageUrl(normalized);
      setSettingsDefaultPageDraft(normalized);
      setSettingsError("");
      setActionError("");
    } catch (settingsSaveError) {
      setSettingsError(
        settingsSaveError instanceof Error ? settingsSaveError.message : "默认地址格式不正确。",
      );
    }
  };

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active || startupRestoreRef.current) return;
      startupRestoreRef.current = true;
      const settings = loadClientSettings();
      setDefaultPageUrl(settings.defaultPageUrl);
      setSettingsDefaultPageDraft(settings.defaultPageUrl);
      void connectionStore
        .load()
        .then((savedProfiles) => {
          if (!active) return;
          setProfiles(savedProfiles);
          setProfilesLoaded(true);
          const saved = savedProfiles[0];
          if (!saved) {
            const draft = newConnectionProfile();
            draft.gatewayUrl = hostGatewayUrl();
            setSettingsProfileDraft(draft);
            setSettingsDialogOpen(true);
            return;
          }
          setRecentProfileId(saved.id);
          setSettingsProfileDraft(saved);
          connectProfile(saved);
        })
        .catch((loadError) => {
          if (!active) return;
          const draft = newConnectionProfile();
          draft.gatewayUrl = hostGatewayUrl();
          setProfilesLoaded(true);
          setSettingsProfileDraft(draft);
          setSettingsError(loadError instanceof Error ? loadError.message : "无法读取连接配置");
          setSettingsDialogOpen(true);
        });
    });
    return () => {
      active = false;
    };
  }, [connectProfile, connectionStore]);

  useEffect(
    () => () => {
      connectionCleanupRef.current?.();
      connectionRef.current?.disconnect();
    },
    [],
  );

  const openTarget = (targetId: string) => {
    resetViewerState();
    activeTargetRef.current = targetId;
    setActiveTargetId(targetId);
    const nextTarget = targets.find((target) => target.targetId === targetId);
    if (nextTarget) setAddress(nextTarget.url);
    send({ type: "view", targetId });
    requestAnimationFrame(() => canvasRef.current?.focus());
  };

  const createTarget = () => {
    if (!chromeConnected || connection !== "online") {
      setActionError("Chrome 尚未连接，暂时不能新建页面。");
      return;
    }
    const message: Extract<ClientMessage, { type: "create" }> = {
      type: "create",
      groupId: selectedGroupId,
      afterTargetId:
        activeTarget?.groupId === selectedGroupId
          ? activeTarget.targetId
          : undefined,
    };
    if (defaultPageUrl) message.url = defaultPageUrl;
    if (!send(message)) setActionError("网关连接已断开，无法新建页面。");
  };

  const selectGroup = (groupId: string) => {
    selectedGroupRef.current = groupId;
    setSelectedGroupId(groupId);
    const firstTarget = targets.find((target) => target.groupId === groupId);
    if (firstTarget) {
      openTarget(firstTarget.targetId);
    } else {
      resetViewerState();
    }
  };

  const createGroup = () => {
    if (connection !== "online") {
      setActionError("网关尚未连接，暂时不能创建分组。");
      return;
    }
    setNewGroupName("");
    setActionError("");
    setGroupCreatePending(false);
    setGroupDialogOpen(true);
  };

  const submitGroup = (event: FormEvent) => {
    event.preventDefault();
    const name = newGroupName.trim();
    if (!name) {
      setActionError("请输入分组名称。");
      return;
    }
    setActionError("");
    setGroupCreatePending(true);
    if (!send({ type: "group:create", name })) {
      setGroupCreatePending(false);
      setActionError("网关连接已断开，无法创建分组。");
      return;
    }
  };

  const deleteGroup = () => {
    if (!activeGroup?.deletable) return;
    setActionError("");
    setConfirmation({
      kind: "group",
      title: `删除“${activeGroup.name}”？`,
      description: "组内标签页会保留，并自动移入默认工作区。",
    });
  };

  const confirmDelete = () => {
    if (!confirmation) return;
    setConfirmationPending(true);
    setActionError("");
    if (confirmation.kind === "group") {
      if (!activeGroup || !send({ type: "group:delete", groupId: activeGroup.id })) {
        setConfirmationPending(false);
        setActionError("网关连接已断开，无法删除分组。");
        return;
      }
      pendingGroupDeleteRef.current = activeGroup.id;
      return;
    }
    const removedProfileId = confirmation.profileId;
    if (removedProfileId === connectedProfileId) disconnect();
    void connectionStore
      .remove(removedProfileId)
      .then(() => {
        const remaining = profiles.filter((profile) => profile.id !== removedProfileId);
        setProfiles(remaining);
        if (recentProfileId === removedProfileId) setRecentProfileId("");
        const next = remaining[0] || newConnectionProfile();
        if (!remaining.length) next.gatewayUrl = hostGatewayUrl();
        setSettingsProfileDraft(next);
        setSettingsError("");
        setConfirmation(null);
      })
      .catch((removeError) => {
        setSettingsError(removeError instanceof Error ? removeError.message : "无法删除连接配置");
      })
      .finally(() => setConfirmationPending(false));
  };

  const closeTarget = (target: Target) => {
    if (target.ownerId !== clientId) {
      setActionError("请先取得该分组控制权，再关闭标签页。");
      return;
    }
    if (target.targetId === activeTargetId) {
      const index = visibleTargets.findIndex((item) => item.targetId === target.targetId);
      pendingCloseFallbackRef.current = [
        ...visibleTargets.slice(index + 1),
        ...visibleTargets.slice(0, index).reverse(),
      ].map((item) => item.targetId);
    }
    if (!send({ type: "close", targetId: target.targetId })) {
      pendingCloseFallbackRef.current = null;
      setActionError("网关连接已断开，无法关闭标签页。");
    }
  };

  const runPageCommand = (command: "reload" | "back" | "forward") => {
    if (!activeTargetId) return;
    if (!isOwner) {
      setActionError("请先取得当前分组控制权，再操作页面。");
      return;
    }
    if (!send({ type: "command", targetId: activeTargetId, command })) {
      setActionError("网关连接已断开，无法操作页面。");
    }
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
    if (!send({
      type: "clipboard",
      action: "copy",
      targetId: activeTargetId,
    })) setActionError("网关连接已断开，无法复制远端文本。");
  };

  const pasteToRemote = async () => {
    if (!activeTargetId || !isOwner) return;
    let text = "";
    try {
      text = await navigator.clipboard.readText();
    } catch {
      setActionError("无法读取本机剪贴板，请检查客户端的剪贴板权限。");
      return;
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
    event.preventDefault();
    event.stopPropagation();
    if (!activeTargetId || !isOwner) return;
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

  const keyboard = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!activeTargetId || !isOwner) return;
    if (event.nativeEvent.isComposing || composingRef.current || event.keyCode === 229) return;
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

  useEffect(() => {
    if (!clientId) return;

    const shortcut = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const mod = event.ctrlKey || event.metaKey;
      let action:
        | "new"
        | "close"
        | "location"
        | "reload"
        | "back"
        | "forward"
        | "next-tab"
        | "previous-tab"
        | null = null;

      if (mod && !event.altKey && key === "t") action = "new";
      else if (mod && !event.altKey && key === "w") action = "close";
      else if (mod && !event.altKey && key === "l") action = "location";
      else if (mod && !event.altKey && key === "r") action = "reload";
      else if (key === "f5") action = "reload";
      else if (event.ctrlKey && key === "tab") {
        action = event.shiftKey ? "previous-tab" : "next-tab";
      } else if (event.metaKey && event.shiftKey && (key === "[" || key === "]")) {
        action = key === "[" ? "previous-tab" : "next-tab";
      } else if (event.metaKey && event.altKey && (key === "arrowleft" || key === "arrowright")) {
        action = key === "arrowleft" ? "previous-tab" : "next-tab";
      } else if (!event.metaKey && event.altKey && (key === "arrowleft" || key === "arrowright")) {
        action = key === "arrowleft" ? "back" : "forward";
      } else if (event.metaKey && !event.altKey && !event.ctrlKey && (key === "[" || key === "]")) {
        action = key === "[" ? "back" : "forward";
      }

      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat || settingsDialogOpen || groupDialogOpen || confirmation || incomingClaims.length) return;

      if (action === "location") {
        addressInputRef.current?.focus();
        addressInputRef.current?.select();
        return;
      }
      if (action === "new") {
        if (!chromeConnected || connection !== "online") {
          setActionError("Chrome 尚未连接，暂时不能新建页面。");
          return;
        }
        const message: Extract<ClientMessage, { type: "create" }> = {
          type: "create",
          groupId: selectedGroupId,
          afterTargetId:
            activeTarget?.groupId === selectedGroupId ? activeTarget.targetId : undefined,
        };
        if (defaultPageUrl) message.url = defaultPageUrl;
        if (!send(message)) setActionError("网关连接已断开，无法新建页面。");
        return;
      }
      if (action === "next-tab" || action === "previous-tab") {
        if (!visibleTargets.length) return;
        const currentIndex = visibleTargets.findIndex((target) => target.targetId === activeTargetId);
        const direction = action === "next-tab" ? 1 : -1;
        const nextIndex = currentIndex < 0
          ? (direction > 0 ? 0 : visibleTargets.length - 1)
          : (currentIndex + direction + visibleTargets.length) % visibleTargets.length;
        const nextTarget = visibleTargets[nextIndex];
        resetViewerState();
        activeTargetRef.current = nextTarget.targetId;
        setActiveTargetId(nextTarget.targetId);
        setAddress(nextTarget.url);
        send({ type: "view", targetId: nextTarget.targetId });
        requestAnimationFrame(() => canvasRef.current?.focus());
        return;
      }
      if (!activeTarget) return;
      if (!isOwner) {
        setActionError("请先取得当前分组控制权，再操作页面。");
        return;
      }
      if (action === "close") {
        const index = visibleTargets.findIndex((target) => target.targetId === activeTarget.targetId);
        pendingCloseFallbackRef.current = [
          ...visibleTargets.slice(index + 1),
          ...visibleTargets.slice(0, index).reverse(),
        ].map((target) => target.targetId);
        if (!send({ type: "close", targetId: activeTarget.targetId })) {
          pendingCloseFallbackRef.current = null;
          setActionError("网关连接已断开，无法关闭标签页。");
        }
        return;
      }
      const command = action === "reload" ? "reload" : action;
      if (!send({ type: "command", targetId: activeTarget.targetId, command })) {
        setActionError("网关连接已断开，无法操作页面。");
      }
    };

    window.addEventListener("keydown", shortcut, true);
    return () => window.removeEventListener("keydown", shortcut, true);
  }, [
    activeTarget,
    activeTargetId,
    chromeConnected,
    clientId,
    confirmation,
    connection,
    defaultPageUrl,
    groupDialogOpen,
    incomingClaims.length,
    isOwner,
    resetViewerState,
    selectedGroupId,
    send,
    settingsDialogOpen,
    visibleTargets,
  ]);

  const compositionStart = () => {
    composingRef.current = true;
  };

  const compositionEnd = (event: ReactCompositionEvent<HTMLTextAreaElement>) => {
    composingRef.current = false;
    const text = event.data;
    event.currentTarget.value = "";
    if (!text || !activeTargetId || !isOwner) return;
    send({ type: "text", targetId: activeTargetId, text });
  };

  const respondToClaim = (approved: boolean) => {
    const request = incomingClaims[0];
    if (!request) return;
    setClaimResponsePending(true);
    if (!send({ type: "claim:respond", requestId: request.requestId, approved })) {
      setClaimResponsePending(false);
      setActionError("网关连接已断开，无法处理控制权申请。");
    }
  };

  const currentProfile = profiles.find((profile) => profile.id === profileId) || profiles[0];
  const settingsBusy = settingsPending || (
    settingsProfileDraft.id === profileId && ["connecting", "authenticating"].includes(connection)
  );
  const settingsOverlay = settingsDialogOpen && (
    <SettingsDialog
      profiles={profiles}
      draft={settingsProfileDraft}
      recentProfileId={recentProfileId}
      connectedProfileId={connectedProfileId}
      connection={connection}
      defaultPageUrl={settingsDefaultPageDraft}
      error={settingsError}
      pending={settingsPending}
      profilePending={settingsBusy}
      onSelect={(profile) => {
        setSettingsProfileDraft(profile);
        setSettingsError("");
      }}
      onNew={() => {
        setSettingsProfileDraft(newConnectionProfile());
        setSettingsError("");
      }}
      onDraftChange={(value) => {
        setSettingsProfileDraft(value);
        setSettingsError("");
      }}
      onDefaultPageUrlChange={(value) => {
        setSettingsDefaultPageDraft(value);
        setSettingsError("");
      }}
      onResetDefaultPageUrl={() => {
        setSettingsDefaultPageDraft("");
        setSettingsError("");
      }}
      onDelete={removeProfile}
      onClose={() => setSettingsDialogOpen(false)}
      onSave={() => void persistSettingsDraft()}
      onSaveAndConnect={() => void saveAndConnect()}
      onSaveGeneral={persistGeneralSettings}
      onClearError={() => setSettingsError("")}
    />
  );

  const profileConfirmation = confirmation?.kind === "profile" && (
    <ConfirmDialog
      value={confirmation}
      pending={confirmationPending}
      onCancel={() => setConfirmation(null)}
      onConfirm={confirmDelete}
    />
  );

  if (!clientId) {
    const restoring = ["connecting", "authenticating", "reconnecting"].includes(connection);
    const noProfiles = profilesLoaded && profiles.length === 0;
    return (
      <>
      <main className="connect-shell">
        <section className="connect-copy">
          <div className="brand-mark">RD</div>
          <p className="eyebrow">RELAYDECK / LAN GATEWAY</p>
          <h1>
            共享一个 Chrome。
            <br />
            按分组协作操作。
          </h1>
          <p className="connect-lede">
            Chrome 和登录状态留在网关主机。客户端只接收页面画面；取得分组控制权后，
            才能输入、导航和使用剪贴板。
          </p>
          <div className="feature-grid">
            <div>
              <span>01</span>
              <strong>Chrome 留在网关</strong>
              <p>登录状态和浏览器数据不会复制到客户端。</p>
            </div>
            <div>
              <span>02</span>
              <strong>连接后选页面</strong>
              <p>连接网关后查看标签页，并选择要操作的页面。</p>
            </div>
            <div>
              <span>03</span>
              <strong>分组控制权互斥</strong>
              <p>同一分组同时只有一个设备可以输入。</p>
            </div>
          </div>
        </section>

        <section className="connect-panel">
          <div className="panel-heading">
            <span className={`status-dot ${restoring ? "warning" : ""}`} />
            <div>
              <p>{!profilesLoaded ? "正在读取客户端设置" : noProfiles ? "尚未添加网关" : restoring ? "正在恢复网关连接" : "网关连接已停止"}</p>
              <span>{!profilesLoaded ? "请稍候…" : noProfiles ? "先在设置中添加运行 Chrome 的主机" : restoring ? "客户端会在网关恢复后自动进入控制台" : "你可以重新连接最近使用的网关"}</span>
            </div>
          </div>
          {currentProfile && (
            <div className="restore-profile">
              <strong>{currentProfile.label}</strong>
              <span>{compactUrl(currentProfile.gatewayUrl)}</span>
            </div>
          )}
          {connectionError && <p className="form-error">{connectionError}</p>}
          <div className="restore-actions">
            {restoring ? (
              <button className="primary-button" onClick={disconnect}>停止重连</button>
            ) : currentProfile ? (
              <button className="primary-button" onClick={() => connectProfile(currentProfile)}>重新连接</button>
            ) : profilesLoaded ? (
              <button className="primary-button" onClick={openSettings}>添加网关</button>
            ) : null}
            {profilesLoaded && <button className="secondary-button" onClick={openSettings}>打开设置</button>}
          </div>
          <p className="security-note">
            只连接你信任的网关地址。Chrome 调试端口不会暴露给客户端。
          </p>
        </section>
      </main>
      {settingsOverlay}
      {profileConfirmation}
      </>
    );
  }

  return (
    <>
    <main className="workspace-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="brand-mark small">RD</div>
          <div>
            <strong>Relaydeck</strong>
            <span>共享浏览器</span>
          </div>
        </div>

        <div className="connection-card">
          <span
            className={`status-dot ${connection === "online" && chromeConnected ? "online" : "warning"}`}
          />
          <div>
            <strong>
              {connection !== "online"
                ? "网关未连接"
                : chromeConnected
                  ? "Chrome 已连接"
                  : "等待网关上的 Chrome"}
            </strong>
            <span>
              {connection === "reconnecting"
                ? "正在重新连接网关…"
                : connection !== "online"
                  ? "请检查网关地址和服务状态"
                  : clientName}
            </span>
          </div>
        </div>

        <div className="target-heading">
          <span>共享窗口</span>
          <span>{visibleTargets.length} 个标签页</span>
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
          <button
            type="button"
            onClick={createGroup}
            disabled={connection !== "online"}
            aria-label="创建分组"
            title={connection === "online" ? "创建分组" : "连接网关后才能创建分组"}
          >
            G+
          </button>
          <button
            type="button"
            onClick={deleteGroup}
            disabled={!activeGroup?.deletable}
            aria-label="删除当前分组"
            title="删除当前分组，标签页移入默认工作区"
          >
            G−
          </button>
          <button
            type="button"
            onClick={createTarget}
            disabled={!chromeConnected}
            aria-label="在当前分组新建页面"
            title="新建标签页（Ctrl/Cmd+T）"
          >
            ＋
          </button>
        </div>

        {groupDialogOpen && (
          <div
            className="group-dialog-backdrop"
            role="presentation"
            onMouseDown={(event) => {
              if (!groupCreatePending && event.target === event.currentTarget) {
                setGroupDialogOpen(false);
              }
            }}
          >
            <form
              className="group-dialog"
              onSubmit={submitGroup}
              onMouseDown={(event) => event.stopPropagation()}
              role="dialog"
              aria-modal="true"
              aria-labelledby="group-dialog-title"
            >
              <p className="dialog-eyebrow">NEW GROUP</p>
              <h2 id="group-dialog-title">创建分组</h2>
              <p>分组用于把标签页分开管理，并分别分配控制权。</p>
              <label>
                分组名称
                <input
                  autoFocus
                  value={newGroupName}
                  maxLength={30}
                  onChange={(event) => {
                    setNewGroupName(event.target.value);
                    setActionError("");
                  }}
                  placeholder="例如：登录、资料、后台"
                  disabled={groupCreatePending}
                />
              </label>
              <div className="group-dialog-actions">
                <button
                  type="button"
                  onClick={() => setGroupDialogOpen(false)}
                  disabled={groupCreatePending}
                >
                  取消
                </button>
                <button type="submit" disabled={groupCreatePending}>
                  {groupCreatePending ? "正在创建…" : "创建分组"}
                </button>
              </div>
            </form>
          </div>
        )}

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
                    ? "关闭标签页（Ctrl/Cmd+W）"
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

        <section className="online-members" aria-label="在线成员">
          <div className="target-heading">
            <span>在线成员</span>
            <span>{onlineClients.length} 人</span>
          </div>
          <div className="online-member-list">
            {onlineClients.map((onlineClient) => {
              const controlledGroups = groups.filter((group) => group.ownerId === onlineClient.clientId);
              return (
                <div className="online-member" key={onlineClient.clientId}>
                  <span className="online-member-dot" />
                  <div>
                    <strong>{onlineClient.clientName}{onlineClient.clientId === clientId ? "（本机）" : ""}</strong>
                    <span>{controlledGroups.length ? `正在控制：${controlledGroups.map((group) => group.name).join("、")}` : "在线"}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <div className="sidebar-footer">
          <div className="sidebar-footer-actions">
            <button onClick={disconnect}>断开此设备</button>
            <button onClick={openSettings}>设置</button>
          </div>
          <span>{clientId.slice(0, 8) || "连接中"}</span>
        </div>
      </aside>

      <section className="browser-stage">
        <header className="browser-toolbar">
          <div className="nav-buttons">
            <button
              onClick={() => runPageCommand("back")}
              disabled={!isOwner}
              title="后退（Alt+← / Cmd+[）"
            >
              ←
            </button>
            <button
              onClick={() => runPageCommand("forward")}
              disabled={!isOwner}
              title="前进（Alt+→ / Cmd+]）"
            >
              →
            </button>
            <button
              onClick={() => runPageCommand("reload")}
              disabled={!isOwner}
              title="刷新（Ctrl/Cmd+R 或 F5）"
            >
              ↻
            </button>
          </div>
          <form className="address-form" onSubmit={navigate}>
            <span className="secure-mark">◆</span>
            <input
              ref={addressInputRef}
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              disabled={!activeTarget}
              aria-label="页面地址"
            />
          </form>
          {activeTarget && (
            <button
              className={`claim-button ${isOwner ? "owned" : ""}`}
              onClick={() => send({ type: isOwner ? "release" : "claim", targetId: activeTarget.targetId })}
              disabled={!isOwner && Boolean(pendingClaims[activeTarget.groupId])}
            >
              {isOwner
                ? "释放分组"
                : pendingClaims[activeTarget.groupId]
                  ? `等待 ${pendingClaims[activeTarget.groupId].ownerName} 同意…`
                : activeTarget.ownerId
                  ? "申请控制"
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
                  imeInputRef.current?.focus({ preventScroll: true });
                  mouse("mousePressed", event);
                }}
                onMouseUp={(event) => mouse("mouseReleased", event)}
                onContextMenu={(event) => event.preventDefault()}
                onWheel={wheel}
                onKeyDown={keyboard}
                aria-label="远程浏览器画面"
              />
              <textarea
                ref={imeInputRef}
                className="ime-capture"
                aria-label="远程浏览器键盘输入"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                onKeyDown={keyboard}
                onCompositionStart={compositionStart}
                onCompositionEnd={compositionEnd}
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
              <span>或创建新的共享页面开始操作</span>
              <button
                onClick={createTarget}
                disabled={!chromeConnected}
                title="新建标签页（Ctrl/Cmd+T）"
              >
                新建页面
              </button>
            </div>
          )}
        </div>

        {(actionError || chromeError) && (
          <div className="toast">
            <span>!</span>
            <p>{actionError || chromeError}</p>
            <button
              onClick={() => {
                setActionError("");
                setChromeError("");
              }}
            >
              ×
            </button>
          </div>
        )}
      </section>
    </main>
    {settingsOverlay}
    {profileConfirmation}
    {confirmation?.kind === "group" && (
      <ConfirmDialog
        value={confirmation}
        pending={confirmationPending}
        onCancel={() => setConfirmation(null)}
        onConfirm={confirmDelete}
      />
    )}
    {incomingClaims[0] && (
      <ClaimApprovalDialog
        request={incomingClaims[0]}
        pending={claimResponsePending}
        onRespond={respondToClaim}
      />
    )}
    </>
  );
}
