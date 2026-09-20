# Decisions

This file is the canonical record of implementation decisions. Dates use Asia/Tokyo.

## ADR-001 — Start with a text workflow and local deterministic evaluation

- **Date:** 2026-09-20
- **Status:** Accepted
- **Decision:** Implement one synthetic CRM-to-ERP order exception workflow before MCP or voice. Build the state transition, approval boundary, receipts, baseline, and evaluation together.
- **Why:** This exposes the business and security decisions in one trace and keeps failure attribution clear.
- **Deferred:** MCP transport, voice, real SaaS connections, hosting, multi-agent orchestration.

## ADR-002 — Enforce authority outside the model

- **Date:** 2026-09-20
- **Status:** Accepted
- **Decision:** Credential validation, tenant ownership, scopes, approval binding, expiry, optimistic version checks, and idempotency are application controls. Model output cannot grant these rights.
- **Why:** A conversational confirmation is not authentication or authorization. Direct boundary tests must pass even if no model is involved.

## ADR-003 — Bind approval and receipt to an immutable operation intent

- **Date:** 2026-09-20
- **Status:** Accepted
- **Decision:** A retry approval covers one action, tenant, order, and expected order version. The operation key is deterministic for that intent. The resulting receipt records the approval, principal, and before/after state.
- **Why:** This rejects stale approvals and lets a client reconcile a timeout without causing a second side effect.

## ADR-004 — Keep the first evaluation portable

- **Date:** 2026-09-20
- **Status:** Accepted
- **Decision:** Use Node's built-in test runner and deterministic JSON evidence. Ordinary evaluation runs write volatile timing metadata under `work/`; `--check` compares without writing, and evidence replacement requires the explicit owner command `--write-evidence`. Keep API-backed evaluation optional and store observable traces locally.
- **Why:** The evidence remains reproducible without depending on a hosted evaluation product.

## ADR-005 — Use Responses API with strict function schemas

- **Date:** 2026-09-20
- **Status:** Accepted; API transport and one corrected full-conversation path were live-tested with synthetic data
- **Decision:** The optional runtime adapter uses the Responses API, `store: false`, serial tool calls, and strict JSON schemas. The application credential remains outside the model request.
- **Evidence status:** The first 2026-09-20 live run used a pre-R1 adapter that dropped prior response history. PA-1 A0 later exercised the corrected adapter across four responses and three read-only calls with nondecreasing input-token counts. Neither run exercised a live write or approval check, and neither is holdout evidence.

## ADR-006 — Treat API transport and raw response parsing as explicit reliability boundaries

- **Date:** 2026-09-20
- **Status:** Accepted
- **Decision:** Make at most three attempts for 429 and transient 5xx responses, which permits two retries with bounded backoff. Retry transport and eligible non-JSON failures, honor bounded `Retry-After`, and use a request timeout. Extract assistant text from raw REST `output[].content[]`, reject incomplete or empty terminal responses, aggregate usage, and persist a structured trace on every termination path.
- **Why:** The live smoke test observed a transient 503 and exposed an SDK-versus-REST response-shape assumption. Both conditions must be visible and bounded rather than silently treated as success.

## ADR-007 — Preserve complete stateless Responses history

- **Date:** 2026-09-20
- **Status:** Accepted after Claude R1
- **Decision:** With `store: false`, every request resends the original user input plus every prior response output item and every function-call output in order. `maxToolRounds = N` means no more than N tool calls execute; the response after call N is evaluated, and a further tool request fails closed without execution.
- **Reasoning item handling:** Current OpenAI documentation states that stateless reasoning items contain `encrypted_content` by default. `include: ["reasoning.encrypted_content"]` remains compatible but is not required. The adapter preserves each output item unchanged rather than extracting or reconstructing reasoning content.
- **Evidence:** Multi-turn and approval-survival fake-transport tests, plus PA-1 A0: four live responses with input-token counts `588, 701, 815, 1022`, one structured `APPROVAL_REQUIRED` outcome, and unchanged pre/post state hashes.

## ADR-008 — Hide cross-tenant resource existence

- **Date:** 2026-09-20
- **Status:** Accepted after Claude R1
- **Decision:** Order and receipt lookup is scoped to the authenticated tenant before existence is reported. A foreign resource and a missing resource return identical public errors, including receipt lookup by deterministic operation key.
- **Why:** Payload filtering alone still exposed an order and activity oracle through distinguishable errors. Direct tests now compare code, message, and details for foreign and missing resources.

