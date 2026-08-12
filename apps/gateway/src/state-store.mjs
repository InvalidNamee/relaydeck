import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const EMPTY_STATE = Object.freeze({
  version: 1,
  groups: [],
  targetGroups: {},
  targetOpeners: {},
  targetOrder: [],
});

function sanitizedState(value) {
  if (!value || value.version !== 1) return { ...EMPTY_STATE };
  return {
    version: 1,
    groups: Array.isArray(value.groups)
      ? value.groups
          .filter(
            (group) =>
              group &&
              typeof group.id === "string" &&
              typeof group.name === "string" &&
              typeof group.color === "string" &&
              Number.isFinite(group.createdAt),
          )
          .map((group) => ({
            id: group.id.slice(0, 128),
            name: group.name.slice(0, 30),
            color: group.color.slice(0, 32),
            createdAt: group.createdAt,
          }))
      : [],
    targetGroups:
      value.targetGroups && typeof value.targetGroups === "object"
        ? Object.fromEntries(
            Object.entries(value.targetGroups)
              .filter(([key, item]) => typeof key === "string" && typeof item === "string")
              .map(([key, item]) => [key.slice(0, 128), item.slice(0, 128)]),
          )
        : {},
    targetOpeners:
      value.targetOpeners && typeof value.targetOpeners === "object"
        ? Object.fromEntries(
            Object.entries(value.targetOpeners)
              .filter(([key, item]) => typeof key === "string" && typeof item === "string")
              .map(([key, item]) => [key.slice(0, 128), item.slice(0, 128)]),
          )
        : {},
    targetOrder: Array.isArray(value.targetOrder)
      ? value.targetOrder.filter((item) => typeof item === "string").map((item) => item.slice(0, 128))
      : [],
  };
}

export class StateStore {
  constructor(path) {
    this.path = path;
    this.timer = null;
    this.pendingValue = null;
    this.writeChain = Promise.resolve();
  }

  async load() {
    try {
      return sanitizedState(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      return { ...EMPTY_STATE };
    }
  }

  schedule(value) {
    this.pendingValue = value;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, 120);
  }

  async flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const value = this.pendingValue;
    this.pendingValue = null;
    if (!value) return this.writeChain;
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporaryPath = `${this.path}.${process.pid}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporaryPath, this.path);
    });
    return this.writeChain;
  }
}
