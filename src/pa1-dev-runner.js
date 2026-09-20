import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createRuntime, fixturePath, rootDir } from "./runtime.js";
import { ResponsesAgent } from "./responses-agent.js";
import { hashState } from "./pa1-harness.js";

const args = process.argv.slice(2);
const scenarioFlag = args.indexOf("--scenario");
const scenarioId = scenarioFlag >= 0 ? args[scenarioFlag + 1] : null;
const isDev = args.includes("--dev");
const budgetFlag = args.indexOf("--budget-usd");
const budgetUsd = budgetFlag >= 0 ? Number(args[budgetFlag + 1]) : NaN;
if ((!scenarioId && !isDev) || (scenarioId && isDev)) {
  throw new Error("Use exactly one of --scenario <dev-id> or --dev");
}
if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) throw new Error("--budget-usd <positive number> is required");
if (process.env.PORTFOLIO_ALLOW_API !== "true") throw new Error("PORTFOLIO_ALLOW_API=true is required");
if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required in the process environment");

const allScenarios = JSON.parse(await readFile(resolve(rootDir, "eval/scenarios.json"), "utf8"));
const scenarios = scenarioId ? allScenarios.filter((item) => item.id === scenarioId) : allScenarios;
if (scenarios.length === 0) throw new Error(`Unknown development scenario: ${scenarioId}`);

const runId = `pa1-${scenarioId ? "a0" : "a1"}-${Date.now()}-${randomUUID().slice(0, 8)}`;
const runDir = resolve(rootDir, "work/pa1-runs", runId);
await mkdir(resolve(rootDir, "work/pa1-runs"), { recursive: true });
await mkdir(runDir, { recursive: false });
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
const results = [];
let runningEstimatedCostUsd = 0;
const reservePerNextScenarioUsd = 0.15;

for (const scenario of scenarios) {
  if (results.length > 0 && runningEstimatedCostUsd + reservePerNextScenarioUsd > budgetUsd) break;
  const scenarioDir = resolve(runDir, scenario.id);
  await mkdir(scenarioDir, { recursive: false });
  const statePath = resolve(scenarioDir, "state.json");
  const tracePath = resolve(scenarioDir, "trace.json");
  const { store, service } = await createRuntime({ statePath });
  const before = await store.read();
  const agent = new ResponsesAgent(service, {
    tracePath,
    fixturePath,
    model: "gpt-5.6-sol",
    reasoningEffort: "high"
  });
  let result = null;
  let caught = null;
  try {
    result = await agent.run({ credential: scenario.credential, input: scenario.input });
  } catch (error) {
    caught = { name: error.name ?? "Error", message: String(error.message ?? "error").slice(0, 300) };
  }
  const trace = JSON.parse(await readFile(tracePath, "utf8"));
  const after = await store.read();
  const actualOutcome = result?.outcome ?? (trace.terminationReason === "authentication_error" ? "REJECT" : null);
  const inputTokens = trace.events
    .filter((event) => event.type === "model_response")
    .map((event) => event.usage?.input_tokens)
    .filter((value) => Number.isFinite(value));
  const nondecreasingInputTokens = inputTokens.every((value, index) => index === 0 || value >= inputTokens[index - 1]);
  results.push({
    scenarioId: scenario.id,
    expectedOutcome: scenario.expectedOutcome,
    actualOutcome,
    passed: actualOutcome === scenario.expectedOutcome && nondecreasingInputTokens,
    terminationReason: trace.terminationReason,
    tracePath,
    statePath,
    fixtureStateHash: hashState(fixture),
    preStateHash: hashState(before),
    postStateHash: hashState(after),
    inputTokens,
    nondecreasingInputTokens,
    usage: trace.usage,
    error: caught
  });
  const usage = trace.usage ?? {};
  runningEstimatedCostUsd += ((usage.input_tokens ?? 0) * 4 + (usage.output_tokens ?? 0) * 20) / 1_000_000;
  if (runningEstimatedCostUsd > budgetUsd) break;
}

const usage = results.reduce((total, item) => ({
  input_tokens: total.input_tokens + (item.usage?.input_tokens ?? 0),
  output_tokens: total.output_tokens + (item.usage?.output_tokens ?? 0),
  reasoning_tokens: total.reasoning_tokens + (item.usage?.reasoning_tokens ?? 0)
}), { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0 });
const estimatedCostUsd = (usage.input_tokens * 4 + usage.output_tokens * 20) / 1_000_000;
const record = {
  schemaVersion: 1,
  runId,
  stage: scenarioId ? "A0" : "A1",
  dataset: "development",
  model: "gpt-5.6-sol",
  reasoningEffort: "high",
  scenarioCount: results.length,
  plannedScenarioCount: scenarios.length,
  passed: results.filter((item) => item.passed).length,
  failed: results.filter((item) => !item.passed).length,
  usage,
  pricingUsdPerMillion: { input: 4, output: 20, checkedOn: "2026-09-20" },
  estimatedCostUsd: Number(estimatedCostUsd.toFixed(6)),
  authorizedBudgetUsd: budgetUsd,
  stoppedForBudget: results.length < scenarios.length || estimatedCostUsd > budgetUsd,
  results
};
const recordPath = resolve(runDir, "run.json");
await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
const ok = record.failed === 0 && !record.stoppedForBudget;
console.log(JSON.stringify({ ok, recordPath, ...record }, null, 2));
if (!ok) process.exitCode = 1;
