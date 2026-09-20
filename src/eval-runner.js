import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRuntime, rootDir } from "./runtime.js";

async function main() {
  const mode = process.argv[2] ?? "baseline";
  if (mode !== "baseline") throw new Error(`Unsupported evaluation mode: ${mode}`);
  const flags = new Set(process.argv.slice(3));
  const checkOnly = flags.has("--check");
  const writeEvidence = flags.has("--write-evidence");
  if (checkOnly && writeEvidence) throw new Error("Use either --check or --write-evidence, not both");
  const scenarios = JSON.parse(await readFile(resolve(rootDir, "eval/scenarios.json"), "utf8"));
  const temporaryDir = await mkdtemp(join(tmpdir(), "production-agent-eval-"));
  const runStartedAt = new Date().toISOString();
  const runStarted = performance.now();
  const results = [];
  try {
    for (const scenario of scenarios) {
      const statePath = join(temporaryDir, `${scenario.id}.json`);
      const { baseline } = await createRuntime({ statePath });
      const actual = await baseline.diagnose(scenario.credential, scenario.input);
      results.push({
        scenarioId: scenario.id,
        expectedOutcome: scenario.expectedOutcome,
        actualOutcome: actual.outcome,
        passed: actual.outcome === scenario.expectedOutcome,
        result: actual
      });
    }
  } finally {
    await rm(temporaryDir, { recursive: true, force: true });
  }
  const passed = results.filter((item) => item.passed).length;
  const evidence = {
    schemaVersion: 2,
    mode,
    scenarioCount: results.length,
    trialCount: results.length,
    passed,
    failed: results.length - passed,
    passRate: passed / results.length,
    note: "One deterministic trial per development scenario; this is not the final holdout evaluation.",
    results
  };
  const serializedEvidence = `${JSON.stringify(evidence, null, 2)}\n`;
  const evidencePath = resolve(rootDir, "outputs/eval-baseline-development.json");
  let action;
  let outputPath;
  if (checkOnly) {
    const committed = await readFile(evidencePath, "utf8");
    if (committed !== serializedEvidence) {
      console.error(JSON.stringify({ ok: false, action: "check", evidencePath, reason: "EVIDENCE_MISMATCH" }, null, 2));
      process.exitCode = 1;
      return;
    }
    action = "check";
    outputPath = null;
  } else if (writeEvidence) {
    await mkdir(resolve(rootDir, "outputs"), { recursive: true });
    await writeFile(evidencePath, serializedEvidence, "utf8");
    action = "write-evidence";
    outputPath = evidencePath;
  } else {
    const runPath = resolve(rootDir, "work/eval-baseline-run.json");
    await mkdir(resolve(rootDir, "work"), { recursive: true });
    await writeFile(runPath, `${JSON.stringify({
      runStartedAt,
      runCompletedAt: new Date().toISOString(),
      durationMs: Number((performance.now() - runStarted).toFixed(3)),
      evidence
    }, null, 2)}\n`, "utf8");
    action = "run";
    outputPath = runPath;
  }
  console.log(JSON.stringify({
    ok: evidence.failed === 0,
    action,
    outputPath,
    evidencePath,
    scenarioCount: evidence.scenarioCount,
    passed,
    failed: evidence.failed
  }, null, 2));
  if (evidence.failed > 0) process.exitCode = 1;
}

await main();
