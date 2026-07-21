# Security Checklist

## Before Public Release

- [ ] `git status -sb` shows only intended source/docs/example files.
- [ ] `.env`, `.env.*`, `data/`, `dist/`, `node_modules/`, QR files, sessions, and message maps are untracked.
- [ ] `rg` finds no private domains, tokens, real UIDs, phone numbers, emails, staff names, or private service names.
- [ ] `npm run build` passes.
- [ ] `npm test` passes.
- [ ] `npm audit --omit=dev` has no unresolved high severity issues.
- [ ] Scoped UBS reports no unresolved critical or warning findings in changed executable files.
- [ ] `gitleaks detect --no-git --source .` passes if gitleaks is installed.
- [ ] `gitleaks git . --no-banner --redact` passes across repository history.
- [ ] Health output contains no UID, token, cookie, IMEI/device, thread, or contact identifier.
- [ ] `.env.example` leaves `ZALO_EXPECTED_SELF_UID` empty.
- [ ] README states the unofficial API and policy/stability risk.
- [ ] `SECURITY.md` explains session/cookie/token exposure response.

## Release Checklist

- [ ] Commit from a new clean repo with no private history.
- [ ] Push only after scans pass.
- [ ] Confirm GitHub visibility is public only after the sanitized initial commit.
- [ ] Review rendered README and docs links.
- [ ] Re-run secret scan after any documentation or fixture change.
