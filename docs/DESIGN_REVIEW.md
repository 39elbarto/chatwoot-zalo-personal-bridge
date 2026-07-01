# Design Review: Documentation Onboarding Flow

## Context

- Artifact: README and docs folder.
- User goal: a new operator must understand risks, install the bridge, log in to Zalo, connect Chatwoot, and maintain the service safely.
- Audience: technical operator with Chatwoot access and a Zalo mobile account.
- Platform / stage: documentation-first open-source repo.
- Assumptions: no UI exists; README is the landing/onboarding surface.

## What Is Working

- The README starts with the product job and risk disclaimer before setup.
- Quick start is short enough to scan.
- Runtime secrets are repeatedly called out as uncommitted files.
- Detailed procedures are split into topic docs instead of making README too long.

## Priority Issues

### Critical Issue: Secret Boundaries Must Be Visible Before Setup

- What is happening: operators create `.env`, QR files, cookies, and session files during first use.
- Why it matters: these files can grant account access if committed or shared.
- Recommended change: place the disclaimer, `.gitignore`, `.env.example`, `SECURITY.md`, and release checklist before publication. This was added.

### High Issue: QR Login Recovery Was Too Easy To Miss

- What is happening: setup depends on an unofficial QR/session path that can expire.
- Why it matters: a new operator may mistake session expiry for code failure.
- Recommended change: add a dedicated `docs/ZALO_SESSION.md` and runbook failure mode. This was added.

### High Issue: Chatwoot Template Delivery Needs Explicit Framing

- What is happening: Chatwoot can send automations as templates rather than ordinary outgoing messages.
- Why it matters: operators may debug the wrong layer if a template is visible in Chatwoot but absent in Zalo.
- Recommended change: document accepted message types and separate formatting caveats from delivery. This was added in README and `docs/CHATWOOT_SETUP.md`.

### Medium Issue: Mention Markers Need Fake, Copyable Examples

- What is happening: mention support requires group IDs and UIDs.
- Why it matters: real examples would leak private identifiers and fake examples that are not copyable slow onboarding.
- Recommended change: use `alice`, `bob`, fake UIDs, and `group:1234567890` everywhere. This was applied to docs and tests.

## Top 3 Next Steps

1. Keep README focused on first successful setup and link to deeper runbooks.
2. Keep every operational doc executable with commands, expected results, and stop conditions.
3. Re-run secret scans after any fixture or documentation update.
