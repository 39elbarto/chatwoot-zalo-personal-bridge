# Connector hardening

This release adds behavior proven in staged deployments while keeping the public connector host-neutral.

## Behavior

- Zalo link cards become readable text containing only normalized human text and HTTP(S) URLs.
- Thread IDs must be positive numeric peer IDs or `group:<positive numeric ID>` after an explicitly configured prefix is removed.
- Invalid or ambiguous IDs are rejected before any Zalo SDK call.
- HTTP starts before authentication; health and callbacks remain 503 until the account and listener are ready.
- Optional `ZALO_EXPECTED_SELF_UID` prevents an unexpected authenticated account from handling messages.
- Native replies can link back to the target Chatwoot message.
- Attachment metadata requests and downloads have timeouts, and forwarded filenames are sanitized.
- Readiness and event diagnostics use categories and booleans instead of raw event/session payloads.

## Public release boundary

Reviewed base: `b3c61c7d742b7053146243512f0438b4d7ad39ba`.

The allowed delta is limited to:

- `src/chatwootClient.ts`
- `src/index.ts`
- `src/runtimeStatus.ts`
- `src/server.ts`
- `src/zaloClient.ts`
- `src/zaloSystemMessages.ts`
- `scripts/test-hardening.ts`
- `package.json`
- `package-lock.json` (compatible transitive security update only)
- `.env.example`
- generic README, runbook, troubleshooting, security checklist, and systemd example documentation

Fixtures use synthetic numeric IDs and `example.test` URLs. Runtime domains, account/inbox values, contacts, UIDs, cookies, sessions, QR data, message maps, mention maps, private callback aliases, and infrastructure paths are outside the public boundary.

## Rotate the Chatwoot service token

For a Chatwoot `Channel::Api` connector, `CHATWOOT_API_TOKEN` authenticates API
requests. It is independent of the inbox identifier, webhook route, and Zalo
session. Rotating only this token does not recreate the inbox or require a new
Zalo QR login.

Use a regular technical Chatwoot agent with access only to the connector account
and required inboxes. Before cutover, validate the new token through internal
profile, inbox, and conversation reads plus a private create/delete note in an
approved test conversation. Back up `.env`, replace only the token assignment,
parse the candidate dotenv, and restart one bridge instance at a time. Require
`ready`, the expected account/inbox mapping, and account match after restart.

Do not revoke the old token until encrypted automation credentials and off-host
consumers have been inventoried. Removing plaintext references from the active
server does not prove the token is unused elsewhere.
