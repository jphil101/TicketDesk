# Moving Ticket Desk from claude.ai to your own site

This guide moves your tasks from the claude.ai version of Ticket Desk to your own copy, hosted on **Vercel** with a **Neon** Postgres database, and links your phone and laptop to it. It takes about 20 minutes and costs nothing on the free plans.

**What you need:** your GitHub account, a laptop, and your phone.

| Step | Where | Time |
|---|---|---|
| 1. Export your tasks | claude.ai version | 1 min |
| 2. Put the code on GitHub | GitHub | 3 min |
| 3. Deploy to Vercel | vercel.com | 3 min |
| 4. Add the Neon database | vercel.com | 3 min |
| 5. Turn on sync and import your tasks | your new site, laptop | 2 min |
| 6. Link your phone and install the app | your new site, phone | 3 min |
| 7. Lock the server to your key | vercel.com | 2 min |
| 8. Retire the claude.ai version | claude.ai | 1 min |

---

## 1. Export your tasks from the claude.ai version

1. Open the claude.ai version: <https://claude.ai/artifact/PHFbey9XbxRrEDD6TmPiFF>
2. Tap the status pill next to the title (it says **Synced**), or the **Sync & backup** button.
3. Tap **Export backup** and accept the save prompt.
4. You now have a file named like `ticket-desk-backup-2026-11-05.json`. Keep it somewhere you can reach from your laptop. It holds every task and recurring task.

> From here on, don't add tasks in the claude.ai version. Anything added there after the export won't come across.

## 2. Put the code on GitHub

1. Go to <https://github.com/new>.
2. **Repository name:** `TicketDesk`. Choose **Private** or **Public**. Leave *Add a README*, *.gitignore* and *license* **unticked**, because the repo must be empty.
3. Click **Create repository**.
4. Make sure Claude can push to it. If the Claude GitHub App only has access to selected repositories, add `TicketDesk` at <https://claude.ai/connect-github>.
5. Tell Claude “the repo is ready” in this session. Claude pushes the code to `main`.

**Check:** <https://github.com/jphil101/TicketDesk> shows `public/`, `api/`, `README.md` and this guide.

## 3. Deploy to Vercel

1. Go to <https://vercel.com/signup> and choose **Continue with GitHub**. The free **Hobby** plan is enough, but it's for personal, non-commercial use.
2. Go to <https://vercel.com/new>. Under *Import Git Repository*, find **TicketDesk** and click **Import**. If it isn't listed, click **Adjust GitHub App Permissions** and give Vercel access to it.
3. On the configure screen:
   - **Framework Preset:** `Other`
   - **Root Directory:** leave as `./`
   - **Build and Output Settings:** leave everything as it is. `vercel.json` already tells Vercel to serve `public/` and run `api/sync.js`.
4. Click **Deploy** and wait about a minute.
5. Click the preview to open your site, at an address like `https://ticket-desk-xxxx.vercel.app`.

**Check:** the app loads and the pill says **This device**. Sync won't work yet because there's no database.

## 4. Add the Neon database

1. In your Vercel project, open the **Storage** tab, then **Create Database**, then **Neon** (Serverless Postgres), then **Continue**.
2. Pick the **Free** plan.
3. **Region:** pick the one closest to you.
4. Name it `ticket-desk` and click **Create**.
5. When asked which environments to connect, keep **Production**, **Preview** and **Development** ticked, then **Connect**. Vercel adds `DATABASE_URL` and a few related variables to the project automatically.
6. **Match the function region to the database.** Go to **Settings**, then **Functions**, then **Function Region**, and pick the region nearest the database region from step 3. Then **Save**. With the two far apart, every sync makes a round trip across the world.
7. **Redeploy** so the function picks up `DATABASE_URL`: go to **Deployments**, open the **⋯** menu on the latest deployment, choose **Redeploy**, then confirm.

You don't need to create any tables. The server creates them on the first sync. `schema.sql` shows what it makes.

## 5. Turn on sync and import your tasks (laptop)

1. Open your Vercel site on your laptop.
2. Tap the **This device** pill, then **Turn on sync**.
3. The pill should change to **Synced**. If it says **Sync off**, see *Troubleshooting* below.
4. **Save your sync key now.** Click **Copy key** and store it in your password manager as “Ticket Desk sync key”. It looks like `TD-7K3QX-M2PZD-9VBNH-4RWEA`.
   - The key is your login. Anyone who has it can read and change your tasks.
   - If you lose the key *and* every linked device, your tasks can't be recovered.
