import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "../src/runtime.js";

test("fails closed instead of resetting corrupt state", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "portfolio-runtime-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, "state.json");
  await writeFile(statePath, "{not-json", "utf8");

  await assert.rejects(createRuntime({ statePath }), SyntaxError);
  assert.equal(await readFile(statePath, "utf8"), "{not-json");
});
