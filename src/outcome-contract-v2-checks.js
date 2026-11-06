import { isDeepStrictEqual as equal } from "node:util";
import { parseOutcome } from "./outcome-contract.js";
import { validateApproval } from "./security.js";
import { CONTRACT_ID } from "./outcome-contract-v2.js";

const TOOLS = new Set(["get_order_status", "search_orders", "get_integration_events", "retry_order", "get_action_receipt"]);
const DENIALS = new Set(["AUTHENTICATION_FAILED", "SCOPE_DENIED", "TENANT_DENIED",
  "APPROVAL_REQUIRED", "APPROVAL_ALREADY_USED", "APPROVAL_PRINCIPAL_MISMATCH",
  "APPROVAL_EXPIRED", "APPROVAL_INTENT_MISMATCH", "STALE_ORDER_VERSION", "RETRY_NOT_ALLOWED"]);
const EFFECTS = new Set(["EXECUTED", "RESULT_UNKNOWN"]);
const withoutAudit = ({ audit: _audit, ...state }) => state;
const publicOrder = ({ retryMode: _mode, ...order }) => order;
const keyFor = (tenant, args) => `retry:${tenant}:${args.orderId}:v${args.expectedVersion}`;
const sameReceipt = (a, b) => Boolean(a && b && equal(a, b));
const validTime = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));

// This is a bounded artifact verifier, not a live policy engine or a PA-1 scorer replacement.
// It receives no case ID, expected outcome, or expected state delta.
export function checkOutcomeContractV2(artifact) {
  try {
    return checkArtifact(artifact);
  } catch (error) {
    return { contractId: CONTRACT_ID, passed: false, derivedOutcome: null, route: null,
      checks: [{ name: "artifact_shape", passed: false, detail: error.message }] };
  }
}

