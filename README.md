# Chore Quest 🐾

A cheerful, self-hosted chore board for a family: each child signs in with their own PIN, logs only under their identity, sees the same shared dashboard, and earns points while parents manage the household. It is a mobile-first PWA that can be added to an iPhone Home Screen. The app runs as one Node service with SQLite storage; it does not require a cloud account.

## Included in the first version

- Two starter child profiles; a parent sets a unique PIN for each during setup, and can add profiles or set/reset PINs later.
- Cat litter (2 completions/day), Dishwasher, Folding laundry, and Hanging laundry.
- Per-chore daily targets, quantity units (for example, `loads`), points, and round-robin turns across all children.
- Timestamped completion history, daily progress, next-child display, weekly scores, badges, and a shared weekly goal.
- Add/edit/deactivate chores; parent-session-protected name/profile/PIN/settings changes and correction/deletion of recent logs.
- Optional profile-specific Web Push alerts when the next turn changes. A device can subscribe for either or both child profiles.
- A responsive installable PWA with a service worker and offline app-shell fallback.

Child PINs are unique 4–8 digit codes. The server stores salted PIN hashes, never the entered codes. After sign-in, the browser receives an HttpOnly session cookie that expires after 12 hours; children can sign out or switch user at any time. Parent sessions can select a child when logging a chore and go into settings without re-entering the parent PIN. Five incorrect PIN attempts within 15 minutes trigger a 15-minute cooldown, stored in SQLite and keyed to the direct TCP peer; when traffic passes through one reverse proxy, all clients share that proxy's cooldown.

On an existing installation, the database migrates in place at startup and keeps existing chores/logs. Preserve the current `.env` and `data/` directory when upgrading. Since existing child profiles have no PIN set, sign in as the parent with the existing `ADMIN_PIN`, open House settings, and set a unique PIN for each child before they use child sign-in.

## Quick start with Docker Compose

1. Copy `.env.example` to `.env` and replace `ADMIN_PIN` with a private PIN. Set `TZ` to your household's timezone (for example, `America/New_York` or `Europe/Berlin`).
2. Start it:

   ```sh
   docker compose up -d --build
   ```

3. Open `http://YOUR-HOST:3000` to check the dashboard and API. The database is stored under `./data/` and survives container rebuilds.

The Docker image uses Node 24 LTS. Node 20 reached end of life on March 24, 2026, so the container intentionally uses a supported release even though this project originally targeted Node 20. The host needs Docker Engine and the Docker Compose plugin. To use the app as an installable PWA on iPhone, and especially for Push, expose it over HTTPS with a trusted certificate (for example, through your existing HTTPS reverse proxy). Set `TRUST_PROXY=1` only when one trusted reverse proxy forwards `X-Forwarded-Proto` and is the only network path to the app; otherwise leave it at `0`. Five wrong PIN attempts trigger a 15-minute cooldown based on the direct TCP peer, so all users behind one proxy share that cooldown. Push endpoints are checked for HTTPS and public DNS addresses, and the outgoing request uses the validated address to prevent targeting local/private services or DNS-rebinding them. PIN login is intended as a household access layer, not public multi-tenant authentication; keep the service private or add a VPN/access-control layer before exposing it to the internet.

### iPhone Home Screen and alerts

1. Open the app's **HTTPS** address in Safari on the iPhone.
2. Tap **Share → Add to Home Screen**, then launch Chore Quest from its new icon.
3. Sign in with the child's PIN, then tap **Turn alerts → Turn on**. Allow notifications when iOS asks.
4. Repeat on each child's device, signing in with that child's PIN before enabling alerts. Each subscription is associated with the authenticated child; when a chore is logged, the next child receives the push if subscribed.

Apple's Web Push support requires an iOS/iPadOS 16.4-or-later web app added to the Home Screen. Push permission must be requested from a user gesture; alerts will remain unavailable until VAPID keys and HTTPS are configured. The dashboard still works without push.

### Configure Web Push (optional)

Generate a VAPID key pair locally (after installing dependencies; see Development below):

```sh
npm run vapid
```

Copy the printed `publicKey` and `privateKey` into `.env` as `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`; set `VAPID_SUBJECT` to a contact URI such as `mailto:you@example.com`, then restart:

```sh
docker compose up -d --build
```

Never commit `.env` or share the private key. Push payloads contain only the chore name and the next child's name. Browser push services (including Apple's) deliver the alert to the subscribed device.

## Development

Use Node.js 24 LTS (or another supported Node.js 22+ release):

```sh
npm install
npm test
npm run build
npm run dev
```

`npm run dev` starts the API at `http://localhost:3000` and Vite at `http://localhost:5173`; Vite proxies `/api` calls to the API. In development the parent PIN defaults to `2468` unless `ADMIN_PIN` is set. Production startup refuses to run without `ADMIN_PIN`. Sign in with the parent PIN first, then set each child's 4–8 digit PIN in House settings; child PINs must be unique and different from the parent PIN.

For a local Docker build without Compose, run `docker build -t chore-quest .`, then:

```sh
mkdir -p data
docker run --rm -p 3000:3000 -e ADMIN_PIN='choose-a-private-pin' -e DB_PATH=/app/data/chorequest.db -v "$PWD/data:/app/data" chore-quest
```

## Data and operational notes

- SQLite file: `data/chorequest.db` on the host (Docker bind mount).
- Back up the app by stopping it or using SQLite's online backup tools, then copy the `data/` directory. Restore by putting the database file back in the same directory.
- Daily progress and weekly scoring use the configured `TZ` timezone. Week starts Monday.
- Points are awarded per completed chore log, not multiplied by quantity. A parent can change each chore's point value.
- Turns rotate through the registered children in order, based on the child who actually logged the completion. A child session can only log as that child; the parent can select a child and log on their behalf. Correcting the newest log recalculates that chore's next turn; deleting a record does not rewind rotation.
- If push is not configured, not supported, or denied by the browser, logging and the in-app “next up” display continue to work.

## Tests

```sh
npm test
npm run build
```
