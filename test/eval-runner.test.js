import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { resolve } from "node:path";

const execFileAsync = promisify(execFile);
const rootDir = resolve(import.meta.dirname, "..");
const evidencePath = resolve(rootDir, "outputs/eval-baseline-development.json");

test("keeps committed evaluation evidence stable and supports a non-writing check", async () => {
  const before = await readFile(evidencePath);
  await execFileAsync(process.execPath, ["src/eval-runner.js", "baseline"], { cwd: rootDir });
  await execFileAsync(process.execPath, ["src/eval-runner.js", "baseline"], { cwd: rootDir });
  const afterRuns = await readFile(evidencePath);
  assert.deepEqual(afterRuns, before);

  const checked = await execFileAsync(
    process.execPath,
    ["src/eval-runner.js", "baseline", "--check"],
    { cwd: rootDir }
  );
  assert.match(checked.stdout, /"action": "check"/);
  assert.deepEqual(await readFile(evidencePath), before);
});
