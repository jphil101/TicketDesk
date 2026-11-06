# Ticket Desk

A low-friction personal ticketing app. Type what needs doing, tap **Urgency** and **Impact**, press **Add**. The priority (P1–P5) is set for you from the standard ITIL urgency × impact matrix.

- **Day** (main view), **Fortnight** and **Month** breakdowns, plus a **Done** section with search, date range and priority filters
- **Suggestions** from your past task names while you type. They are only suggestions and are never typed in for you.
- **Carry over:** at the start of each day, unticked tasks from earlier days move to today. They appear in their own *Carried over* section showing where they came from and how many days they've been carried. Past days note what moved on.
- **Insights & habit tracking (Done tab):** month-by-month completion calendars for the last 6 months, day streaks, and a per-habit strip for each recurring task (done / missed, streak, completion rate). Also aging open tickets and median time to done by priority. Searching narrows everything, so "gym" shows just your gym days.
- **Opened and done times:** every ticket records the exact moment it was opened (when you press Add, or accept a guest request) and when it was done, and shows how long it took.
- **Export from Done:** *Completed tickets* (one row each, with opened/done times and hours to done) or *Daily totals & habits* (one row per day, with a 1/0 column per habit). Both are CSV and follow the current filters.
- **Notifications:** a push notification the moment a guest sends a ticket, and a short morning summary (open today, P1/P2 counts, carried over, guest requests waiting). Optional email alerts. All free.
- **Snooze:** one tap moves a ticket to tomorrow, in 2 days, next week, or a day you pick. Tickets carried 5+ days ask once: *Still relevant? Keep · Snooze · Drop*.
- **Quick capture:** share text or a link from any Android app into Ticket Desk, or open `/?new=…` from an iOS Shortcut or Siri. Links you share are saved in the ticket's notes.
- **Guest links:** share a QR code or link that lets someone send you tickets (*Drop-off*), or send tickets and see your open tickets read-only (*Drop-off + view*). You choose how long it works (1 hour to 1 week). You review every guest ticket before it goes on your list.
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

## Guest links

Tap **Guests**, choose what guests can do and how long the link works, then share the QR code or link. Sync must be on.

| Access | Guests can |
|---|---|
| **Drop-off** | send tickets (task + urgency + impact, optional name). Nothing else. |
| **Drop-off + view** | also see your open tickets, read-only. Notes, ticket IDs and finished work stay private. |

- Guest tickets appear under **Guest requests** at the top of today's Day view on every device you've linked, with a count on the **Guests** button. **Add to today** keeps the guest's priority and notes who asked. **Decline** removes it. Both can be undone.
- The link is a random token in the URL fragment. The server stores only its SHA-256 hash, and guests never see your sync key.
- A link stops working when its time runs out (1 hour, 4 hours, 1 day or 1 week; default 1 hour), when you tap **Stop sharing now**, or when you make a **New link**. Only one link is live at a time, so nobody keeps permanent access.
- Limits: 50 unreviewed requests per desk and 200 tickets per link. A viewing guest's board refreshes every minute while they're active, and stops when they're idle, so the database can still sleep.

```
POST /api/guest
  owner  (Authorization: Bearer <sync key>)  {action:"status"} | {action:"create", mode:"submit"|"view", ttlMinutes} | {action:"revoke"}
  guest  (Authorization: Guest <token>)      {action:"info"} | {action:"submit", name, urgency, impact, from?}
```

## Notifications

**Push (free, no setup):** open **Settings → Notifications → Turn on for this device** on each phone or computer you want alerts on. The server creates its push keys automatically the first time.
- *When a guest sends a ticket*: straight away.
- *Morning summary*: once a day, only when something is open or waiting.
- On iPhone/iPad, push works only in the Home Screen app (Share → Add to Home Screen, then open it from there). This is Apple's rule.
- Each device has its own on/off switches. Unlinking a device turns its notifications off.

**Email (optional, free):** create a free account at [resend.com](https://resend.com) (3,000 emails/month, 100/day), make an API key, then in Vercel add `RESEND_API_KEY` and redeploy. Your email address then appears under Settings → Notifications. Without your own domain, Resend only delivers to the address you signed up with, so use that address. To send from your own domain, verify it in Resend and set `EMAIL_FROM`, for example `Ticket Desk <tickets@yourdomain.com>`.

**Summary time:** Vercel's free plan runs scheduled jobs once a day, sometimes up to an hour late. The default is **02:00 UTC**, which is 07:30 in India, 03:00/04:00 in central Europe, and the previous evening in the Americas. To change it, edit the hour and minute in `vercel.json` (`"schedule": "0 2 * * *"` is minute 0, hour 2, UTC). Put the same time in `DIGEST_UTC` in `lib/notify-core.js` (a test checks they match). The app shows the time in each device's own time zone.

## Quick capture

- **Android:** after installing the app (Chrome menu → *Install app*), **Ticket Desk** appears in the system Share menu. Shared text becomes the ticket name. A shared link goes into the ticket's notes. You still choose urgency and impact. Long-press the app icon for a **New ticket** shortcut.
- **iPhone (Shortcuts / Siri):** in the Shortcuts app, create a shortcut with these four actions:
  1. **Dictate Text** (or **Ask for Input** to type)
  2. **URL Encode**, applied to that text
  3. **URL**: `https://<your-site>/?new=` followed by the *URL Encoded Text* variable
  4. **Open URLs**

  Name it "New ticket", then say *"Hey Siri, New ticket"*. Shortcuts open Safari rather than the Home Screen app, so link Safari to your desk once as well (Settings → *I have a key*).
- **Links:** `/?new=Call+the+bank` pre-fills the box. Add `&u=3&i=2` to preselect urgency and impact (1 low, 2 medium, 3 high). Nothing is added until you press **Add ticket**.

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
| `RESEND_API_KEY` | no | Turns on email alerts (Resend's free plan). |
| `EMAIL_FROM` | no | Sender for email alerts. Default `Ticket Desk <onboarding@resend.dev>`. |
| `CRON_SECRET` | no | If set, Vercel signs its daily summary call with it and nobody else can trigger the summary. Without it, a summary still goes out at most once a day per device. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | no | Your own push keys. By default they're generated and stored in the database. |
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
api/sync.js               Vercel function: POST /api/sync (GET for setup diagnostics)
api/guest.js              Vercel function: POST /api/guest (guest links)
api/notify.js             Vercel function: POST /api/notify (push and email settings)
api/digest.js             Vercel cron target: daily morning summary
lib/sync-core.js          sync protocol, validation and SQL
lib/guest-core.js         guest links: create / status / revoke / info / submit
lib/notify-core.js        web push, email (Resend), daily summary
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
