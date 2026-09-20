import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { outcomeSchema } from "./outcome-contract.js";
import { prepareScenario, hashState } from "./pa1-harness.js";
import { scoreTrial, summarizeScores } from "./pa1-scorer.js";
import { createScriptedTransport } from "./pa1-scripted-transport.js";
import { EFFECTIVE_INSTRUCTIONS, ResponsesAgent } from "./responses-agent.js";
import { toolDefinitions } from "./tools.js";

export const ROOT = resolve(import.meta.dirname, "..");
const HOLDOUT_DIR = resolve(ROOT, "eval/holdout");
export const FILE_TARGETS = [
  "src/responses-agent.js", "src/outcome-contract.js", "src/tools.js", "src/service.js", "src/security.js",
  "src/store.js", "src/runtime.js", "src/errors.js", "src/pa1-harness.js", "src/pa1-baseline-runner.js",
  "src/pa1-scorer.js", "src/pa1-runner.js", "src/pa1-scripted-transport.js",
  "eval/pa1/termination-classification.json", "eval/pa1/execution-plan.json",
  "eval/holdout/scenarios.json", "eval/holdout/expected.json", "eval/holdout/fixture.json", "eval/holdout/scoring-rules.json"
];
const POLICIES = ["exemplar", "always_refuse", "always_retry", "claim_success_without_receipt", "always_question", "read_only_diagnoser"];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fileHash(path) {
  return sha256(await readFile(path));
}

export async function computeFreezeTargets({ root = ROOT } = {}) {
  const files = {};
  for (const path of FILE_TARGETS) files[path] = await fileHash(resolve(root, path));
  return {
    effectiveInstructionsSha256: sha256(EFFECTIVE_INSTRUCTIONS),
    toolDefinitionsSha256: sha256(JSON.stringify(toolDefinitions)),
    outcomeSchemaSha256: sha256(JSON.stringify(outcomeSchema)),
    files
  };
}

function freezeDifferences(expected, actual) {
  const differences = [];
  for (const key of ["effectiveInstructionsSha256", "toolDefinitionsSha256", "outcomeSchemaSha256"]) {
    if (expected?.[key] !== actual?.[key]) differences.push(key);
  }
  const paths = new Set([...Object.keys(expected?.files ?? {}), ...Object.keys(actual?.files ?? {})]);
  for (const path of paths) if (expected?.files?.[path] !== actual?.files?.[path]) differences.push(path);
  return differences.sort();
}

export async function verifyFreeze({ root = ROOT, freezePath = resolve(root, "eval/pa1/freeze.json") } = {}) {
  const frozen = JSON.parse(await readFile(freezePath, "utf8"));
  for (const path of FILE_TARGETS) await readFile(resolve(root, path));
  const first = await computeFreezeTargets({ root });
  const second = await computeFreezeTargets({ root });
  const unstable = freezeDifferences(first, second);
  if (unstable.length > 0) throw new Error(`PA1_FREEZE_UNSTABLE:${unstable.join(",")}`);
  const mismatches = freezeDifferences(frozen.targets, second);
  if (mismatches.length > 0) throw new Error(`PA1_FREEZE_MISMATCH:${mismatches.join(",")}`);
  return second;
}

function suppliedApprovals(prepared) {
  return Object.values(prepared.context)
    .filter((item) => item?.approvalId)
    .map((item) => ({ approvalId: item.approvalId, orderId: item.orderId, expectedVersion: item.expectedVersion }));
}

function usageCost(usage, pricing) {
  const uncached = Math.max(0, (usage.input_tokens ?? 0) - (usage.cached_tokens ?? 0));
  return (uncached * pricing.input + (usage.cached_tokens ?? 0) * pricing.cachedInput + (usage.output_tokens ?? 0) * pricing.output) / 1_000_000;
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil((p / 100) * sorted.length) - 1];
}

function classify(reason, classification) {
  if (reason === "completed") return "completed";
  if (classification.infrastructure[reason]) return "infrastructure";
  return "agent_failure";
}

export function applyBudgetCap(costs, capUsd) {
  let spentUsd = 0;
  let executed = 0;
  for (const cost of costs) {
    if (spentUsd + cost > capUsd) break;
    spentUsd += cost;
    executed += 1;
  }
  return {
    capUsd: Number(capUsd.toFixed(6)),
    spentUsd: Number(spentUsd.toFixed(6)),
    executed,
    unexecuted: costs.length - executed,
    stoppedForBudget: executed < costs.length,
    rule: "unexecuted trials are excluded and require new approval"
  };
}

export function budgetAllowsAttempt(runningCost, reserve, budgetUsd) {
  return runningCost + reserve <= budgetUsd;
}

