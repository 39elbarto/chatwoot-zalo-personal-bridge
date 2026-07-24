# Troubleshooting

## Outgoing Chatwoot Message Not Delivered to Zalo

- Confirm the Chatwoot webhook URL is `/webhooks/chatwoot`.
- Confirm logs include `[chatwoot-callback] POST`.
- Confirm the message is public, not a private note.
- Confirm `message_type` is `outgoing` or `template`.
- Confirm the conversation/contact has a Zalo thread identifier.
- Check logs for `[chatwoot-callback] forward to Zalo` and any send error after it.

## Incoming Zalo Message Not Visible in Chatwoot

- Confirm the bridge process is running and `/health` returns HTTP 200 with `ok=true` and `readiness=ready`.
- Confirm Zalo session is valid.
- Confirm `CHATWOOT_API_TOKEN`, `CHATWOOT_ACCOUNT_ID`, `CHATWOOT_INBOX_ID`, and `CHATWOOT_INBOX_IDENTIFIER`.
- Check logs for Chatwoot API response status/body.

## QR Login Failure

- Delete stale `data/qr.png` and rerun `npm run login:qr`.
- Confirm `ZALO_IMEI` and `ZALO_USER_AGENT` are set.
- Scan the PNG file if terminal QR rendering does not work.
- If Zalo rejects login, try a fresh browser/user-agent pair and review linked devices in the Zalo app.

## Session Expired

- Stop the service.
- Move `data/session.json` aside.
- Rerun `npm run login:qr`.
- Restart and verify logs.

## Media Upload Failure

- Confirm the media URL is reachable from the bridge host.
- Confirm Chatwoot accepts the file type and size.
- Look for `[zalo-send-attachment-error]` or Chatwoot upload errors.
- The bridge may fall back to sending a text URL when binary media transfer fails.

## GIF Appears as JSON

- Confirm the incoming event is normalized as `type: "gif"` in `[zalo-event]`.
- Confirm the selected URL is the GIF `href` or `params.small`, not a static thumbnail.
- Run `npm run test:media-recall` and rebuild before restarting the service.

## File Appears as `file.bin`

- Check whether Zalo supplied a filename extension or `params.fileExt`.
- Check the downloaded response MIME type.
- The bridge recognizes PDF, GIF, JPEG, PNG, and WebP signatures. Unknown content intentionally falls back to `.bin`.

## Recalled Message Remains in Chatwoot

- Confirm logs contain a Zalo event with `type: "undo"` and a `targetMsgId`.
- Confirm `data/message-map.json` is present and writable.
- `zalo-recall-pending` means no exact mapping was available yet. The bridge waits for the message mapping instead of guessing or deleting another message.
- `zalo-recall-delete-failed` includes the Chatwoot conversation and message IDs needed for API troubleshooting.

## Webhook Auth or Config Mismatch

- Chatwoot API inbox identifiers are separate from account and inbox IDs.
- A valid Chatwoot user token can still fail if the user lacks account access.
- If multiple bridges share one Chatwoot account, set unique contact/source prefixes.

## Health Returns 503

- `account_state=mismatch`: the authenticated Zalo account differs from the private `ZALO_EXPECTED_SELF_UID`; do not send messages until the account is verified.
- `unknown_with_expectation`: the account-info request did not prove an identity while an expected UID is configured.
- `zalo_connected=false` or `listener_started=false`: inspect listener lifecycle logs and session validity.
- `last_error_category` is intentionally categorical; sensitive SDK/API payloads are not returned by health.
- `[zalo-listener] unavailable; recovery watchdog started`: the listener is down and the SDK is still allowed to reconnect.
- `[zalo-listener] recovery timeout; requesting supervisor restart`: the recovery deadline elapsed. Confirm the supervisor restarted the process and `/health` returned to HTTP 200 before considering QR login.

## Link Card Is Raw JSON

- Run `npm run test:hardening` and rebuild.
- Only HTTP(S) URLs are rendered. Device paths, `file:`, `data:`, and script URLs are intentionally discarded.
- Malformed `params` must fall back to readable title/description text rather than exposing the raw payload.
