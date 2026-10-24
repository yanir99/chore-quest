# Child PIN Authentication and Multi-Kid Profiles Plan

> **For Hermes:** Follow this plan task-by-task, preserving existing household data and running the full browser/API verification before delivery.

**Goal:** Require each child to authenticate with a unique PIN, enforce that identity for chore logs, support authenticated parent access without repeated PIN prompts, and let parents add children and set/reset their PINs.

**Architecture:** Store child PINs as salted scrypt hashes in SQLite, and issue opaque, hashed, expiring server-side sessions in an HttpOnly SameSite cookie. The API derives child identity from the authenticated session and only permits a parent session to select a child for chore logging. Migrate existing SQLite databases in place; existing children initially have no PIN, so the parent signs in with the existing `ADMIN_PIN` and configures child PINs.

**Tech Stack:** Existing Node.js 24, Express, SQLite (`better-sqlite3`), React/Vite, browser-based Playwright verification.

---

## Acceptance criteria

1. Unauthenticated requests cannot read the dashboard, activity, or push configuration.
2. A unique child PIN opens the shared family dashboard as that child; the child cannot switch profiles or forge another `memberId` in a log request.
3. A parent can sign in using the existing `ADMIN_PIN`; that session opens settings without a second PIN prompt and can log on behalf of the selected child.
4. Parent settings can add children and set/reset each child's PIN; no plaintext PIN is returned from the API or stored in SQLite.
5. Existing two-child databases migrate without losing chore/log data. Chore turns rotate through every configured child, not just two.
6. Failed PIN attempts are rate-limited; sessions expire and can be logged out.
7. API tests, production build, and a mobile-size browser test verify login, identity enforcement, parent settings, adding a child, PIN reset, and three-child turn rotation.

## Task 1: Schema migration and authentication primitives

**Files:** `server/db.js`, `server/auth.js` (new), `tests/auth.test.js` (new).

- Add nullable `pin_salt` / `pin_hash` fields to `children`, using additive migration for existing SQLite databases.
- Add a persistent `auth_sessions` table for hashed opaque token IDs, role, optional child ID, and expiry.
- Implement 4–8 digit child-PIN validation, salted scrypt hash/verify, PIN uniqueness checks, opaque session creation/lookup/revocation, and session expiry.
- Never expose PIN hash/salt or raw session tokens to dashboard data.

## Task 2: API authentication, authorization, profiles, and rotation

**Files:** `server/index.js`, `server/db.js`, `server/domain.js`, `tests/api.test.js`, `tests/auth.test.js`.

- Add child PIN login, parent PIN login, session inspection, and logout endpoints; apply a persistent failed-login cooldown keyed to the direct TCP peer (never a spoofable forwarded header).
- Require a valid session for dashboard/log/push APIs and parent role for all settings, profile/PIN management, and log-correction endpoints.
- For child sessions, derive log and push-subscription ownership from the session and reject attempts to target another child. Resolve push endpoints to public addresses and pin outgoing HTTPS requests to the validated addresses to prevent local-network SSRF and DNS rebinding. For parent sessions, permit an explicit child target.
- Add parent-only child creation and PIN set/reset endpoints. Validate names/PINs and reject duplicate child PINs or collision with the parent PIN.
- Replace two-child-only turn switching with deterministic sorted-child round-robin; use the same helper after admin log correction.
- Keep `/health` public and retain all existing data/seed behavior.

## Task 3: PWA login and parent controls

**Files:** `client/src/App.jsx`, `client/src/styles.css`, `client/public/sw.js` if cache version needs bump.

- Replace local-storage child selection and per-settings PIN prompt with a login screen for child PIN or parent PIN.
- Show identical household dashboard data to every authenticated role. Lock a child session to the child ID returned by `/auth/me`; hide profile switching for children. Keep parent profile selection available.
- Add logout/switch-user action; parent sessions open settings directly, while child sessions must authenticate as parent to elevate.
- Add parent UI to show PIN configured/unset status, set/reset each PIN, and add a named child with a new PIN. Clear PIN form values after submit and never prefill them.
- Display login, rate-limit, authorization, and save errors visibly; keep mobile layout accessible and masked PIN inputs numeric.

## Task 4: Verification, docs, and release package

**Files:** `README.md`, `.env.example`, tests and production build artifacts.

- Document migration and first-run setup: existing parent signs in, sets child PINs, optional HTTPS/reverse-proxy cookie behavior, session expiry/logout, and recovery steps.
- Add `TRUST_PROXY` configuration so HTTPS terminated by a trusted reverse proxy results in Secure cookies; keep direct HTTP LAN testing functional when unset.
- Run `node --test`, production Vite build, npm audit, API smoke tests, and Playwright flow at a 390×844 viewport.
- Rebuild the downloadable project archive without `.env`, user database, or `node_modules`; integrity-check archive contents.
