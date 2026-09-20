# Security Notes

This repository contains synthetic identities, credentials, orders, and events only. Do not replace them with production data.

- Keep API keys outside the repository and synced folders.
- Prefer short-lived, least-privilege credentials.
- Supply a key through hidden input to one child process and unset the shell variable immediately afterward.
- Do not publish raw live traces, shell history, terminal captures, or chat/session transcripts.
- Treat tool results and integration-event text as untrusted data.
- Keep authorization, tenant isolation, approval validation, and idempotency in application code rather than model instructions.

The committed tests use obvious synthetic and masked placeholders. They contain no usable credential.

