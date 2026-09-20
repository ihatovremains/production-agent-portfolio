import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prepareScenario } from "./pa1-harness.js";

const root = resolve(import.meta.dirname, "..");
const scenarios = JSON.parse(await readFile(resolve(root, "eval/holdout/scenarios.json"), "utf8"));
const expected = JSON.parse(await readFile(resolve(root, "eval/holdout/expected.json"), "utf8"));
const plan = JSON.parse(await readFile(resolve(root, "eval/pa1/execution-plan.json"), "utf8"));
const expectedById = new Map(expected.map((item) => [item.id, item]));
const eligible = new Set(plan.baseline.eligibleScenarioIds);
const temporaryDir = await mkdtemp(join(tmpdir(), "pa1-baseline-"));
const results = [];
try {
  for (const scenario of scenarios) {
    if (!eligible.has(scenario.id)) {
      results.push({ scenarioId: scenario.id, status: "NOT_APPLICABLE", reason: plan.baseline.notApplicableReason });
      continue;
    }
    const prepared = await prepareScenario({
      scenario,
      fixturePath: resolve(root, "eval/holdout/fixture.json"),
      statePath: join(temporaryDir, `${scenario.id}.json`)
    });
    const actual = await prepared.baseline.diagnose(scenario.credential, prepared.input);
    const acceptableOutcomes = [...new Set(expectedById.get(scenario.id).acceptablePaths.map((path) => path.outcome))].sort();
    results.push({
      scenarioId: scenario.id,
      status: acceptableOutcomes.includes(actual.outcome) ? "MATCH" : "MISMATCH",
      acceptableOutcomes,
      actualOutcome: actual.outcome
    });
  }
  const output = {
    schemaVersion: 2,
    mode: "deterministic_baseline_holdout",
    eligible: results.filter((item) => item.status !== "NOT_APPLICABLE").length,
    notApplicable: results.filter((item) => item.status === "NOT_APPLICABLE").length,
    matched: results.filter((item) => item.status === "MATCH").length,
    mismatched: results.filter((item) => item.status === "MISMATCH").length,
    results
  };
  const outputPath = resolve(root, "outputs/pa1-baseline-holdout.json");
  const serialized = `${JSON.stringify(output, null, 2)}\n`;
  const checkOnly = process.argv.includes("--check");
  if (checkOnly) {
    const existing = await readFile(outputPath, "utf8");
    if (existing !== serialized) throw new Error("BASELINE_EVIDENCE_MISMATCH");
  } else {
    await mkdir(resolve(root, "outputs"), { recursive: true });
    await writeFile(outputPath, serialized, "utf8");
  }
  console.log(JSON.stringify({ ok: output.mismatched === 0, action: checkOnly ? "check" : "write", outputPath, eligible: output.eligible, notApplicable: output.notApplicable }, null, 2));
  if (output.mismatched > 0) process.exitCode = 1;
} finally {
  await rm(temporaryDir, { recursive: true, force: true });
}