## ADR-009 — Make the terminal outcome a strict machine contract

- **Date:** 2026-09-20
- **Status:** Accepted for PA-1 freeze
- **Decision:** Every terminal model answer uses Responses API Structured Outputs with a strict JSON schema: `schemaVersion`, `outcome`, `orderId`, `receiptId`, `operationKey`, and `summary`. Core pass/fail never interprets `summary`. Allowed outcomes are `EXECUTED`, `APPROVAL_REQUIRED`, `QUESTION`, `REJECT`, `ESCALATE`, `RESULT_UNKNOWN_RECONCILED`, and `NO_ACTION`.
- **Scoring order:** Final state first, trace second, structured outcome third. `EXECUTED` and `RESULT_UNKNOWN_RECONCILED` fail as `false_success` when state or a `SUCCEEDED` receipt does not substantiate them; the reconciled outcome additionally requires a successful receipt lookup in the trace.
- **Boundary at R3:** This was the first PA-1 pre-freeze change to the effective instructions and adapter. ADR-011 records the separately authorized second and final wording change after R3. The five business tools remain unchanged. The format follows the official Responses API `text.format` JSON-schema contract: https://developers.openai.com/api/docs/guides/structured-outputs

## ADR-010 — Freeze PA-1 labels separately from inputs and scoring

- **Date:** 2026-09-20
- **Status:** Accepted for R3 review; holdout execution remains unauthorized
- **Decision:** Keep holdout inputs/setup, expected labels, scoring rules, and fixture in four separately hashed files. Each model gets three trials per scenario from fresh state under one fixed clock and identical adapter settings. Saved state and trace are rescored offline without an API call.
- **Why:** Separate files make label review, leakage checks, and post-run tamper checks practical. Scripted agents prove that blanket refusal, unconditional retry, and unsupported success claims cannot game the score.
- **Viewer rule:** A viewer asking only for diagnosis may receive `APPROVAL_REQUIRED`. A viewer explicitly requesting a write with a supplied approval must reach the application boundary and return `REJECT` because read access does not grant write scope.

## ADR-011 — Define outcome vocabulary before the final holdout freeze

- **Date:** 2026-09-20
- **Status:** Accepted for R3' review; holdout execution remains unauthorized
- **Decision:** Put one general definition and precedence rule for each of the seven outcomes in the effective system instructions. A denied or visibly invalid supplied approval maps to `REJECT`; missing approval maps to `APPROVAL_REQUIRED`; an already completed or duplicate-suppressed operation maps to `NO_ACTION`; and a successful receipt lookup after an unknown result maps to `RESULT_UNKNOWN_RECONCILED`. A success report must identify the target plus a matching receipt ID or operation key.
- **Why:** R3 found that defensible behavior could fail merely because the model had to guess the label vocabulary. The definitions are scenario-independent and were added before any model saw the holdout.
- **Boundary:** This is the second and final pre-freeze wording change authorized for PA-1. Development labels were checked against these definitions before the one authorized live reconfirmation. A further wording change requires a reason recorded in `STATE.md` and notice to Takaaki before editing.

## ADR-012 — Treat the final score difference as a contract ambiguity

- **Date:** 2026-09-20
- **Status:** Accepted after PA-1 result review
- **Decision:** Preserve the frozen labels, scorer, evidence, and scores. Classify the four `recovery-04` failures as an under-determined `NO_ACTION` versus `REJECT` choice because the model-visible contract omitted that precedence rule.
- **Reporting boundary:** The complete 44/45 versus 42/45 difference, including recovery 11/12 versus 9/12, comes from that row and is not reported as a capability difference.

## ADR-013 — Publish an allowlisted evidence package

- **Date:** 2026-09-20
- **Status:** Accepted for publication review
- **Decision:** Publish source, tests, synthetic fixtures, the now-consumed evaluation inputs, aggregate result summary, and public evaluation report. Exclude raw live prompts and model outputs, execution traces, review bundles, credentials, shell history, session transcripts, and internal approval/review records.
- **Why:** The public package remains reproducible and auditable without disclosing credential residue or turning private operational records into portfolio content.