export async function runPipelineTrial({ scenario, expected, candidate, policy, trialDir, mode, injectInfrastructureFailure = false }) {
  await mkdir(trialDir, { recursive: false });
  const statePath = resolve(trialDir, "state.json");
  const tracePath = resolve(trialDir, "trace.json");
  const prepared = await prepareScenario({ scenario, fixturePath: resolve(HOLDOUT_DIR, "fixture.json"), statePath });
  const approvals = suppliedApprovals(prepared);
  const scripted = mode === "dry" ? createScriptedTransport({ policy, scenario, expected, prepared, injectInfrastructureFailure }) : null;
  const agent = new ResponsesAgent(prepared.service, {
    apiKey: mode === "dry" ? "dry-no-network" : process.env.OPENAI_API_KEY,
    model: candidate.model,
    reasoningEffort: candidate.reasoningEffort,
    tracePath,
    fixturePath: resolve(HOLDOUT_DIR, "fixture.json"),
    fetchImpl: scripted?.fetchImpl ?? globalThis.fetch,
    ...(mode === "dry" ? { sleepImpl: async () => {} } : {})
  });
  let result = null;
  let error = null;
  try {
    result = await agent.run({ credential: scenario.credential, input: prepared.input });
  } catch (caught) {
    error = { name: caught.name ?? "Error", message: String(caught.message ?? caught).slice(0, 300) };
  }
  const trace = JSON.parse(await readFile(tracePath, "utf8"));
  const postState = await prepared.store.read();
  const artifact = {
    schemaVersion: 2,
    scenarioId: scenario.id,
    category: scenario.category,
    input: prepared.input,
    userSuppliedApproval: approvals.some((item) => prepared.input.includes(item.approvalId)),
    suppliedApprovals: approvals,
    injections: scenario.injections ?? [],
    fixtureState: prepared.fixtureState,
    preState: prepared.preState,
    postState,
    stateHashes: { before: hashState(prepared.preState), after: hashState(postState) },
    trace,
    result: result ? { structuredOutcome: result.structuredOutcome } : null,
    error
  };
  const artifactPath = resolve(trialDir, "artifact.json");
  await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, { flag: "wx" });
  const latencySamples = mode === "dry"
    ? scripted.latencySamples
    : trace.events.filter((item) => item.type === "model_response").map((item) => item.latencyMs);
  return { artifact, artifactPath, latencySamples };
}

function deterministicRecord(grouped, policyGrouped, metadata) {
  const candidates = [...grouped.entries()].map(([candidateId, entries]) => {
    const scores = entries.map((item) => item.score);
    const usage = entries.reduce((total, item) => ({
      input_tokens: total.input_tokens + (item.usage.input_tokens ?? 0),
      output_tokens: total.output_tokens + (item.usage.output_tokens ?? 0),
      reasoning_tokens: total.reasoning_tokens + (item.usage.reasoning_tokens ?? 0),
      cached_tokens: total.cached_tokens + (item.usage.cached_tokens ?? 0)
    }), { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, cached_tokens: 0 });
    const latencies = entries.flatMap((item) => item.latencySamples);
    return {
      candidateId,
      summary: summarizeScores(scores),
      usage,
      estimatedCostUsd: Number(entries.reduce((sum, item) => sum + item.cost, 0).toFixed(6)),
      latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95), n: latencies.length }
    };
  });
  const scriptedPolicies = [...policyGrouped.entries()].map(([policy, scores]) => ({ policy, summary: summarizeScores(scores) }));
  return { schemaVersion: 2, candidates, scriptedPolicies, ...metadata };
}

export async function rescoreRun(runRecord) {
  const expected = JSON.parse(await readFile(resolve(HOLDOUT_DIR, "expected.json"), "utf8"));
  const expectedById = new Map(expected.map((item) => [item.id, item]));
  const grouped = new Map();
  const policyGrouped = new Map();
  for (const item of runRecord.trials.filter((trial) => trial.scored)) {
    const artifact = JSON.parse(await readFile(item.artifactPath, "utf8"));
    const score = scoreTrial(artifact, expectedById.get(item.scenarioId));
    const entry = { score, usage: artifact.trace.usage ?? {}, latencySamples: item.latencySamples, cost: item.estimatedCostUsd };
    if (item.group === "candidate") {
      grouped.set(item.candidateId, [...(grouped.get(item.candidateId) ?? []), entry]);
    } else {
      policyGrouped.set(item.policy, [...(policyGrouped.get(item.policy) ?? []), score]);
    }
  }
  return deterministicRecord(grouped, policyGrouped, runRecord.deterministicMetadata);
}

