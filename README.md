# Ticket Desk

A low-friction personal ticketing app. Type what needs doing, tap **Urgency** and **Impact**, press **Add**. The priority (P1–P5) is set for you from the standard ITIL urgency × impact matrix.

- **Day** (main view), **Fortnight** and **Month** breakdowns, plus a **Done** section with search, date range and priority filters
- **Suggestions** from your past task names while you type. They are only suggestions and are never typed in for you.
- **Carry over:** at the start of each day, unticked tasks from earlier days move to today. They appear in their own *Carried over* section showing where they came from and how many days they've been carried. Past days note what moved on.
- **Recurring tasks** (daily, weekdays, weekly, every 2 weeks, monthly) are added to your day automatically. If last time's copy is still open it moves forward instead of piling up.
- Edit by tapping a ticket. On touch screens, swipe right to complete and left to delete. Every action has Undo.
- **Works offline** and installs to the home screen (iOS, Android, desktop) as a PWA
- **Sync across devices** with a private sync key. No account or email.
- Export to CSV and JSON backup, import from backup

## How sync works

```
 phone ──┐                                   ┌───────────── Postgres (Neon) ─────────────┐
 laptop ─┼── POST /api/sync  (Bearer key) ──▶│ desks(desk = HMAC(key), rev)               │
 tablet ─┘   { since, changes[] }            │ items(desk, kind, id, body, deleted,       │
             ◀── { cursor, changes[] } ──────│       updated_at, rev)                     │
                                             └────────────────────────────────────────────┘
```

1. **Each device saves locally first.** Tasks live in the browser's storage, so the app opens instantly and keeps working offline. Every change also goes into an *outbox*.
2. **Sync is one request.** The device sends its outbox and the cursor it last saw, and gets back every row that changed since. It runs 0.4 s after an edit, when the app regains focus or comes back online, and every 15 s while you're using it. After 2 idle minutes it checks once a minute. After 10 idle minutes it stops completely until you touch the app, so the database can sleep. The same applies while the tab is hidden.
3. **Conflicts:** the most recent edit to a ticket wins, judged by the editing device's clock. Deletes are kept as tombstones so they reach every device. Undoing a delete counts as a newer edit, so the ticket comes back everywhere.
4. **Ordering:** each push takes the next revision number for that desk while holding the desk's row lock. Revisions therefore become visible in order, and a device's cursor never skips a change.
5. **Recurring tasks** are only created after a device has completed a sync. Each occurrence has a fixed ID, so two devices can never create the same one twice.

### The sync key

- Tap the status pill (**This device**), then **Turn on sync**. The browser generates a key like `TD-7K3QX-M2PZD-9VBNH-4RWEA` (100 random bits).
- To link another device, scan the QR code with its camera, or choose **I have a key** and type the key. Typing is case-insensitive, and `O`/`0` and `I`/`L`/`1` are treated as the same character.
- The server never stores the key. It stores only an HMAC of it, so a database leak can't be used to sign in.
- **Anyone with the key can read and change your tasks**, so treat it like a password. If you lose every device *and* the key, the data can't be recovered. Use **Export backup** now and then.
- **Unlink this device** removes the local copy. Your tasks stay on the server and come back when you link again.

## Deploy to Vercel

Moving over from the claude.ai version? Follow **[MIGRATION.md](MIGRATION.md)**, which covers everything below plus exporting and importing your tasks and linking your phone.

1. Import this repository at <https://vercel.com/new>. No build settings are needed: `vercel.json` serves `public/` and deploys `api/sync.js` as a function.
2. In the project, open **Storage → Create Database → Neon (Postgres)** and connect it to the project. This adds `DATABASE_URL` for you. The tables are created on the first sync request (see `schema.sql`).
3. Redeploy so the function picks up the variable. Open the site, tap **This device → Turn on sync**, then scan the code with your phone.
4. Optional: once all your devices are linked, set `ALLOW_NEW_DESKS=false`. The server then refuses any key it hasn't seen, so strangers can't use your deployment as free storage.

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string (Neon adds it). `POSTGRES_URL` also works. |
| `ALLOW_NEW_DESKS` | no | `false` blocks keys the server hasn't seen before. Default `true`. |
| `SYNC_PEPPER` | no | Secret mixed into the key hash. Set it before first use; changing it later disconnects existing keys. |
| `DB_DRIVER` | no | `pg` to use node-postgres for other Postgres hosts (Supabase, RDS, local). The default is Neon's HTTP driver. |

Without a database the app still works fully on each device, and the sync sheet says sync isn't set up.

## Run locally

```bash
npm install
DATABASE_URL=postgres://localhost:5432/ticketdesk DB_DRIVER=pg npm run dev   # http://localhost:3000
```

Tests (need a throwaway Postgres database):

```bash
TEST_DATABASE_URL=postgres://localhost:5432/ticketdesk_test npm test
```

## Files

```
public/index.html         the whole app (HTML, CSS, JS; no framework, no build step)
public/sw.js              offline cache for the app shell
public/manifest.webmanifest, public/icons/   install-to-home-screen
public/vendor/qrcode.js   QR code generator (MIT, Kazuhiko Arase)
api/sync.js               Vercel function: POST /api/sync
lib/sync-core.js          sync protocol, validation and SQL
lib/db.js                 Neon / node-postgres adapter
schema.sql                tables (created automatically)
dev-server.mjs            local server that behaves like Vercel
test/                     protocol tests against real Postgres
extras/claude-artifact.html   the claude.ai artifact version (syncs through claude.ai instead)
```

## Limits and notes

- Browsers: current Safari (iOS/macOS 16.4+), Chrome, Edge and Firefox.
- Conflicts are per ticket, not per field. If two devices edit different fields of the same ticket at the same moment, the later save wins whole.
- A device whose clock is far off can win conflicts it shouldn't. Phones and laptops on automatic time are fine.
- Each request carries at most 500 changes and returns at most 1,000. Larger syncs continue automatically.
