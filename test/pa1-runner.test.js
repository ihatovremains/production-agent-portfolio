import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFile, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { budgetAllowsAttempt, computeFreezeTargets, FILE_TARGETS, runEvaluation, verifyFreeze } from "../src/pa1-runner.js";

const root = resolve(import.meta.dirname, "..");

async function runSmall(t, options = {}) {
  const runRoot = await mkdtemp(resolve(tmpdir(), "pa1-runner-test-"));
  t.after(() => rm(runRoot, { recursive: true, force: true }));
  return runEvaluation({
    mode: "dry",
    runRoot,
    budgetUsd: 10,
    scenarioIds: ["info-03"],
    candidateRoles: ["quality_reference"],
    trialsPerScenario: 1,
    includeScriptedMatrix: false,
    evidencePath: null,
    ...options
  });
}

test("classification retains an infrastructure failure unscored and executes one replacement", async (t) => {
  const plannedTrialId = "standin-quality_reference:info-03:1";
  const { runRecord } = await runSmall(t, { infrastructureFailurePlan: { [plannedTrialId]: 1 } });
  const entries = runRecord.trials.filter((item) => item.plannedTrialId === plannedTrialId);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((item) => ({ attempt: item.attempt, classification: item.classification, replacementScheduled: item.replacementScheduled, scored: item.scored })), [
    { attempt: 1, classification: "infrastructure", replacementScheduled: true, scored: false },
    { attempt: 2, classification: "completed", replacementScheduled: false, scored: true }
  ]);
});

test("two consecutive infrastructure failures leave the planned trial unresolved and unscored", async (t) => {
  const plannedTrialId = "standin-quality_reference:info-03:1";
  const { runRecord } = await runSmall(t, { infrastructureFailurePlan: { [plannedTrialId]: 2 } });
  const entries = runRecord.trials.filter((item) => item.plannedTrialId === plannedTrialId);
  assert.equal(entries.length, 2);
  assert.equal(entries.every((item) => item.scored === false), true);
  assert.equal(entries[0].replacementScheduled, true);
  assert.equal(entries[1].unresolved, true);
  assert.equal(runRecord.deterministicMetadata.unresolvedInfrastructureTrials, 1);
});

test("the evaluation loop records later planned trials as unexecuted when the cap is reached", async (t) => {
  const runRoot = await mkdtemp(resolve(tmpdir(), "pa1-budget-test-"));
  t.after(() => rm(runRoot, { recursive: true, force: true }));
  const { runRecord } = await runEvaluation({
    mode: "dry",
    runRoot,
    budgetUsd: 0.000001,
    scenarioIds: ["normal-01", "normal-02"],
    candidateRoles: ["quality_reference"],
    trialsPerScenario: 1,
    includeScriptedMatrix: false,
    infrastructureFailurePlan: {},
    evidencePath: null
  });
  assert.equal(runRecord.trials.filter((item) => item.scored).length, 1);
  assert.equal(runRecord.trials.filter((item) => item.status === "unexecuted_budget").length, 1);
  assert.equal(runRecord.deterministicMetadata.budgetStop.stoppedForBudget, true);
});

test("a live replacement is checked against the stop threshold before it starts", () => {
  assert.equal(budgetAllowsAttempt(0.93, 0.06, 1), true);
  assert.equal(budgetAllowsAttempt(0.95, 0.06, 1), false);
});

test("freeze verification covers service and harness", async (t) => {
  const copyRoot = await mkdtemp(resolve(tmpdir(), "pa1-freeze-test-"));
  t.after(() => rm(copyRoot, { recursive: true, force: true }));
  for (const relative of FILE_TARGETS) {
    const target = resolve(copyRoot, relative);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(resolve(root, relative), target);
  }
  const freezePath = resolve(copyRoot, "eval/pa1/freeze.json");
  await mkdir(dirname(freezePath), { recursive: true });
  const targets = await computeFreezeTargets({ root: copyRoot });
  await writeFile(freezePath, `${JSON.stringify({ targets })}\n`);
  await verifyFreeze({ root: copyRoot, freezePath });
  await appendFile(resolve(copyRoot, "src/service.js"), "\n// tamper\n");
  await assert.rejects(verifyFreeze({ root: copyRoot, freezePath }), /PA1_FREEZE_MISMATCH:src\/service\.js/);
  await copyFile(resolve(root, "src/service.js"), resolve(copyRoot, "src/service.js"));
  await appendFile(resolve(copyRoot, "src/pa1-harness.js"), "\n// tamper\n");
  await assert.rejects(verifyFreeze({ root: copyRoot, freezePath }), /PA1_FREEZE_MISMATCH:src\/pa1-harness\.js/);
});

test("live holdout runner refuses to start without explicit approval flag", () => {
  const result = spawnSync(process.execPath, [resolve(root, "src/pa1-runner.js"), "--live", "--budget-usd", "1"], { cwd: root, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--approved-live-holdout is required/);
});
