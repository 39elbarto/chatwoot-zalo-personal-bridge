# Security Policy

## Sensitive Files

Never commit:

- `.env` or any file matching `.env.*`
- `data/session.json`
- `data/qr.png` or any QR image
- `data/message-map.json`
- `data/zalo-mentions.json` if it contains real user IDs or aliases
- raw browser cookie exports
- Chatwoot API tokens, account IDs tied to private deployments, inbox identifiers, URLs, phone numbers, or real Zalo UIDs

If any of these are exposed, delete the public copy, rotate the Chatwoot token, invalidate the Zalo session by logging out linked devices, generate a new QR login, and review Chatwoot audit logs.

## Reporting a Vulnerability

Open a private security advisory on GitHub or email the repository owner listed on the GitHub profile. Include:

- affected version or commit
- reproduction steps
- expected impact
- whether any token, cookie, session, or user data was exposed

Do not post live cookies, tokens, QR codes, or private user identifiers in public issues.
