import { invoke } from "@tauri-apps/api/core";
import type { ConnectionStore, SavedConnection } from "@relaydeck/client-ui";

const PROFILE = "default";
const IS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function loadLocalFields(): Partial<SavedConnection> {
  return {
    gatewayUrl: localStorage.getItem("relaydeck.gateway") || undefined,
    clientName: localStorage.getItem("relaydeck.name") || undefined,
  };
}

export const connectionStore: ConnectionStore = {
  async load() {
    const local = loadLocalFields();
    if (!IS_TAURI) {
      return {
        ...local,
        token: sessionStorage.getItem("relaydeck.token") || undefined,
      };
    }
    const token = await invoke<string | null>("get_gateway_secret", { profile: PROFILE });
    return { ...local, token: token || undefined };
  },

  async save(value) {
    localStorage.setItem("relaydeck.gateway", value.gatewayUrl);
    localStorage.setItem("relaydeck.name", value.clientName);
    if (!IS_TAURI) {
      sessionStorage.setItem("relaydeck.token", value.token);
      return;
    }
    await invoke("set_gateway_secret", { profile: PROFILE, secret: value.token });
  },
};
