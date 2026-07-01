# Zalo Session Handling

## QR Login

Run:

```bash
npm run login:qr
```

The script creates `data/qr.png` and prints progress in the terminal. Open the Zalo mobile app, scan the QR image, and confirm login.

## Persisted Files

Sensitive runtime files:

- `.env`
- `data/session.json`
- `data/qr.png`
- raw browser cookie exports

These files grant access to the Zalo account session. They are ignored by `.gitignore` and must not be sent to issue trackers, logs, or chat.

## Expiry Handling

Symptoms of expiry:

- bridge starts but cannot receive events
- login errors from the Zalo library
- repeated websocket/session errors

Recovery:

```bash
sudo systemctl stop chatwoot-zalo-personal-bridge
mv data/session.json data/session.json.expired.$(date +%Y%m%d%H%M%S)
npm run login:qr
sudo systemctl start chatwoot-zalo-personal-bridge
```

If you do not use systemd, stop and restart your process manager instead.

## Browser Session Import

If QR login is unavailable, you can import cookies exported from a browser profile:

```bash
npm run import:browser-session -- --cookies /private/path/cookies.json --imei "$ZALO_IMEI" --user-agent "$ZALO_USER_AGENT"
```

Treat the cookie export as a secret and delete it after import.
