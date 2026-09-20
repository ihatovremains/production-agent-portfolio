import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "../src/runtime.js";
import { ResponsesAgent } from "../src/responses-agent.js";

const previousAllow = process.env.PORTFOLIO_ALLOW_API;
before(() => { process.env.PORTFOLIO_ALLOW_API = "true"; });
after(() => {
  if (previousAllow === undefined) delete process.env.PORTFOLIO_ALLOW_API;
  else process.env.PORTFOLIO_ALLOW_API = previousAllow;
});

function ok(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function functionCall(number, name, args, overrides = {}) {
  return {
    id: `resp_${number}`,
    status: overrides.responseStatus ?? "completed",
    incomplete_details: overrides.incompleteDetails ?? null,
    output: [
      {
        id: `rs_${number}`,
        type: "reasoning",
        encrypted_content: `encrypted_${number}`,
        summary: []
      },
      {
        id: `fc_${number}`,
        call_id: `call_${number}`,
        type: "function_call",
        status: overrides.callStatus ?? "completed",
        name,
        arguments: overrides.arguments ?? JSON.stringify(args)
      }
    ],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
  };
}

function finalResponse(number, summary, outcome = "APPROVAL_REQUIRED", overrides = {}) {
  const text = JSON.stringify({
    schemaVersion: 1,
    outcome,
    orderId: overrides.orderId ?? "ACME-1001",
    receiptId: overrides.receiptId ?? null,
    operationKey: overrides.operationKey ?? null,
    summary
  });
  return {
    id: `resp_${number}`,
    status: "completed",
    output: [{
      id: `msg_${number}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text }]
    }],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
  };
}

async function isolatedAgent(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "portfolio-responses-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtime = await createRuntime({ statePath: join(directory, "state.json") });
  const tracePath = join(directory, "trace.json");
  const agent = new ResponsesAgent(runtime.service, {
    apiKey: "test-key",
    endpoint: "https://example.invalid/v1/responses",
    tracePath,
    sleepImpl: async () => {},
    ...options
  });
  return { ...runtime, agent, tracePath };
}

function conversationItems(request) {
  return request.input.map((item) => ({ type: item.type ?? item.role, callId: item.call_id ?? null }));
}

test("sends the full conversation on every tool turn and records safe trace context", async (t) => {
  const requests = [];
  const script = [
    functionCall(1, "get_order_status", { orderId: "ACME-1001" }),
    functionCall(2, "get_integration_events", { orderId: "ACME-1001" }),
    finalResponse(3, "ACME-1001 requires an approval-bound retry.")
  ];
  const fetchImpl = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return ok(script[requests.length - 1]);
  };
  const { agent, tracePath } = await isolatedAgent(t, { fetchImpl });
  const userInput = "ACME-1001を調べて";
  const result = await agent.run({ credential: "cred-acme-operator", input: userInput });

  assert.equal(result.text, "ACME-1001 requires an approval-bound retry.");
  assert.equal(result.usage.total_tokens, 6);
  assert.equal(requests.length, 3);
  assert.deepEqual(conversationItems(requests[0]), [{ type: "user", callId: null }]);
  assert.deepEqual(conversationItems(requests[1]), [
    { type: "user", callId: null },
    { type: "reasoning", callId: null },
    { type: "function_call", callId: "call_1" },
    { type: "function_call_output", callId: "call_1" }
  ]);
  assert.deepEqual(conversationItems(requests[2]), [
    { type: "user", callId: null },
    { type: "reasoning", callId: null },
    { type: "function_call", callId: "call_1" },
    { type: "function_call_output", callId: "call_1" },
    { type: "reasoning", callId: null },
    { type: "function_call", callId: "call_2" },
    { type: "function_call_output", callId: "call_2" }
  ]);
  assert.deepEqual(requests[1].input[1], script[0].output[0]);
  assert.deepEqual(requests[2].input[4], script[1].output[0]);
  assert.ok(requests.every((request) => request.input[0].content === userInput));
  assert.ok(requests[0].tools.every((tool) => tool.strict === true));
  assert.equal(requests[0].text.format.type, "json_schema");
  assert.equal(requests[0].text.format.strict, true);
  for (const label of ["EXECUTED", "APPROVAL_REQUIRED", "QUESTION", "REJECT", "ESCALATE", "RESULT_UNKNOWN_RECONCILED", "NO_ACTION"]) {
    assert.match(requests[0].instructions, new RegExp(`- ${label}:`));
  }

  const trace = JSON.parse(await readFile(tracePath, "utf8"));
  assert.equal(trace.input, userInput);
  assert.equal(trace.principalId, "user-acme-ops-01");
  assert.equal(trace.tenantId, "acme");
  assert.equal(trace.terminationReason, "completed");
  assert.equal(trace.error, null);
  assert.match(trace.artifactHashes.instructionsSha256, /^[0-9a-f]{64}$/);
  assert.match(trace.artifactHashes.toolDefinitionsSha256, /^[0-9a-f]{64}$/);
  assert.match(trace.artifactHashes.outcomeSchemaSha256, /^[0-9a-f]{64}$/);
  assert.match(trace.artifactHashes.fixtureSha256, /^[0-9a-f]{64}$/);
  assert.match(trace.stateHashes.before, /^[0-9a-f]{64}$/);
  assert.match(trace.stateHashes.after, /^[0-9a-f]{64}$/);
  assert.equal(trace.structuredOutcome.outcome, "APPROVAL_REQUIRED");
  assert.equal(trace.limits.maxToolRounds, 8);
  const serialized = JSON.stringify({ requests, trace });
  assert.equal(serialized.includes("cred-acme-operator"), false);
  assert.equal(serialized.includes("test-key"), false);
});

test("preserves a user-supplied approval through a read-then-retry sequence", async (t) => {
  const requests = [];
  let approvalId;
  const fetchImpl = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    if (requests.length === 1) return ok(functionCall(1, "get_order_status", { orderId: "ACME-1001" }));
    if (requests.length === 2) {
      return ok(functionCall(2, "retry_order", { orderId: "ACME-1001", approvalId, expectedVersion: 3 }));
    }
    return ok(finalResponse(3, "Retry completed."));
  };
  const { agent, service, store } = await isolatedAgent(t, { fetchImpl });
  const approval = await service.approveRetry("cred-acme-operator", "ACME-1001");
  approvalId = approval.approvalId;
  const input = `ACME-1001を再処理して。approvalId=${approvalId} version=3`;
  const result = await agent.run({ credential: "cred-acme-operator", input });
  const state = await store.read();

  assert.equal(result.text, "Retry completed.");
  assert.ok(JSON.stringify(requests[1].input).includes(approvalId));
  assert.equal(result.trace.events.filter((event) => event.name === "retry_order").length, 1);
  assert.equal(result.trace.events.find((event) => event.name === "retry_order").result.data.outcome, "EXECUTED");
  assert.equal(state.receipts.length, 1);
  assert.equal(state.orders.find((order) => order.orderId === "ACME-1001").retryCount, 1);
});

test("retries a transient non-JSON overload and honors bounded Retry-After", async (t) => {
  const delays = [];
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    if (attempts === 1) {
      return new Response("overloaded", { status: 503, headers: { "retry-after": "1" } });
    }
    return ok(finalResponse(2, "Recovered after overload."));
  };
  const { agent } = await isolatedAgent(t, {
    fetchImpl,
    sleepImpl: async (milliseconds) => delays.push(milliseconds)
  });
  const result = await agent.run({ credential: "cred-acme-operator", input: "ACME-1001を調べて" });

  assert.equal(result.text, "Recovered after overload.");
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [1000]);
  assert.equal(result.trace.events.filter((event) => event.type === "model_retry").length, 1);
});

test("accepts a final answer after exactly maxToolRounds tool calls", async (t) => {
  let requests = 0;
  const fetchImpl = async () => {
    requests += 1;
    if (requests <= 2) return ok(functionCall(requests, "get_order_status", { orderId: "ACME-1001" }));
    return ok(finalResponse(3, "Final after the boundary."));
  };
  const { agent } = await isolatedAgent(t, { fetchImpl, maxToolRounds: 2 });
  const result = await agent.run({ credential: "cred-acme-operator", input: "ACME-1001を調べて" });

  assert.equal(result.text, "Final after the boundary.");
  assert.equal(requests, 3);
  assert.equal(result.trace.events.filter((event) => event.type === "tool_call").length, 2);
  assert.equal(result.trace.terminationReason, "completed");
});

test("does not execute a tool beyond maxToolRounds and persists the failure trace", async (t) => {
  let requests = 0;
  const fetchImpl = async () => {
    requests += 1;
    return ok(functionCall(requests, "get_order_status", { orderId: "ACME-1001" }));
  };
  const { agent, tracePath } = await isolatedAgent(t, { fetchImpl, maxToolRounds: 2 });
  await assert.rejects(
    agent.run({ credential: "cred-acme-operator", input: "ACME-1001を調べて" }),
    /exceeded 2 executed tool calls/
  );
  const trace = JSON.parse(await readFile(tracePath, "utf8"));

  assert.equal(requests, 3);
  assert.equal(trace.events.filter((event) => event.type === "tool_call").length, 2);
  assert.equal(trace.terminationReason, "max_tool_rounds");
  assert.equal(trace.error.name, "AgentRunError");
});

test("persists an executed write when the following API response fails", async (t) => {
  let requests = 0;
  let approvalId;
  const fetchImpl = async () => {
    requests += 1;
    if (requests === 1) {
      return ok(functionCall(1, "retry_order", { orderId: "ACME-1001", approvalId, expectedVersion: 3 }));
    }
    return new Response(JSON.stringify({ error: { code: "server_is_overloaded" } }), {
      status: 503,
      headers: { "content-type": "application/json" }
    });
  };
  const { agent, service, store, tracePath } = await isolatedAgent(t, { fetchImpl, maxApiAttempts: 3 });
  const approval = await service.approveRetry("cred-acme-operator", "ACME-1001");
  approvalId = approval.approvalId;

  await assert.rejects(
    agent.run({
      credential: "cred-acme-operator",
      input: `Retry ACME-1001 with approvalId=${approvalId} version=3`
    }),
    /OpenAI Responses API failed \(503\)/
  );
  const trace = JSON.parse(await readFile(tracePath, "utf8"));
  const retryEvent = trace.events.find((event) => event.name === "retry_order");
  const state = await store.read();

  assert.equal(requests, 4);
  assert.equal(retryEvent.result.data.outcome, "EXECUTED");
  assert.equal(retryEvent.result.data.operationKey, "retry:acme:ACME-1001:v3");
  assert.equal(trace.terminationReason, "api_error");
  assert.equal(state.receipts.length, 1);
  assert.equal(state.orders.find((order) => order.orderId === "ACME-1001").retryCount, 1);
});

test("rejects an incomplete response before dispatching its tool", async (t) => {
  const fetchImpl = async () => ok(functionCall(
    1,
    "get_order_status",
    { orderId: "ACME-1001" },
    { responseStatus: "incomplete", incompleteDetails: { reason: "max_output_tokens" } }
  ));
  const { agent, tracePath } = await isolatedAgent(t, { fetchImpl });
  await assert.rejects(agent.run({ credential: "cred-acme-operator", input: "ACME-1001" }), /response incomplete/);
  const trace = JSON.parse(await readFile(tracePath, "utf8"));

  assert.equal(trace.events.filter((event) => event.type === "tool_call").length, 0);
  assert.equal(trace.terminationReason, "incomplete_response");
});

test("persists invalid tool arguments without dispatching", async (t) => {
  const fetchImpl = async () => ok(functionCall(
    1,
    "get_order_status",
    {},
    { arguments: "{" }
  ));
  const { agent, tracePath } = await isolatedAgent(t, { fetchImpl });
  await assert.rejects(agent.run({ credential: "cred-acme-operator", input: "ACME-1001" }), /Invalid JSON/);
  const trace = JSON.parse(await readFile(tracePath, "utf8"));

  assert.equal(trace.events.filter((event) => event.type === "tool_call").length, 0);
  assert.equal(trace.terminationReason, "invalid_tool_arguments");
});

test("validates every tool argument before dispatching any call in a response", async (t) => {
  const response = functionCall(1, "get_order_status", { orderId: "ACME-1001" });
  response.output.push({
    id: "fc_invalid",
    call_id: "call_invalid",
    type: "function_call",
    status: "completed",
    name: "get_integration_events",
    arguments: "{"
  });
  const { agent, tracePath } = await isolatedAgent(t, { fetchImpl: async () => ok(response) });
  await assert.rejects(agent.run({ credential: "cred-acme-operator", input: "ACME-1001" }), /Invalid JSON/);
  const trace = JSON.parse(await readFile(tracePath, "utf8"));
  assert.equal(trace.events.filter((event) => event.type === "tool_call").length, 0);
});

test("classifies authentication failure without making an API request", async (t) => {
  let requests = 0;
  const { agent, tracePath } = await isolatedAgent(t, { fetchImpl: async () => { requests += 1; return ok({}); } });
  await assert.rejects(agent.run({ credential: "cred-acme-revoked", input: "ACME-1001" }), /unknown or inactive/);
  const trace = JSON.parse(await readFile(tracePath, "utf8"));
  assert.equal(requests, 0);
  assert.equal(trace.terminationReason, "authentication_error");
});

test("stores only safe provider error fields", async (t) => {
  const fetchImpl = async () => new Response(JSON.stringify({
    error: { code: "invalid_api_key", type: "authentication_error", message: "Incorrect key sk-proj-********WXYZ" }
  }), { status: 401, headers: { "content-type": "application/json" } });
  const { agent, tracePath } = await isolatedAgent(t, { fetchImpl });
  await assert.rejects(agent.run({ credential: "cred-acme-operator", input: "ACME-1001" }), /failed \(401\)/);
  const traceText = await readFile(tracePath, "utf8");
  const trace = JSON.parse(traceText);
  assert.equal(trace.error.details.code, "invalid_api_key");
  assert.equal(trace.error.details.type, "authentication_error");
  assert.equal(traceText.includes("WXYZ"), false);
  assert.equal(traceText.includes("Incorrect key"), false);
});

test("keeps the timeout active while reading the response body", async (t) => {
  const fetchImpl = async (_url, options) => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    text: () => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })
  });
  const { agent, tracePath } = await isolatedAgent(t, { fetchImpl, requestTimeoutMs: 5, maxApiAttempts: 1 });
  await assert.rejects(agent.run({ credential: "cred-acme-operator", input: "ACME-1001" }), /transport failed/);
  const trace = JSON.parse(await readFile(tracePath, "utf8"));
  assert.equal(trace.terminationReason, "api_error");
  assert.equal(trace.events.some((event) => event.type === "model_transport_error"), true);
});
