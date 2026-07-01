# Chatwoot Zalo Personal Bridge Operations Runbook

## Purpose

- Run a source-only Chatwoot to Zalo Personal bridge safely.
- Preserve Zalo session files and Chatwoot tokens outside git.
- Provide repeatable install, login, restart, verification, and abort steps.

## Scope

- In scope: local install, `.env` setup, QR login, service start/restart, health checks, log checks, and rollback to the previous deployed directory.
- Out of scope: modifying Chatwoot source code, automating Zalo account creation, or guaranteeing Zalo platform policy compliance.

## Owner

- Responsible role: operator who owns the Chatwoot inbox, Zalo account, and host running the bridge.

## Trigger / Frequency

- Initial deployment.
- Zalo session expiration or QR re-login.
- Bridge code upgrade.
- Chatwoot webhook/token rotation.
- Incident response when incoming or outgoing delivery stops.

## Prerequisites

- Node.js 20 or newer.
- npm.
- A Chatwoot API inbox.
- Chatwoot user access token with access to the target account/inbox.
- A Zalo personal account accessible in the Zalo mobile app.
- Reverse proxy or tunnel if Chatwoot cannot reach the bridge directly.
- A host directory where runtime files under `data/` can persist across restarts.

## Inputs

- `.env` created from `.env.example`.
- `CHATWOOT_BASE_URL`, `CHATWOOT_API_TOKEN`, `CHATWOOT_ACCOUNT_ID`, `CHATWOOT_INBOX_ID`, `CHATWOOT_INBOX_IDENTIFIER`.
- `ZALO_IMEI`, `ZALO_USER_AGENT`, `ZALO_COOKIE_JSON`, `ZALO_SESSION_FILE`.
- Optional `data/zalo-mentions.json`.

## Procedure

### Step 1: Install Dependencies

- Goal: install exact package versions from the lockfile.
- Command:

```bash
npm ci
```

- Expected result: npm exits with status 0.

### Step 2: Configure Environment

- Goal: create a private runtime configuration.
- Command:

```bash
cp .env.example .env
$EDITOR .env
```

- Expected result: `.env` contains real values and remains untracked.

### Step 3: Build Source

- Goal: verify TypeScript compiles before login or service start.
- Command:

```bash
npm run build
```

- Expected result: `dist/` is created locally and TypeScript exits with status 0.

### Step 4: Login to Zalo

- Goal: create or refresh Zalo cookies/session context.
- Command:

```bash
npm run login:qr
```

- Expected result: a QR code is saved under `data/qr.png`; after scanning and confirming in the Zalo app, `.env` and `data/session.json` are updated.

### Step 5: Start the Bridge

- Goal: run the HTTP server and Zalo listener.
- Command:

```bash
npm start
```

- Expected result: logs include `listening on http://localhost:4001` or your configured port.

### Step 6: Configure Chatwoot Webhook

- Goal: allow Chatwoot outgoing messages to reach the bridge.
- Action: set the API inbox webhook URL to:

```text
https://bridge.example.com/webhooks/chatwoot
```

- Expected result: Chatwoot can POST `message_created` events to the bridge.

## Verification

- Health endpoint:

```bash
curl -fsS http://127.0.0.1:${PORT:-4001}/health
```

- Expected output:

```json
{"ok":true}
```

- Build and tests:

```bash
npm run build
npm test
```

- Webhook logs should show:

```text
[chatwoot-callback] POST /webhooks/chatwoot
[chatwoot-callback] forward to Zalo
```

- Zalo incoming logs should show:

```text
[zalo-event]
```

- Durable reply mapping should exist after traffic:

```bash
test -s data/message-map.json
```

## Failure Modes / Edge Cases

- QR expires: rerun `npm run login:qr` and scan the new `data/qr.png`.
- Zalo session expires: stop the service, remove or archive `data/session.json`, rerun QR login, then restart.
- Chatwoot outgoing not delivered: verify webhook URL, token, inbox ID, and that the Chatwoot message is not private.
- Incoming not visible in Chatwoot: check `CHATWOOT_INBOX_IDENTIFIER`, account ID, token permissions, and bridge logs for Chatwoot API errors.
- Media upload fails: verify the media URL is reachable from the bridge and Chatwoot, then check attachment logs.
- Replies lose native quote context: verify `data/message-map.json` persists and is writable by the service user.

## Rollback / Abort

- Stop immediately if `.env`, cookies, QR image, session JSON, real UIDs, phone numbers, or private domains appear in git status or public logs.
- For a failed upgrade, stop the service and switch back to the previous deployed directory or commit:

```bash
sudo systemctl stop chatwoot-zalo-personal-bridge
git checkout <previous-known-good-commit>
npm ci
npm run build
sudo systemctl start chatwoot-zalo-personal-bridge
```

- If credentials were exposed, rotate the Chatwoot token and log out the linked Zalo session before restarting.

## Logs / Observability

- Foreground process: stdout/stderr from `npm start`.
- systemd:

```bash
journalctl -u chatwoot-zalo-personal-bridge -f --lines 100
```

- Useful log markers:
  - `[zalo-event]`
  - `[chatwoot-callback] incoming`
  - `[chatwoot-callback] forward to Zalo`
  - `[zalo-send-attachment]`
  - `[zalo-personal-bridge] messageMapStore loaded`

## Review Cadence

- Review after every Zalo library upgrade.
- Review after any Chatwoot major version upgrade.
- Review every 90 days for token/session handling and dependency audit status.