export async function runEvaluation({
  mode,
  runRoot,
  budgetUsd,
  checkOnly = false,
  infrastructureFailurePlan,
  evidencePath,
  scenarioIds,
  candidateRoles,
  trialsPerScenario,
  includeScriptedMatrix = true
}) {
  const freezeTargets = await verifyFreeze();
  const scenarios = JSON.parse(await readFile(resolve(HOLDOUT_DIR, "scenarios.json"), "utf8"));
  const expected = JSON.parse(await readFile(resolve(HOLDOUT_DIR, "expected.json"), "utf8"));
  const expectedById = new Map(expected.map((item) => [item.id, item]));
  const plan = JSON.parse(await readFile(resolve(ROOT, "eval/pa1/execution-plan.json"), "utf8"));
  const activeScenarios = scenarioIds ? scenarios.filter((item) => scenarioIds.includes(item.id)) : scenarios;
  const activeCandidates = candidateRoles ? plan.candidates.filter((item) => candidateRoles.includes(item.role)) : plan.candidates;
  const repetitions = trialsPerScenario ?? plan.sharedConfiguration.trialsPerScenarioPerModel;
  const classification = JSON.parse(await readFile(resolve(ROOT, "eval/pa1/termination-classification.json"), "utf8"));
  const runId = `pa1-${mode}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const runDir = resolve(runRoot, runId);
  await mkdir(runRoot, { recursive: true });
  await mkdir(runDir, { recursive: false });
  const trials = [];
  let runningCost = 0;
  const defaultFailurePlan = mode === "dry" && plan.candidates[1]
    ? { [`standin-${plan.candidates[1].role}:info-03:2`]: 1 }
    : {};
  const failurePlan = infrastructureFailurePlan ?? defaultFailurePlan;
  const previousAllow = process.env.PORTFOLIO_ALLOW_API;
  if (mode === "dry") process.env.PORTFOLIO_ALLOW_API = "true";
  try {
    for (const candidate of activeCandidates) {
      const candidateId = mode === "dry" ? `standin-${candidate.role}` : candidate.model;
      for (const scenario of activeScenarios) {
        for (let repetition = 1; repetition <= repetitions; repetition += 1) {
          const plannedTrialId = `${candidateId}:${scenario.id}:${repetition}`;
          const reserve = mode === "live" ? usageCost({ input_tokens: 10000, output_tokens: 1000 }, candidate.pricingUsdPerMillionTokens) : 0;
          if (!budgetAllowsAttempt(runningCost, reserve, budgetUsd)) {
            trials.push({ group: "candidate", candidateId, scenarioId: scenario.id, plannedTrialId, status: "unexecuted_budget", scored: false });
            continue;
          }
          const injectedFailures = mode === "dry" ? Number(failurePlan[plannedTrialId] ?? 0) : 0;
          let replacementUsed = false;
          for (let attempt = 1; attempt <= 2; attempt += 1) {
            const isInjectedFailure = attempt <= injectedFailures;
            const trialId = `${plannedTrialId}:attempt-${attempt}`;
            const trialDir = resolve(runDir, `trial-${trials.length + 1}-${basename(scenario.id)}`);
            const result = await runPipelineTrial({ scenario, expected: expectedById.get(scenario.id), candidate, policy: "exemplar", trialDir, mode, injectInfrastructureFailure: isInjectedFailure });
            const reason = result.artifact.trace.terminationReason;
            const classificationKind = classify(reason, classification);
            const usage = result.artifact.trace.usage ?? {};
            const cost = usageCost(usage, candidate.pricingUsdPerMillionTokens);
            runningCost += cost;
            const infrastructureFailure = classificationKind === "infrastructure";
            const replacementScheduled = infrastructureFailure && !replacementUsed;
            const unresolved = infrastructureFailure && replacementUsed;
            trials.push({ group: "candidate", candidateId, scenarioId: scenario.id, plannedTrialId, trialId, attempt, artifactPath: result.artifactPath, latencySamples: result.latencySamples, classification: classificationKind, replacementScheduled, unresolved, scored: !infrastructureFailure, estimatedCostUsd: cost });
            if (replacementScheduled) {
              replacementUsed = true;
              if (mode === "live" && !budgetAllowsAttempt(runningCost, reserve, budgetUsd)) {
                trials.push({ group: "candidate", candidateId, scenarioId: scenario.id, plannedTrialId, status: "unexecuted_budget_replacement", replacementFor: trialId, unresolved: true, scored: false });
                break;
              }
              continue;
            }
            break;
          }
        }
      }
    }
    if (mode === "dry" && includeScriptedMatrix) {
      const matrixRoot = resolve(runDir, "scripted-matrix");
      await mkdir(matrixRoot, { recursive: false });
      for (const policy of POLICIES) {
        for (const scenario of activeScenarios) {
          const candidate = plan.candidates[0];
          const trialDir = resolve(matrixRoot, `${policy}-${scenario.id}`);
          const result = await runPipelineTrial({ scenario, expected: expectedById.get(scenario.id), candidate, policy, trialDir, mode });
          const cost = usageCost(result.artifact.trace.usage ?? {}, candidate.pricingUsdPerMillionTokens);
          trials.push({ group: "policy", policy, scenarioId: scenario.id, trialId: `${policy}:${scenario.id}`, artifactPath: result.artifactPath, latencySamples: result.latencySamples, classification: classify(result.artifact.trace.terminationReason, classification), scored: true, estimatedCostUsd: cost });
        }
      }
    }
  } finally {
    if (mode === "dry") {
      if (previousAllow === undefined) delete process.env.PORTFOLIO_ALLOW_API;
      else process.env.PORTFOLIO_ALLOW_API = previousAllow;
    }
  }
  const candidateTrials = trials.filter((item) => item.group === "candidate");
  const unexecutedBudget = candidateTrials.filter((item) => item.status?.startsWith("unexecuted_budget")).length;
  const deterministicMetadata = {
    plannedCandidateTrials: activeCandidates.length * activeScenarios.length * repetitions,
    scoredCandidateTrials: candidateTrials.filter((item) => item.scored).length,
    infrastructureFailuresRetained: candidateTrials.filter((item) => item.classification === "infrastructure").length,
    replacementsExecuted: candidateTrials.filter((item) => item.attempt === 2).length,
    unresolvedInfrastructureTrials: new Set(candidateTrials.filter((item) => item.unresolved).map((item) => item.plannedTrialId)).size,
    budgetStop: {
      capUsd: Number(budgetUsd.toFixed(6)),
      spentUsd: Number(runningCost.toFixed(6)),
      unexecuted: unexecutedBudget,
      stoppedForBudget: unexecutedBudget > 0,
      rule: "unexecuted trials are excluded and require new approval"
    },
    latencySamplesMeasure: "individual model responses",
    freezeVerified: true,
    freezeTargets
  };
  const runRecord = { schemaVersion: 2, runId, mode, runDir, authorizedBudgetUsd: budgetUsd, runningEstimatedCostUsd: Number(runningCost.toFixed(6)), trials, deterministicMetadata };
  const scoreRecord = await rescoreRun(runRecord);
  await writeFile(resolve(runDir, "run.json"), `${JSON.stringify(runRecord, null, 2)}\n`, { flag: "wx" });
  await writeFile(resolve(runDir, "scores.json"), `${JSON.stringify(scoreRecord, null, 2)}\n`, { flag: "wx" });
  const resolvedEvidencePath = evidencePath === undefined ? resolve(ROOT, "outputs/pa1-dry-run-evidence.json") : evidencePath;
  const serialized = `${JSON.stringify(scoreRecord, null, 2)}\n`;
  if (mode === "dry" && resolvedEvidencePath) {
    if (checkOnly) {
      if (await readFile(resolvedEvidencePath, "utf8") !== serialized) throw new Error("PA1_DRY_EVIDENCE_MISMATCH");
    } else {
      await writeFile(resolvedEvidencePath, serialized, "utf8");
    }
  }
  return { runRecord, scoreRecord };
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args.includes("--live") ? "live" : "dry";
  const checkOnly = args.includes("--check");
  const includeScriptedMatrix = !args.includes("--no-scripted-matrix");
  const budgetIndex = args.indexOf("--budget-usd");
  const evidenceIndex = args.indexOf("--evidence-file");
  const budgetUsd = budgetIndex >= 0 ? Number(args[budgetIndex + 1]) : (mode === "dry" ? 10 : NaN);
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) throw new Error("--budget-usd <positive number> is required");
  if (mode === "live" && !args.includes("--approved-live-holdout")) throw new Error("--approved-live-holdout is required; a stopped run needs new approval to resume");
  if (mode === "live" && process.env.PORTFOLIO_ALLOW_API !== "true") throw new Error("PORTFOLIO_ALLOW_API=true is required");
  const temporary = checkOnly ? await mkdtemp(resolve(tmpdir(), "pa1-run-check-")) : null;
  const runRoot = temporary ?? resolve(ROOT, "work/pa1-holdout-runs");
  const evidencePath = evidenceIndex >= 0 ? resolve(ROOT, args[evidenceIndex + 1]) : undefined;
  try {
    const { runRecord, scoreRecord } = await runEvaluation({ mode, runRoot, budgetUsd, checkOnly, evidencePath, includeScriptedMatrix });
    console.log(JSON.stringify({ ok: true, mode, runDir: runRecord.runDir, candidates: scoreRecord.candidates.map((item) => ({ candidateId: item.candidateId, passed: item.summary.passed, total: item.summary.total })), scriptedPolicies: scoreRecord.scriptedPolicies.map((item) => ({ policy: item.policy, passed: item.summary.passed, total: item.summary.total })) }, null, 2));
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
