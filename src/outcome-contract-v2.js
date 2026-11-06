// Opt-in evaluation contract. The PA-1 agent and its frozen contract are unchanged.
export const CONTRACT_ID = "pa-outcome-contract-v2";
export const CONTRACT_SCOPE = "One target and one business operation; deterministic visible-fixture checks.";

export const OUTCOME_DEFINITIONS_V2 = `Choose exactly one outcome from tool evidence, in this precedence order:
1. REJECT: an attempted write was denied, or application evidence establishes an authorization or approval-binding denial. A later SYNCED read does not erase that denial. A not-found read alone does not establish an authorization violation.
2. RESULT_UNKNOWN_RECONCILED: this run first received RESULT_UNKNOWN, then a receipt lookup proved that same order and operation succeeded. Do not retry after an unknown result. If a matching receipt cannot be established, use ESCALATE and state that the result remains unresolved. An access denial still takes precedence; preserve the unresolved status in the summary.
3. EXECUTED: this run performed one new authorized write, with a matching SUCCEEDED receipt. An old receipt is not evidence of a new write.
4. NO_ACTION for replay: the application returned DUPLICATE_SUPPRESSED for the same principal, approval and operation, with a matching receipt. An expired or consumed approval does not authorize another effect; this path only returns the existing result.
5. NO_ACTION for a completed target: a permitted status or search read confirms that the target itself is SYNCED, this run attempted no write, and no denied or unresolved write remains. An unused approval's stale version, expiry or consumed state, or an absent approval, does not change this result. This does not validate the approval. Known application authorization or binding denials still take precedence.
6. For a retryable FAILED target: use APPROVAL_REQUIRED when no approval was supplied and do not attempt a write; use REJECT when the supplied approval is visibly stale or unusable. A failed attempt with a missing approval is a denied attempt, not the pre-attempt approval request route.
7. QUESTION: the target or necessary facts cannot be established, including a target choice reserved by the user. ESCALATE: a non-retryable data problem needs correction outside this agent.
Do not mix successful and denied operations into one result. Do not attribute another order's status or another operation's receipt to the target. Use only observed identifiers. A success or replay result must identify the target and a matching receiptId or operationKey. For a status-only NO_ACTION, receiptId and operationKey may both be null.
The seven outcome names and schemaVersion 1 remain unchanged. This contract does not grant execution authority and is not the default PA-1 agent contract.`;
