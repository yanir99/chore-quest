# Chore Quest Implementation Plan

> **For Hermes:** Implement the approved household chore tracker as a mobile-first PWA and verify it with a real local run.

**Goal:** Build a cheerful iPhone-friendly, self-hosted web app where children sign in with unique PINs, securely log their own chores, see shared per-chore progress and turns, and earn points while parents manage the household.

**Architecture:** A single Node.js 24 Alpine container serves a React/Vite PWA and an Express JSON API. SQLite persists household data in a Docker volume. Chores rotate through all registered child profiles after each completion; per-chore daily targets and optional quantity units support twice-daily litter and laundry loads. Child PIN hashes and hashed expiring sessions secure identity; the API derives child log identity from the session. Web Push subscriptions are associated with a child profile. Parent-only actions require an authenticated parent session created with the environment-based parent PIN.

**Tech Stack:** Node.js 24, Express, SQLite (`better-sqlite3`), React, Vite, Web App Manifest, Service Worker, Web Push (`web-push`), Docker Compose.

---

## Approved v1 scope

- Two starter child profiles with unique PIN sign-in; parents can add profiles and set/reset PINs.
- Seed chores: Cat litter (2/day), Dishwasher (1/day), Folding laundry (1/day, quantity unit `loads`), Hanging laundry (1/day, quantity unit `loads`). Parent can add, edit, deactivate chores and set target/day, quantity unit and points.
- Timestamped completion log with child, chore, quantity, daily progress, and next assigned child.
- Round-robin turns through all registered child profiles after each completion.
- Simple points/badges and weekly goals/scoreboard.
- Authenticated parent session for configuration, profile/PIN management, and log correction/deletion.
- iPhone-installable PWA and opt-in Web Push per child/device.
- Docker deployment with persistent SQLite and environment-based secrets.

## Task 1: Bootstrap server, database, and API

**Files:** `package.json`, `server/index.js`, `server/db.js`, `server/routes.js`, `server/domain.js`, `tests/domain.test.js`, `tests/api.test.js`, `Dockerfile`, `.dockerignore`.

- Create a Node 24 project with test scripts and dependencies.
- Add a SQLite schema and seed two children plus the four requested chores.
- Implement validated API routes for listing children/chores/logs, logging a chore with quantity, turn advancement, weekly scores, editing household configuration behind a server-validated parent PIN, correcting/deleting logs, and storing push subscriptions.
- Add focused tests for daily target progress, alternating turns, quantity validation, weekly points, and PIN protection.
- Run tests and a server smoke test before proceeding.

## Task 2: Build the mobile PWA interface

**Files:** `client/index.html`, `client/src/main.jsx`, `client/src/App.jsx`, `client/src/styles.css`, `client/public/manifest.webmanifest`, `client/public/sw.js`, `client/vite.config.js`.

- Create a colorful, responsive dashboard with child selection, four chore cards, progress toward daily targets, quick quantity controls, recent activity, next-turn cues, points, badges, and a friendly weekly scoreboard.
- Add parent settings and correction screens protected by the PIN prompt.
- Add an Add to Home Screen manifest and service worker; expose an explicit notification opt-in action and associate subscriptions with the selected child.
- Show useful status and fallback UI when push is unavailable or not configured.

## Task 3: Add push and admin workflow

**Files:** `server/push.js`, `server/routes.js`, `client/src/components/NotificationSetup.jsx`, `client/src/components/ParentPanel.jsx`, `tests/push.test.js`.

- Configure VAPID keys via environment variables; do not store secrets in source.
- On successful chore completion, notify the next child only when that child has an active subscription.
- Remove expired subscriptions and avoid failing a chore log if push delivery fails.
- Ensure parent-only changes/corrections require the PIN and are recorded with their original timestamps preserved where appropriate.

## Task 4: Containerize, document, and verify

**Files:** `docker-compose.yml`, `.env.example`, `README.md`, `tests/smoke.test.js`.

- Add a persistent database volume and health check; document first run, backup, PIN, VAPID setup, HTTPS/reverse proxy, iPhone installation, notification opt-in, and troubleshooting.
- Ensure the production container serves the compiled client and API from one origin.
- Run the complete test suite, build the frontend, start the service using the available Docker tooling or a documented local fallback, and verify seeded chores, logging, rotation, and persistence with real requests.

## Acceptance criteria

1. Fresh install has exactly two starter profiles and the four requested chores, with cat litter set to two daily completions.
2. A child enters their own PIN, sees the shared family dashboard, logs a chore, and the server records it only under that child.
3. Rotating turns, weekly totals, editable chores and parent-protected corrections work and persist after restart.
4. The PWA is installable from iPhone Safari; push setup is opt-in, profile-specific, and reports when HTTPS/VAPID is missing.
5. Docker deployment persists data and secrets/configuration are environment-driven.
6. Automated tests and production build pass; documented run instructions match the verified setup.