5. In the same sheet, click **Import backup** and choose the `.json` file from step 1.
6. You should see “Imported N tasks and M recurring”, and your tickets appear on the Day view. Open **Done** and **Recurring tasks** to confirm they came across too.
7. **Optional:** install it as an app. In Chrome or Edge, click the install icon at the right end of the address bar.

## 6. Link your phone and install the app

**iPhone.** Install first, then link, because a home-screen app on iPhone keeps its own storage, separate from Safari.

1. Open your Vercel site in **Safari**.
2. Tap **Share**, then **Add to Home Screen**, then **Add**.
3. Open **Ticket Desk** from your home screen, not from Safari.
4. Tap the **This device** pill, then **I have a key**, paste the key from your password manager, and tap **Link**.
5. The pill shows **Synced** and your tasks appear.

**Android**

1. On your laptop, open **Sync & backup** to show the QR code.
2. Scan it with your phone's camera, open the link in Chrome, and tap **Link this device**.
3. In Chrome, open the **⋮** menu and choose **Install app** (or **Add to Home screen**).

**Check:** tick a task on the phone. Within about 15 seconds it shows as done on the laptop. Switching back to the laptop window makes it sync straight away.

**Optional: notifications.** Once the app is on your Home Screen, open **Settings → Notifications → Turn on for this device** to get alerts for guest tickets and a morning summary. For email alerts as well, see *Notifications* in the README.

## 7. Lock the server to your key

Your site is public, so anyone who finds the address could create their own key and store data in your database. Once all your devices are linked, close that off:

1. In Vercel, go to **Settings**, then **Environment Variables**, then **Add New**.
2. **Key:** `ALLOW_NEW_DESKS`. **Value:** `false`. **Environments:** all. Click **Save**.
3. **Redeploy** as in step 4.7.

Your existing key keeps working everywhere. To link a new device later, the existing key still works. Only brand-new keys are refused.

## 8. Retire the claude.ai version

The claude.ai version and your Vercel site **don't sync with each other**. Using both will split your tasks.

1. Stop using the claude.ai link and remove any bookmark or pin to it.
2. **Optional:** ask Claude to delete the claude.ai artifact. Only do this after you've checked step 5 imported everything.

---

## Day-to-day

- **Updates:** anything pushed to `main` on GitHub deploys automatically within a minute. Open apps pick it up on their next reload.
- **Backups:** once a month, go to **Sync & backup** and use **Export backup**. It's your copy if anything goes wrong with the database or the key.
- **Usage:** Neon's free plan includes 100 CU-hours of compute per month, and the database sleeps after 5 idle minutes. Ticket Desk stops checking for changes after 10 idle minutes, so light personal use stays well inside the allowance. In your first week, check the Neon dashboard (Vercel **Storage**, then your database, then **Open in Neon**, then **Usage**).
- **Custom domain (optional):** Vercel **Settings**, then **Domains**. If you change the address, link each device again on the new address. Every address keeps its own copy in the browser.

## Troubleshooting

| You see | What it means | Fix |
|---|---|---|
| Pill says **Sync off**, or “Sync isn’t set up on this server yet” | The function can't find the database connection | Open `https://<your-site>/api/sync` in a browser. It names the problem and the fix: database not connected to this environment, not redeployed since connecting, or saved under a name it doesn't recognise. Then tap **Sync now**. |
| Pill says **Key rejected** | Usually `ALLOW_NEW_DESKS=false` plus a key the server hasn't seen (a typo, or **Turn on sync** pressed again) | Use **I have a key** with the key from your password manager. To start over, remove `ALLOW_NEW_DESKS` and redeploy. |
| Pill says **Retrying** | The server or database returned an error | Vercel project → **Logs**, filter `/api/sync`. If Neon has hit its monthly cap, the database is suspended until next month. Your changes stay queued on each device meanwhile. |
| Pill says **Offline** | No connection | Nothing to do. Changes stay queued and sync when you're back online. |
| iPhone app is empty after a while | iOS cleared the website's storage. Safari does this for sites you haven't opened in 7 days unless they're on the home screen. | Use the home-screen app (step 6), and re-link with your key. Your tasks come back from the server. |
| Import says “isn't a Ticket Desk backup” | Wrong file | Pick the `ticket-desk-backup-….json` file, not the CSV. |
| A task changed on two devices at once | The later edit wins for the whole ticket | Re-edit it. This only happens with near-simultaneous edits. |
