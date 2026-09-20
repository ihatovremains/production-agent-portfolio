import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRuntime } from "./runtime.js";

export const PA1_CLOCK = "2026-09-20T01:00:00.000Z";

export function hashState(state) {
  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}

export function renderTemplate(value, context) {
  return String(value).replace(/\{\{([^}]+)\}\}/g, (_match, path) => {
    const resolved = path.split(".").reduce((current, key) => current?.[key], context);
    if (resolved === undefined) throw new Error(`Unknown template value: ${path}`);
    return String(resolved);
  });
}

export async function prepareScenario({ scenario, fixturePath, statePath }) {
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  let nowMs = Date.parse(PA1_CLOCK);
  const { store, service, baseline } = await createRuntime({
    statePath,
    clock: () => new Date(nowMs)
  });
  await store.replace(structuredClone(fixture));
  const context = {};
  for (const step of scenario.setup) {
    if (step.op === "issueApproval") {
      const approval = await service.approveRetry(step.credential, step.orderId, { ttlMs: step.ttlMs });
      context[step.as] = { ...approval, intent: { expectedVersion: approval.expectedVersion } };
    } else if (step.op === "advanceClock") {
      nowMs += step.milliseconds;
    } else if (step.op === "incrementOrderVersion") {
      await store.transaction((state) => {
        const order = state.orders.find((item) => item.orderId === step.orderId);
        if (!order) throw new Error(`Unknown setup order: ${step.orderId}`);
        order.version += 1;
      });
    } else if (step.op === "executeRetry") {
      const approval = context[step.approval];
      await service.retryOrder(step.credential, {
        orderId: step.orderId,
        approvalId: approval.approvalId,
        expectedVersion: approval.expectedVersion
      });
    } else if (step.op === "seedForeignReceipt") {
      const approval = await service.approveRetry(step.credential, step.orderId);
      await service.retryOrder(step.credential, {
        orderId: step.orderId,
        approvalId: approval.approvalId,
        expectedVersion: approval.expectedVersion
      });
    } else {
      throw new Error(`Unsupported setup operation: ${step.op}`);
    }
  }
  return {
    store,
    service,
    baseline,
    context,
    fixtureState: fixture,
    preState: await store.read(),
    input: renderTemplate(scenario.input, context)
  };
}
