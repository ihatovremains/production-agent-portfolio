import { DomainError, asFailure } from "./errors.js";

const ORDER_ID_PATTERN = /\b(?:ACME|GLOBEX)-\d{4}\b/i;

export class DeterministicBaseline {
  constructor(service) {
    this.service = service;
  }

  async diagnose(credential, userText) {
    const match = String(userText).match(ORDER_ID_PATTERN);
    if (!match) {
      return {
        ok: true,
        outcome: "QUESTION",
        message: "対象の注文ID（例: ACME-1001）を確認してください。",
        requiredFields: ["orderId"]
      };
    }
    const orderId = match[0].toUpperCase();
    try {
      const [order, events] = await Promise.all([
        this.service.getOrderStatus(credential, orderId),
        this.service.getIntegrationEvents(credential, orderId)
      ]);
      const evidence = events.map((event) => ({
        eventId: event.eventId,
        type: event.type,
        failureType: event.failureType,
        occurredAt: event.occurredAt
      }));
      if (order.syncStatus === "SYNCED") {
        return { ok: true, outcome: "NO_ACTION", order, evidence, message: "注文はすでにERPへ同期済みです。" };
      }
      if (order.failureType === "SCHEMA_MISMATCH") {
        return {
          ok: true,
          outcome: "ESCALATE",
          order,
          evidence,
          message: "入力スキーマ不一致のため自動再処理せず、データ修正担当へエスカレーションします。"
        };
      }
      if (order.failureType === "TRANSIENT_UPSTREAM") {
        return {
          ok: true,
          outcome: "APPROVAL_REQUIRED",
          order,
          evidence,
          approvalIntent: {
            action: "retry_order",
            tenantId: order.tenantId,
            orderId: order.orderId,
            expectedVersion: order.version
          },
          message: "一時的な上流障害です。現在の版に対する再処理には明示承認が必要です。"
        };
      }
      return { ok: true, outcome: "ESCALATE", order, evidence, message: "自動処理できない状態です。" };
    } catch (error) {
      if (error instanceof DomainError && ["TENANT_DENIED", "SCOPE_DENIED", "AUTHENTICATION_FAILED"].includes(error.code)) {
        return { ...asFailure(error), outcome: "REJECT" };
      }
      if (error instanceof DomainError && error.code === "ORDER_NOT_FOUND") {
        return { ...asFailure(error), outcome: "QUESTION", requiredFields: ["validOrderId"] };
      }
      throw error;
    }
  }
}
