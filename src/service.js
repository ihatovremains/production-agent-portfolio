import { randomUUID } from "node:crypto";
import { DomainError } from "./errors.js";
import {
  authenticate,
  createApprovalRecord,
  requireScope,
  validateApproval
} from "./security.js";

function publicOrder(order) {
  const { retryMode: _retryMode, ...safe } = order;
  return safe;
}

function audit(state, entry, now) {
  state.audit.push({
    auditId: `aud_${randomUUID()}`,
    occurredAt: now.toISOString(),
    ...entry
  });
}

export class IntegrationService {
  constructor(store, { clock = () => new Date() } = {}) {
    this.store = store;
    this.clock = clock;
  }

  async getPrincipalContext(credential) {
    const state = await this.store.read();
    const principal = authenticate(state, credential);
    return { principalId: principal.principalId, tenantId: principal.tenantId };
  }

  async searchOrders(credential, query) {
    const state = await this.store.read();
    const principal = authenticate(state, credential);
    requireScope(principal, "orders:read");
    const normalized = String(query).trim().toLowerCase();
    return state.orders
      .filter((order) => order.tenantId === principal.tenantId)
      .filter((order) =>
        [order.orderId, order.customerRef].some((value) => value.toLowerCase().includes(normalized))
      )
      .map(publicOrder);
  }

  async getOrderStatus(credential, orderId) {
    const state = await this.store.read();
    const principal = authenticate(state, credential);
    requireScope(principal, "orders:read");
    const order = state.orders.find((item) =>
      item.orderId === orderId && item.tenantId === principal.tenantId
    );
    if (!order) throw new DomainError("ORDER_NOT_FOUND", "Order was not found");
    return publicOrder(order);
  }

  async getIntegrationEvents(credential, orderId) {
    const state = await this.store.read();
    const principal = authenticate(state, credential);
    requireScope(principal, "orders:read");
    const order = state.orders.find((item) =>
      item.orderId === orderId && item.tenantId === principal.tenantId
    );
    if (!order) throw new DomainError("ORDER_NOT_FOUND", "Order was not found");
    return state.events
      .filter((event) => event.orderId === orderId && event.tenantId === principal.tenantId)
      .map((event) => ({ ...event, trust: "UNTRUSTED_DATA" }));
  }

  async approveRetry(credential, orderId, { ttlMs } = {}) {
    return this.store.transaction((state) => {
      const now = this.clock();
      const principal = authenticate(state, credential);
      const order = state.orders.find((item) =>
        item.orderId === orderId && item.tenantId === principal.tenantId
      );
      if (!order) throw new DomainError("ORDER_NOT_FOUND", "Order was not found");
      if (order.failureType !== "TRANSIENT_UPSTREAM" || order.syncStatus !== "FAILED") {
        throw new DomainError("RETRY_NOT_ALLOWED", "Current order state is not eligible for retry");
      }
      const intent = {
        action: "retry_order",
        tenantId: order.tenantId,
        orderId: order.orderId,
        expectedVersion: order.version
      };
      const approval = createApprovalRecord({ principal, intent, now, ttlMs });
      state.approvals.push(approval);
      audit(state, {
        event: "RETRY_APPROVED",
        principalId: principal.principalId,
        tenantId: principal.tenantId,
        orderId,
        approvalId: approval.approvalId,
        intentDigest: approval.intentDigest
      }, now);
      return approval;
    });
  }

  async retryOrder(credential, { orderId, approvalId, expectedVersion }) {
    return this.store.transaction((state) => {
      const now = this.clock();
      const principal = authenticate(state, credential);
      requireScope(principal, "retries:write");
      const order = state.orders.find((item) =>
        item.orderId === orderId && item.tenantId === principal.tenantId
      );
      if (!order) throw new DomainError("ORDER_NOT_FOUND", "Order was not found");

      const operationKey = `retry:${order.tenantId}:${order.orderId}:v${expectedVersion}`;
      const existing = state.receipts.find((receipt) => receipt.operationKey === operationKey);
      if (existing) {
        if (existing.approvalId !== approvalId || existing.principalId !== principal.principalId) {
          throw new DomainError(
            "APPROVAL_INTENT_MISMATCH",
            "The existing operation receipt is bound to another approval or principal"
          );
        }
        audit(state, {
          event: "DUPLICATE_RETRY_SUPPRESSED",
          principalId: principal.principalId,
          tenantId: principal.tenantId,
          orderId,
          receiptId: existing.receiptId,
          operationKey
        }, now);
        return { outcome: "DUPLICATE_SUPPRESSED", operationKey, receipt: existing };
      }

      const intent = {
        action: "retry_order",
        tenantId: order.tenantId,
        orderId,
        expectedVersion
      };
      const approval = state.approvals.find((item) => item.approvalId === approvalId);
      validateApproval({ approval, principal, intent, now });
      if (order.version !== expectedVersion) {
        throw new DomainError("STALE_ORDER_VERSION", "Order changed after approval", {
          approvedVersion: expectedVersion,
          currentVersion: order.version
        });
      }
      if (order.failureType !== "TRANSIENT_UPSTREAM" || order.syncStatus !== "FAILED") {
        throw new DomainError("RETRY_NOT_ALLOWED", "Current order state is not eligible for retry");
      }

      approval.usedAt = now.toISOString();
      const before = { syncStatus: order.syncStatus, erpStatus: order.erpStatus, version: order.version };
      order.retryCount += 1;
      order.syncStatus = "SYNCED";
      order.erpStatus = "CREATED";
      order.failureType = null;
      order.version += 1;
      const receipt = {
        receiptId: `rcpt_${randomUUID()}`,
        operationKey,
        approvalId,
        principalId: principal.principalId,
        tenantId: principal.tenantId,
        orderId,
        status: "SUCCEEDED",
        before,
        after: { syncStatus: order.syncStatus, erpStatus: order.erpStatus, version: order.version },
        completedAt: now.toISOString()
      };
      state.receipts.push(receipt);
      audit(state, {
        event: "RETRY_EXECUTED",
        principalId: principal.principalId,
        tenantId: principal.tenantId,
        orderId,
        approvalId,
        receiptId: receipt.receiptId,
        operationKey
      }, now);

      if (order.retryMode === "timeout_after_commit") {
        return { outcome: "RESULT_UNKNOWN", operationKey, receiptId: null };
      }
      return { outcome: "EXECUTED", operationKey, receipt };
    });
  }

  async getActionReceipt(credential, { receiptId = null, operationKey = null }) {
    const state = await this.store.read();
    const principal = authenticate(state, credential);
    requireScope(principal, "orders:read");
    const receipt = state.receipts.find((item) =>
      item.tenantId === principal.tenantId
      && (receiptId ? item.receiptId === receiptId : item.operationKey === operationKey)
    );
    if (!receipt) throw new DomainError("RECEIPT_NOT_FOUND", "Action receipt was not found");
    return receipt;
  }
}
