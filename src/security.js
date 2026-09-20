import { createHash, randomUUID } from "node:crypto";
import { DomainError } from "./errors.js";

export function authenticate(state, credential) {
  const principal = state.principals.find((item) => item.credential === credential);
  if (!principal || !principal.active) {
    throw new DomainError("AUTHENTICATION_FAILED", "Credential is unknown or inactive");
  }
  return principal;
}

export function requireScope(principal, scope) {
  if (!principal.scopes.includes(scope)) {
    throw new DomainError("SCOPE_DENIED", `Required scope is missing: ${scope}`, { scope });
  }
}

export function requireTenant(principal, tenantId) {
  if (principal.tenantId !== tenantId) {
    throw new DomainError("TENANT_DENIED", "Resource does not belong to the authenticated tenant");
  }
}

export function canonicalIntent({ action, tenantId, orderId, expectedVersion }) {
  return JSON.stringify({ action, tenantId, orderId, expectedVersion });
}

export function intentDigest(intent) {
  return createHash("sha256").update(canonicalIntent(intent)).digest("hex");
}

export function createApprovalRecord({ principal, intent, now, ttlMs = 5 * 60 * 1000 }) {
  requireScope(principal, "approvals:grant");
  requireTenant(principal, intent.tenantId);
  return {
    approvalId: `apr_${randomUUID()}`,
    principalId: principal.principalId,
    tenantId: principal.tenantId,
    action: intent.action,
    orderId: intent.orderId,
    expectedVersion: intent.expectedVersion,
    intentDigest: intentDigest(intent),
    approvedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    usedAt: null
  };
}

export function validateApproval({ approval, principal, intent, now }) {
  if (!approval) throw new DomainError("APPROVAL_REQUIRED", "A matching approval is required");
  if (approval.usedAt) throw new DomainError("APPROVAL_ALREADY_USED", "Approval has already been consumed");
  if (approval.principalId !== principal.principalId) {
    throw new DomainError("APPROVAL_PRINCIPAL_MISMATCH", "Approval belongs to another principal");
  }
  if (new Date(approval.expiresAt).getTime() <= now.getTime()) {
    throw new DomainError("APPROVAL_EXPIRED", "Approval has expired");
  }
  if (approval.intentDigest !== intentDigest(intent)) {
    throw new DomainError("APPROVAL_INTENT_MISMATCH", "Approval does not match the requested action");
  }
}
