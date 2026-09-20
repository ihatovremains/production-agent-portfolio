import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "../src/runtime.js";
import { dispatchTool } from "../src/tools.js";

async function isolatedRuntime(t, clock) {
  const directory = await mkdtemp(join(tmpdir(), "portfolio-security-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return createRuntime({ statePath: join(directory, "state.json"), clock });
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => error.code === code);
}

async function failureShape(promise) {
  try {
    await promise;
    assert.fail("Expected the operation to fail");
  } catch (error) {
    if (error.name === "AssertionError") throw error;
    return { code: error.code, message: error.message, details: error.details };
  }
}

test("rejects revoked credentials and cross-tenant reads", async (t) => {
  const { service } = await isolatedRuntime(t);
  await expectCode(service.getOrderStatus("cred-acme-revoked", "ACME-1001"), "AUTHENTICATION_FAILED");
  await expectCode(service.getOrderStatus("cred-acme-operator", "GLOBEX-2001"), "ORDER_NOT_FOUND");
});

test("makes foreign orders and receipts indistinguishable from missing resources", async (t) => {
  const { service } = await isolatedRuntime(t);
  const globexApproval = await service.approveRetry("cred-globex-operator", "GLOBEX-2001");
  const executed = await service.retryOrder("cred-globex-operator", {
    orderId: "GLOBEX-2001",
    approvalId: globexApproval.approvalId,
    expectedVersion: globexApproval.expectedVersion
  });
  const credential = "cred-acme-operator";

  for (const [foreign, missing] of [
    [
      dispatchTool(service, credential, "get_order_status", { orderId: "GLOBEX-2001" }),
      dispatchTool(service, credential, "get_order_status", { orderId: "GLOBEX-9999" })
    ],
    [
      dispatchTool(service, credential, "get_integration_events", { orderId: "GLOBEX-2001" }),
      dispatchTool(service, credential, "get_integration_events", { orderId: "GLOBEX-9999" })
    ],
    [
      dispatchTool(service, credential, "retry_order", {
        orderId: "GLOBEX-2001", approvalId: "apr_unknown", expectedVersion: 4
      }),
      dispatchTool(service, credential, "retry_order", {
        orderId: "GLOBEX-9999", approvalId: "apr_unknown", expectedVersion: 4
      })
    ],
    [
      dispatchTool(service, credential, "get_action_receipt", {
        receiptId: executed.receipt.receiptId, operationKey: null
      }),
      dispatchTool(service, credential, "get_action_receipt", {
        receiptId: "rcpt_missing", operationKey: null
      })
    ],
    [
      dispatchTool(service, credential, "get_action_receipt", {
        receiptId: null, operationKey: executed.operationKey
      }),
      dispatchTool(service, credential, "get_action_receipt", {
        receiptId: null, operationKey: "retry:globex:GLOBEX-9999:v4"
      })
    ]
  ]) {
    assert.deepEqual(await foreign, await missing);
  }

  assert.deepEqual(
    await failureShape(service.approveRetry(credential, "GLOBEX-2001")),
    await failureShape(service.approveRetry(credential, "GLOBEX-9999"))
  );
});

test("requires write scope and an exact approval", async (t) => {
  const { service } = await isolatedRuntime(t);
  const approval = await service.approveRetry("cred-acme-operator", "ACME-1001");
  await expectCode(service.retryOrder("cred-acme-viewer", {
    orderId: "ACME-1001",
    approvalId: approval.approvalId,
    expectedVersion: 3
  }), "SCOPE_DENIED");
  await expectCode(service.retryOrder("cred-acme-operator", {
    orderId: "ACME-1001",
    approvalId: "apr_missing",
    expectedVersion: 3
  }), "APPROVAL_REQUIRED");
  await expectCode(service.retryOrder("cred-acme-operator", {
    orderId: "ACME-1001",
    approvalId: approval.approvalId,
    expectedVersion: 2
  }), "APPROVAL_INTENT_MISMATCH");
});

test("rejects expired approval", async (t) => {
  let now = new Date("2026-09-20T00:00:00.000Z");
  const { service } = await isolatedRuntime(t, () => now);
  const approval = await service.approveRetry("cred-acme-operator", "ACME-1001", { ttlMs: 1000 });
  now = new Date("2026-09-20T00:00:02.000Z");
  await expectCode(service.retryOrder("cred-acme-operator", {
    orderId: "ACME-1001",
    approvalId: approval.approvalId,
    expectedVersion: approval.expectedVersion
  }), "APPROVAL_EXPIRED");
});

test("rejects approval when the order changed after approval", async (t) => {
  const { service, store } = await isolatedRuntime(t);
  const approval = await service.approveRetry("cred-acme-operator", "ACME-1001");
  await store.transaction((state) => {
    state.orders.find((order) => order.orderId === "ACME-1001").version += 1;
  });
  await expectCode(service.retryOrder("cred-acme-operator", {
    orderId: "ACME-1001",
    approvalId: approval.approvalId,
    expectedVersion: approval.expectedVersion
  }), "STALE_ORDER_VERSION");
});

test("suppresses a duplicate side effect and preserves one receipt", async (t) => {
  const { service, store } = await isolatedRuntime(t);
  const approval = await service.approveRetry("cred-acme-operator", "ACME-1001");
  const args = { orderId: "ACME-1001", approvalId: approval.approvalId, expectedVersion: approval.expectedVersion };
  const first = await service.retryOrder("cred-acme-operator", args);
  const second = await service.retryOrder("cred-acme-operator", args);
  const state = await store.read();
  assert.equal(first.outcome, "EXECUTED");
  assert.equal(second.outcome, "DUPLICATE_SUPPRESSED");
  assert.equal(state.receipts.filter((receipt) => receipt.orderId === "ACME-1001").length, 1);
  assert.equal(state.orders.find((order) => order.orderId === "ACME-1001").retryCount, 1);
});

test("does not expose an idempotent result to a different approval", async (t) => {
  const { service } = await isolatedRuntime(t);
  const approval = await service.approveRetry("cred-acme-operator", "ACME-1001");
  const args = { orderId: "ACME-1001", approvalId: approval.approvalId, expectedVersion: approval.expectedVersion };
  await service.retryOrder("cred-acme-operator", args);
  await expectCode(service.retryOrder("cred-acme-operator", {
    ...args,
    approvalId: "apr_forged"
  }), "APPROVAL_INTENT_MISMATCH");
});

test("rejects an approval granted to another principal without a side effect", async (t) => {
  const { service, store } = await isolatedRuntime(t);
  const approval = await service.approveRetry("cred-acme-operator", "ACME-1001");
  await expectCode(service.retryOrder("cred-acme-operator-02", {
    orderId: "ACME-1001",
    approvalId: approval.approvalId,
    expectedVersion: approval.expectedVersion
  }), "APPROVAL_PRINCIPAL_MISMATCH");
  const state = await store.read();
  assert.equal(state.receipts.length, 0);
  assert.equal(state.orders.find((order) => order.orderId === "ACME-1001").retryCount, 0);
});

test("does not return another principal's idempotent receipt", async (t) => {
  const { service, store } = await isolatedRuntime(t);
  const approval = await service.approveRetry("cred-acme-operator", "ACME-1001");
  const args = {
    orderId: "ACME-1001",
    approvalId: approval.approvalId,
    expectedVersion: approval.expectedVersion
  };
  await service.retryOrder("cred-acme-operator", args);
  await expectCode(service.retryOrder("cred-acme-operator-02", args), "APPROVAL_INTENT_MISMATCH");
  const state = await store.read();
  assert.equal(state.receipts.length, 1);
  assert.equal(state.orders.find((order) => order.orderId === "ACME-1001").retryCount, 1);
});

test("reconciles timeout-after-commit without retrying", async (t) => {
  const { service, store } = await isolatedRuntime(t);
  const approval = await service.approveRetry("cred-acme-operator", "ACME-1003");
  const result = await service.retryOrder("cred-acme-operator", {
    orderId: "ACME-1003",
    approvalId: approval.approvalId,
    expectedVersion: approval.expectedVersion
  });
  assert.equal(result.outcome, "RESULT_UNKNOWN");
  const receipt = await service.getActionReceipt("cred-acme-operator", {
    receiptId: null,
    operationKey: result.operationKey
  });
  assert.equal(receipt.status, "SUCCEEDED");
  const state = await store.read();
  assert.equal(state.orders.find((order) => order.orderId === "ACME-1003").retryCount, 1);
});
