# Troubleshooting

## Outgoing Chatwoot Message Not Delivered to Zalo

- Confirm the Chatwoot webhook URL is `/webhooks/chatwoot`.
- Confirm logs include `[chatwoot-callback] POST`.
- Confirm the message is public, not a private note.
- Confirm `message_type` is `outgoing` or `template`.
- Confirm the conversation/contact has a Zalo thread identifier.
- Check logs for `[chatwoot-callback] forward to Zalo` and any send error after it.

## Incoming Zalo Message Not Visible in Chatwoot

- Confirm the bridge process is running and `/health` returns `{"ok":true}`.
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

## Webhook Auth or Config Mismatch

- Chatwoot API inbox identifiers are separate from account and inbox IDs.
- A valid Chatwoot user token can still fail if the user lacks account access.
- If multiple bridges share one Chatwoot account, set unique contact/source prefixes.
