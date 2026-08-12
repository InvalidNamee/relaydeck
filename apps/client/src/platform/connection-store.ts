import { invoke } from "@tauri-apps/api/core";
import type { ConnectionStore, SavedConnection } from "@relaydeck/client-ui";

const IS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const PROFILES_KEY = "relaydeck.profiles.v1";
const ACTIVE_PROFILE_KEY = "relaydeck.activeProfile.v1";
type StoredProfile = Omit<SavedConnection, "token">;

function loadProfiles(): StoredProfile[] {
  try {
    const value = JSON.parse(localStorage.getItem(PROFILES_KEY) || "[]") as unknown;
    if (Array.isArray(value)) {
      const profiles = value.filter(
        (profile): profile is StoredProfile =>
          Boolean(profile) &&
          typeof profile.id === "string" &&
          typeof profile.label === "string" &&
          typeof profile.gatewayUrl === "string" &&
          typeof profile.clientName === "string",
      );
      if (profiles.length) return profiles;
    }
  } catch {
    // Fall through to the one-time legacy migration below.
  }
  const gatewayUrl = localStorage.getItem("relaydeck.gateway");
  if (!gatewayUrl) return [];
  return [
    {
      id: "default",
      label: "默认网关",
      gatewayUrl,
      clientName: localStorage.getItem("relaydeck.name") || "",
    },
  ];
}

function saveProfiles(profiles: StoredProfile[]) {
  localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles));
}

export const connectionStore: ConnectionStore = {
  async load() {
    const activeId = localStorage.getItem(ACTIVE_PROFILE_KEY);
    const profiles = loadProfiles();
    profiles.sort((left, right) => Number(right.id === activeId) - Number(left.id === activeId));
    return Promise.all(
      profiles.map(async (profile) => ({
        ...profile,
        token: IS_TAURI
          ? (await invoke<string | null>("get_gateway_secret", { profile: profile.id })) || ""
          : sessionStorage.getItem(`relaydeck.token.${profile.id}`) || "",
      })),
    );
  },

  async save(value) {
    const profiles = loadProfiles().filter((profile) => profile.id !== value.id);
    profiles.push({
      id: value.id,
      label: value.label,
      gatewayUrl: value.gatewayUrl,
      clientName: value.clientName,
    });
    saveProfiles(profiles);
    localStorage.setItem(ACTIVE_PROFILE_KEY, value.id);
    if (!IS_TAURI) {
      sessionStorage.setItem(`relaydeck.token.${value.id}`, value.token);
      return;
    }
    await invoke("set_gateway_secret", { profile: value.id, secret: value.token });
  },

  async remove(id) {
    saveProfiles(loadProfiles().filter((profile) => profile.id !== id));
    sessionStorage.removeItem(`relaydeck.token.${id}`);
    if (localStorage.getItem(ACTIVE_PROFILE_KEY) === id) {
      localStorage.removeItem(ACTIVE_PROFILE_KEY);
    }
    if (IS_TAURI) await invoke("delete_gateway_secret", { profile: id });
  },
};
