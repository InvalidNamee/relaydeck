import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { StateStore } from "../src/state-store.mjs";

test("persists workspace state atomically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relaydeck-state-"));
  const path = join(directory, "nested", "state.json");
  const store = new StateStore(path);
  store.schedule({
    version: 1,
    groups: [{ id: "team", name: "工作", color: "#fff", createdAt: 1 }],
    targetGroups: { page: "team" },
    targetOpeners: {},
    targetOrder: ["page"],
  });
  await store.flush();
  assert.match(await readFile(path, "utf8"), /"工作"/);
  const restored = await new StateStore(path).load();
  assert.deepEqual(restored.targetOrder, ["page"]);
  assert.equal(restored.groups[0].id, "team");
});

test("falls back safely when the state file is invalid", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relaydeck-invalid-state-"));
  const path = join(directory, "missing.json");
  const restored = await new StateStore(path).load();
  assert.deepEqual(restored.groups, []);
  assert.deepEqual(restored.targetOrder, []);
});
