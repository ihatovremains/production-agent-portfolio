import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { JsonStateStore } from "./store.js";
import { IntegrationService } from "./service.js";
import { DeterministicBaseline } from "./baseline.js";

export const rootDir = resolve(import.meta.dirname, "..");
export const fixturePath = resolve(rootDir, "fixtures/base-state.json");
export const defaultStatePath = resolve(rootDir, "work/runtime-state.json");

export async function resetState(path = defaultStatePath) {
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  const store = new JsonStateStore(path);
  await store.replace(fixture);
  return store;
}

export async function createRuntime({ statePath = defaultStatePath, clock } = {}) {
  let store = new JsonStateStore(statePath);
  try {
    await store.read();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    store = await resetState(statePath);
  }
  const service = new IntegrationService(store, { clock });
  return { store, service, baseline: new DeterministicBaseline(service) };
}
