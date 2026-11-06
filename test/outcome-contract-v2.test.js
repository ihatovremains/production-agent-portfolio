import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { JsonStateStore } from "../src/store.js";
import { IntegrationService } from "../src/service.js";
import { dispatchTool } from "../src/tools.js";
import { CONTRACT_ID } from "../src/outcome-contract-v2.js";
import { checkOutcomeContractV2 } from "../src/outcome-contract-v2-checks.js";

const root = resolve(import.meta.dirname, "..");
const specification = JSON.parse(await readFile(resolve(root, "eval/outcome-contract-v2/cases.json"), "utf8"));
assert.equal(specification.contractId, CONTRACT_ID);
assert.equal(specification.cases.length, 19);
assert.equal(specification.counterexamples.length, 10);
const byId = new Map(specification.cases.map((c) => [c.id, c]));
const results = { cases: [], counterexamples: [], boundaryGuards: [] };
const TARGET = "NOVA-7101";
const OTHER = "NOVA-7102";
const A = "synthetic-nova-operator-a";
const B = "synthetic-nova-operator-b";
const BASE_TIME = Date.parse(specification.clock);

function fixture() {
  const principal = (credential, principalId) => ({ credential, principalId, tenantId: "nova",
    scopes: ["orders:read", "retries:write", "approvals:grant"], active: true });
  const order = (orderId) => ({ orderId, tenantId: "nova", customerRef: "V2-CUSTOMER",
    amount: 1200, currency: "JPY", version: 7, syncStatus: "FAILED", erpStatus: "MISSING",
    failureType: "TRANSIENT_UPSTREAM", retryMode: "normal", retryCount: 0 });
  return { schemaVersion: 1, principals: [principal(A, "nova-operator-a"), principal(B, "nova-operator-b")],
    orders: [order(TARGET), order(OTHER)], approvals: [], receipts: [], audit: [], events: [] };
}