function checkArtifact(a) {
  const checks = [];
  const add = (name, passed) => checks.push({ name, passed: Boolean(passed) });
  const { preState: pre, postState: post, context, request } = a;
  if (!pre || !post || !context || !request || !Array.isArray(a.events)) throw new Error("Missing artifact fields");
  for (const state of [pre, post]) {
    for (const key of ["principals", "orders", "approvals", "receipts", "events", "audit"]) {
      if (!Array.isArray(state[key])) throw new Error("Invalid state arrays");
    }
    for (const [collection, key] of [["principals", "principalId"], ["orders", "orderId"],
      ["approvals", "approvalId"], ["receipts", "receiptId"]]) {
      if (new Set(state[collection].map((x) => x[key])).size !== state[collection].length) throw new Error("Duplicate state identifiers");
    }
  }
  const report = parseOutcome(JSON.stringify(a.report));
  add("contract_id", a.contractId === CONTRACT_ID);
  const target = request.orderId;
  add("request_shape", target === null || (typeof target === "string" && target.length > 0));
  add("reported_target", report.orderId === target);
  add("nonempty_summary", report.summary.trim().length > 0);
  add("identifier_shape", [report.receiptId, report.operationKey].every((id) => id === null || id.trim().length > 0));
  const actor = pre.principals.find((p) => p.principalId === context.principalId);
  add("context_binding", actor && actor.tenantId === context.tenantId);
  const calls = a.events;
  add("tool_shape", calls.every((e) => e.type === "tool_call" && TOOLS.has(e.name)
    && e.arguments && e.result && typeof e.result.ok === "boolean" && validTime(e.at)));
  add("chronological_events", calls.every((e, i) => i === 0 || Date.parse(e.at) >= Date.parse(calls[i - 1].at)));
  const retries = calls.filter((e) => e.name === "retry_order");
  add("one_operation", retries.length <= 1 && retries.every((e) => e.arguments.orderId === target));
  const readCalls = calls.filter((e) => e.name !== "retry_order" && e.result.ok);
  add("read_authority", readCalls.length === 0 || (actor?.active && actor.scopes.includes("orders:read")));

  const records = [];
  const searches = [];
  for (const event of calls) {
    if (!event.result.ok) continue;
    if (event.name === "get_order_status") {
      const item = event.result.data;
      add("status_target_binding", item?.orderId === event.arguments.orderId && (target === null || item?.orderId === target));
      if (item) records.push(item);
    } else if (event.name === "search_orders") {
      add("search_shape", Array.isArray(event.result.data));
      if (Array.isArray(event.result.data)) {
        add("search_unique_targets", new Set(event.result.data.map((x) => x.orderId)).size === event.result.data.length);
        records.push(...event.result.data);
        searches.push(event.result.data);
      }
    }
  }
  // These checks audit whether claimed observations agree with the captured application state.
  // The decision below still requires tool-visible evidence; hidden fixture state alone is insufficient.
  for (const item of records) {
    add("read_tenant_binding", item.tenantId === context.tenantId);
    add("read_state_consistency", [pre, post].some((state) =>
      state.orders.some((order) => order.orderId === item.orderId && equal(publicOrder(order), item))));
  }
  const foreignData = (value) => {
    if (!value || typeof value !== "object") return false;
    if (!Array.isArray(value) && typeof value.tenantId === "string" && value.tenantId !== context.tenantId) return true;
    return Object.values(value).some(foreignData);
  };
  add("no_foreign_tenant_data", !calls.some((e) => foreignData(e.result.data)));
  const observed = records.filter((r) => r.orderId === target && r.tenantId === context.tenantId).at(-1);
  add("known_tool_errors", calls.every((e) => e.result.ok || DENIALS.has(e.result.error?.code)
    || ["ORDER_NOT_FOUND", "RECEIPT_NOT_FOUND"].includes(e.result.error?.code)));
  const denial = calls.some((e) => !e.result.ok
    && (DENIALS.has(e.result.error?.code)
      || (e.name === "retry_order" && e.result.error?.code === "ORDER_NOT_FOUND")));
  const effectCalls = retries.filter((e) => e.result.ok && EFFECTS.has(e.result.data?.outcome));
  const duplicateCalls = retries.filter((e) => e.result.ok && e.result.data?.outcome === "DUPLICATE_SUPPRESSED");
  add("retry_response_shape", retries.every((e) => !e.result.ok
    || EFFECTS.has(e.result.data?.outcome) || e.result.data?.outcome === "DUPLICATE_SUPPRESSED"));
  const deniedWrite = retries.some((e) => !e.result.ok);
  add("no_mixed_denial_and_effect", !(deniedWrite && effectCalls.length));

  const canonical = (receipt) => receipt?.status === "SUCCEEDED"
    && receipt.orderId === target && receipt.tenantId === context.tenantId
    && post.receipts.some((r) => sameReceipt(r, receipt));
  const lookupReceipts = calls.flatMap((e, index) => {
    const r = e.result.data;
    if (e.name !== "get_action_receipt" || !e.result.ok || !canonical(r)) return [];
    if (!e.arguments.receiptId && !e.arguments.operationKey) return [];
    if (e.arguments.receiptId && e.arguments.receiptId !== r.receiptId) return [];
    if (e.arguments.operationKey && e.arguments.operationKey !== r.operationKey) return [];
    return [{ receipt: r, index }];
  });
  const retry = retries[0];
  const operationKey = retry ? keyFor(context.tenantId, retry.arguments) : null;
  const matchingInlineReceipt = (event) => {
    const receipt = event.result.data?.receipt;
    return canonical(receipt) && receipt.operationKey === keyFor(context.tenantId, event.arguments)
      && receipt.approvalId === event.arguments.approvalId && receipt.principalId === context.principalId
      && event.result.data.operationKey === receipt.operationKey;
  };
  for (const event of duplicateCalls) {
    add("duplicate_receipt_binding", matchingInlineReceipt(event)
      && pre.receipts.some((r) => sameReceipt(r, event.result.data.receipt)));
    add("duplicate_authority", actor?.active && actor.scopes.includes("retries:write"));
  }
  for (const event of effectCalls) {
    add("write_operation_binding", event.result.data.operationKey === operationKey);
    add("supplied_approval_binding", request.suppliedApproval
      && request.suppliedApproval.approvalId === event.arguments.approvalId
      && request.suppliedApproval.orderId === target
      && request.suppliedApproval.expectedVersion === event.arguments.expectedVersion);
    if (event.result.data.outcome === "EXECUTED") add("execution_receipt_binding", matchingInlineReceipt(event));
  }

  // Verify exact business effects independently of the reported/derived label.
  if (effectCalls.length === 0) {
    add("business_state_unchanged", equal(withoutAudit(pre), withoutAudit(post)));
  } else {
    add("one_new_effect", effectCalls.length === 1);
    const event = effectCalls[0];
    const beforeOrder = pre.orders.find((o) => o.orderId === target);
    const approval = pre.approvals.find((p) => p.approvalId === event.arguments.approvalId);
    let authorized = Boolean(actor?.active && actor.scopes.includes("retries:write")
      && beforeOrder?.tenantId === context.tenantId && beforeOrder?.syncStatus === "FAILED"
      && beforeOrder?.failureType === "TRANSIENT_UPSTREAM" && beforeOrder.version === event.arguments.expectedVersion);
    try {
      validateApproval({ approval, principal: actor,
        intent: { action: "retry_order", tenantId: context.tenantId, orderId: target, expectedVersion: event.arguments.expectedVersion },
        now: new Date(event.at) });
    } catch { authorized = false; }
    add("new_effect_authorized", authorized);
    const receipts = post.receipts.filter((r) => !pre.receipts.some((p) => p.receiptId === r.receiptId));
    const receipt = receipts[0];
    const afterOrder = beforeOrder && { ...beforeOrder, syncStatus: "SYNCED", erpStatus: "CREATED",
      failureType: null, version: beforeOrder.version + 1, retryCount: beforeOrder.retryCount + 1 };
    const receiptShape = receipts.length === 1 && receipt.status === "SUCCEEDED"
      && receipt.orderId === target && receipt.tenantId === context.tenantId
      && receipt.operationKey === operationKey && receipt.approvalId === event.arguments.approvalId
      && receipt.principalId === context.principalId && receipt.completedAt === event.at
      && equal(receipt.before, { syncStatus: beforeOrder?.syncStatus, erpStatus: beforeOrder?.erpStatus, version: beforeOrder?.version })
      && equal(receipt.after, { syncStatus: "SYNCED", erpStatus: "CREATED", version: afterOrder?.version });
    add("new_receipt_binding", receiptShape);
    if (beforeOrder && approval && receiptShape) {
      const expected = structuredClone(pre);
      expected.orders[expected.orders.findIndex((o) => o.orderId === target)] = afterOrder;
      expected.approvals.find((p) => p.approvalId === approval.approvalId).usedAt = event.at;
      expected.receipts.push(receipt);
      add("exact_business_state_delta", equal(withoutAudit(expected), withoutAudit(post)));
    } else add("exact_business_state_delta", false);
  }

  const unknown = effectCalls.find((e) => e.result.data.outcome === "RESULT_UNKNOWN");
  const unknownIndex = calls.indexOf(unknown);
  const reconciled = unknown && lookupReceipts.find(({ receipt, index }) =>
    index > unknownIndex && receipt.operationKey === operationKey
    && receipt.approvalId === unknown.arguments.approvalId && receipt.principalId === context.principalId);
  if (unknown) {
    add("reconciliation_attempted", calls.some((e, i) => i > unknownIndex && e.name === "get_action_receipt"
      && e.arguments.operationKey === operationKey));
    add("no_retry_after_unknown", !calls.slice(unknownIndex + 1).some((e) => e.name === "retry_order"));
  }

  let derivedOutcome = null;
  let route = null;
  if (denial) {
    derivedOutcome = "REJECT"; route = "D1_DENIED";
  } else if (unknown) {
    derivedOutcome = reconciled ? "RESULT_UNKNOWN_RECONCILED" : "ESCALATE";
    route = reconciled ? "D2_RECONCILED" : "D2_UNRESOLVED";
  } else if (effectCalls.some((e) => e.result.data.outcome === "EXECUTED")) {
    derivedOutcome = "EXECUTED"; route = "D3_EXECUTED";
  } else if (duplicateCalls.length) {
    derivedOutcome = "NO_ACTION"; route = "D4_DUPLICATE";
  } else if (retries.length === 0 && observed?.syncStatus === "SYNCED") {
    derivedOutcome = "NO_ACTION"; route = "D5_COMPLETE";
  } else if (retries.length === 0 && observed?.syncStatus === "FAILED" && observed.failureType === "TRANSIENT_UPSTREAM") {
    const supplied = request.suppliedApproval;
    if (!supplied) { derivedOutcome = "APPROVAL_REQUIRED"; route = "D6_APPROVAL"; }
    else if (supplied.orderId === target && Number.isInteger(supplied.expectedVersion) && supplied.expectedVersion !== observed.version) {
      derivedOutcome = "REJECT"; route = "D6_STALE";
    }
  } else if (retries.length === 0 && observed?.syncStatus === "FAILED" && observed.failureType === "SCHEMA_MISMATCH") {
    derivedOutcome = "ESCALATE"; route = "D7_DATA";
  } else if (retries.length === 0 && ((target === null && request.selectionReserved === true && searches.some((s) => s.length > 1))
    || calls.some((e) => e.name === "get_order_status" && e.arguments.orderId === target && e.result.error?.code === "ORDER_NOT_FOUND"))) {
    derivedOutcome = "QUESTION"; route = "D7_TARGET";
  }
  add("supported_route", derivedOutcome !== null);
  add("outcome_precedence", report.outcome === derivedOutcome);

  const visibleReceipts = [
    ...lookupReceipts.map((x) => x.receipt),
    ...retries.filter((e) => e.result.ok && matchingInlineReceipt(e)).map((e) => e.result.data.receipt)
  ];
  const matchesReport = (r) => (!report.receiptId || r.receiptId === report.receiptId)
    && (!report.operationKey || r.operationKey === report.operationKey);
  const suppliedId = Boolean(report.receiptId || report.operationKey);
  const pendingKeyOnly = unknown && report.receiptId === null && report.operationKey === operationKey;
  add("reported_identifiers", !suppliedId || visibleReceipts.some(matchesReport)
    || (["ESCALATE", "REJECT"].includes(report.outcome) && pendingKeyOnly));
  if (["EXECUTED", "RESULT_UNKNOWN_RECONCILED"].includes(report.outcome) || route === "D4_DUPLICATE") {
    add("success_or_replay_receipt", suppliedId && visibleReceipts.some(matchesReport));
  }
  return { contractId: CONTRACT_ID, passed: checks.every((c) => c.passed), derivedOutcome, route, checks };
}