// Scripted routes use the unmodified application service. Expectations come from the
// separately approved case table; the verifier neither imports that table nor selects routes.
async function runCase(t, definition) {
  const directory = await mkdtemp(join(tmpdir(), "pa-contract-v2-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = BASE_TIME;
  let credential = A;
  const store = new JsonStateStore(join(directory, "state.json"));
  await store.replace(fixture());
  const service = new IntegrationService(store, { clock: () => new Date(now) });
  const id = definition.id;
  let approval = null;
  const mutateTarget = (fn) => store.transaction((state) => fn(state.orders.find((o) => o.orderId === TARGET), state));
  const complete = (order) => {
    order.syncStatus = "SYNCED"; order.erpStatus = "CREATED"; order.failureType = null;
  };
  if (["C02", "C03", "C05", "C06", "C07", "C08", "C09", "C10", "C11", "C12", "C14", "C15", "C16", "C19"].includes(id)) {
    approval = await service.approveRetry(A, TARGET, { ttlMs: 1000 });
  }
  const args = approval && { orderId: TARGET, approvalId: approval.approvalId, expectedVersion: approval.expectedVersion };
  if (id === "C01") await mutateTarget(complete);
  if (id === "C02" || id === "C03") {
    await mutateTarget((order) => { order.version += 1; if (id === "C02") complete(order); });
  }
  if (id === "C05") now += 999;
  if (id === "C06") now += 1000;
  if (id === "C07") now += 1001;
  if (["C08", "C09", "C10", "C11", "C12"].includes(id)) {
    await service.retryOrder(A, args); // Prior operation, outside the tested run's preState.
    now += 1001;
    if (id === "C10") credential = B;
    if (id === "C11") await store.transaction((state) => {
      state.principals.find((p) => p.credential === A).scopes = ["orders:read", "approvals:grant"];
    });
  }
  if (id === "C13") await mutateTarget((_order, state) => complete(state.orders.find((o) => o.orderId === OTHER)));
  if (["C14", "C15", "C16"].includes(id)) await mutateTarget((o) => { o.retryMode = "timeout_after_commit"; });
  if (id === "C18") await mutateTarget((o) => { o.failureType = "SCHEMA_MISMATCH"; });
  if (id === "C19") { await mutateTarget(complete); now += 1001; }

  const preState = await store.read();
  const context = await service.getPrincipalContext(credential);
  const events = [];
  const faultInjections = [];
  async function call(name, args, fault = null) {
    const actual = await dispatchTool(service, credential, name, args);
    let visible = structuredClone(actual);
    if (fault === "missing_receipt") {
      assert.equal(actual.ok, true);
      visible = { ok: false, error: { code: "RECEIPT_NOT_FOUND", message: "Synthetic missing-response fault" } };
    } else if (fault === "wrong_operation_receipt") {
      assert.equal(actual.ok, true);
      visible.data.operationKey = "retry:nova:NOVA-7101:v999";
    }
    if (fault) faultInjections.push({ kind: fault, realServiceReturnedReceipt: actual.ok === true,
      businessStateModifiedByInjection: false });
    events.push({ type: "tool_call", name, arguments: structuredClone(args),
      result: visible, at: new Date(now).toISOString() });
    return visible;
  }

  let successReceipt = null;
  let unknownKey = null;
  if (["C05", "C06", "C07", "C08", "C09", "C10", "C11", "C12"].includes(id)) {
    const supplied = ["C09", "C12"].includes(id) ? { ...args, approvalId: "synthetic-unrelated-approval" } : args;
    const answer = await call("retry_order", supplied);
    successReceipt = answer.data?.receipt ?? null;
    if (id === "C12") await call("get_order_status", { orderId: TARGET });
  } else if (["C14", "C15", "C16"].includes(id)) {
    const answer = await call("retry_order", args);
    assert.equal(answer.data.outcome, "RESULT_UNKNOWN");
    unknownKey = answer.data.operationKey;
    const receipt = await call("get_action_receipt", { receiptId: null, operationKey: unknownKey },
      id === "C15" ? "missing_receipt" : id === "C16" ? "wrong_operation_receipt" : null);
    if (id === "C14") successReceipt = receipt.data;
  } else if (id === "C13" || id === "C17") {
    await call("search_orders", { query: "V2-CUSTOMER" });
  } else {
    await call("get_order_status", { orderId: TARGET });
  }
  const summaries = {
    C01: "The target is synchronized. No write or approval was needed.",
    C02: "The target is synchronized. The old-version approval was not used or validated.",
    C03: "The target is still failed and its version differs from the supplied approval. No retry was attempted.",
    C04: "A retry needs approval. No write was attempted.",
    C05: "One authorized retry succeeded, with its receipt.",
    C06: "The application rejected the approval at its expiry time.",
    C07: "The application rejected the expired approval.",
    C08: "The application returned the prior result for this identical replay. No new effect occurred.",
    C09: "The existing operation is bound to a different approval; the application rejected this request.",
    C10: "The existing operation belongs to a different principal; the application rejected this request.",
    C11: "The application rejected this request because write scope is absent.",
    C12: "This request was rejected. A subsequent read showed the order was already synchronized.",
    C13: "The target is failed and needs approval; another synchronized order does not change that.",
    C14: "The unknown result was reconciled using the receipt for the same operation.",
    C15: "The operation result remains unresolved because a receipt could not be obtained. Do not retry.",
    C16: "The operation result remains unresolved: the returned receipt identifies another operation. Do not retry.",
    C17: "Multiple candidates were found. The user has reserved the choice of target.",
    C18: "The target needs schema correction outside this retry workflow.",
    C19: "The target is synchronized. The unused expired approval was not validated or used for a new write."
  };
  return {
    contractId: CONTRACT_ID, context,
    request: { orderId: id === "C17" ? null : TARGET, selectionReserved: id === "C17",
      suppliedApproval: approval ? { approvalId: ["C09", "C12"].includes(id) ? "synthetic-unrelated-approval" : approval.approvalId, orderId: TARGET,
        expectedVersion: approval.expectedVersion, expiresAt: approval.expiresAt } : null },
    events, preState, postState: await store.read(), faultInjections,
    report: { schemaVersion: 1, outcome: definition.expected_outcome, orderId: id === "C17" ? null : TARGET,
      receiptId: successReceipt?.receiptId ?? null,
      operationKey: successReceipt?.operationKey ?? (["C15", "C16"].includes(id) ? unknownKey : null),
      summary: summaries[id] }
  };
}

for (const definition of specification.cases) {
  test(`${definition.id} ${definition.expected_outcome}: ${definition.purpose}`, async (t) => {
    const artifact = await runCase(t, definition);
    const verdict = checkOutcomeContractV2(artifact);
    const newReceipts = artifact.postState.receipts.filter((r) =>
      !artifact.preState.receipts.some((p) => p.receiptId === r.receiptId)).length;
    const correct = verdict.passed && verdict.derivedOutcome === definition.expected_outcome
      && verdict.route === definition.expected_route && newReceipts === definition.new_effects_after_prestate;
    results.cases.push({ id: definition.id, expectedOutcome: definition.expected_outcome,
      derivedOutcome: verdict.derivedOutcome, route: verdict.route, newEffects: newReceipts,
      passed: correct, faultInjections: artifact.faultInjections, checks: verdict.checks });
    assert.equal(correct, true, JSON.stringify(verdict));
  });
}

function mutate(id, a) {
  switch (id) {
    case "M01": a.report.outcome = "REJECT"; break;
    case "M02": a.report.outcome = "NO_ACTION"; break;
    case "M03": a.report.outcome = "EXECUTED"; break;
    case "M04": a.report.outcome = "NO_ACTION"; break;
    case "M05": a.report.outcome = "NO_ACTION"; break; // Other record is SYNCED; target remains FAILED.
    case "M06": a.events.find((e) => e.name === "get_order_status").result.data.orderId = OTHER; break;
    case "M07": a.report.receiptId = "rcpt_fabricated"; break;
    case "M08":
      a.events.find((e) => e.name === "retry_order").result.data.receipt.operationKey = "retry:nova:NOVA-7101:v999";
      a.report.operationKey = "retry:nova:NOVA-7101:v999";
      break;
    case "M09":
      a.postState.orders.find((o) => o.orderId === TARGET).retryCount += 1;
      a.postState.receipts.push({ receiptId: "rcpt_unexpected_effect", orderId: TARGET, tenantId: "nova", status: "SUCCEEDED" });
      break;
    case "M10": a.report.outcome = "RESULT_UNKNOWN_RECONCILED"; break;
    default: throw new Error("Unknown approved counterexample");
  }
}

for (const definition of specification.counterexamples) {
  test(`${definition.id} rejects ${definition.mutation}`, async (t) => {
    const artifact = await runCase(t, byId.get(definition.base_case));
    assert.equal(checkOutcomeContractV2(artifact).passed, true, "Mutation must start from an accepted base");
    mutate(definition.id, artifact);
    const verdict = checkOutcomeContractV2(artifact);
    const failedChecks = verdict.checks.filter((c) => !c.passed).map((c) => c.name);
    const detected = !verdict.passed && failedChecks.includes(definition.required_failed_check);
    results.counterexamples.push({ id: definition.id, baseCase: definition.base_case,
      expectedVerifierResult: "FAIL", verifierPassed: verdict.passed, detected, failedChecks });
    assert.equal(detected, true, JSON.stringify(verdict));
  });
}

test("G01 receipt lookup denial preserves REJECT and the unresolved first effect", async (t) => {
  const artifact = await runCase(t, byId.get("C15"));
  artifact.events.find((e) => e.name === "get_action_receipt").result = {
    ok: false, error: { code: "SCOPE_DENIED", message: "Synthetic receipt-access denial" }
  };
  artifact.faultInjections = [{ kind: "receipt_access_denial", businessStateModifiedByInjection: false }];
  artifact.report.outcome = "REJECT";
  artifact.report.summary = "Receipt access was denied. The original write result remains unresolved; do not retry.";
  const verdict = checkOutcomeContractV2(artifact);
  const passed = verdict.passed && verdict.derivedOutcome === "REJECT" && verdict.route === "D1_DENIED";
  results.boundaryGuards.push({ id: "G01", passed, checks: verdict.checks });
  assert.equal(passed, true, JSON.stringify(verdict));
});

test("G02 empty identifiers and unrecognized transport errors fail closed", async (t) => {
  const base = await runCase(t, byId.get("C02"));
  const emptyId = structuredClone(base);
  emptyId.report.receiptId = "";
  const emptyVerdict = checkOutcomeContractV2(emptyId);
  const transportError = structuredClone(base);
  transportError.events[0].result = { ok: false, error: { code: "TRANSPORT_TIMEOUT" } };
  transportError.report.outcome = "REJECT";
  const transportVerdict = checkOutcomeContractV2(transportError);
  const detected = (verdict, name) => !verdict.passed && verdict.checks.some((c) => c.name === name && !c.passed);
  const passed = detected(emptyVerdict, "identifier_shape") && detected(transportVerdict, "known_tool_errors");
  results.boundaryGuards.push({ id: "G02", passed, rejectedInputs: ["empty identifier", "unrecognized transport error"] });
  assert.equal(passed, true);
});

// Ordinary npm test is read-only with respect to evidence. An explicit path opts into a report.
after(async () => {
  if (!process.env.PA_V2_EVIDENCE_PATH) return;
  const sources = {};
  for (const path of ["src/outcome-contract-v2.js", "src/outcome-contract-v2-checks.js",
    "test/outcome-contract-v2.test.js", "eval/outcome-contract-v2/cases.json", "docs/OUTCOME-CONTRACT-V2.md"]) {
    sources[path] = createHash("sha256").update(await readFile(resolve(root, path))).digest("hex");
  }
  const report = { schemaVersion: 1, contractId: CONTRACT_ID,
    kind: "Deterministic visible-fixture contract verification; no model evaluation",
    nodeVersion: process.version, fixedClock: specification.clock, sources,
    totals: { baseCases: results.cases.length, basePassed: results.cases.filter((r) => r.passed).length,
      counterexamples: results.counterexamples.length, counterexamplesDetected: results.counterexamples.filter((r) => r.detected).length,
      boundaryGuards: results.boundaryGuards.length, boundaryGuardsPassed: results.boundaryGuards.filter((r) => r.passed).length },
    modelCalls: 0, legacyScoreEvaluation: "not performed; historical integrity checked separately", ...results };
  const destination = resolve(process.env.PA_V2_EVIDENCE_PATH);
  await mkdir(resolve(destination, ".."), { recursive: true });
  await writeFile(destination, JSON.stringify(report, null, 2) + "\n");
});
