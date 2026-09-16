# Ferrier Field Inventory

A small web app for the TAQA Ferrier job: your crew searches material inventory
and sends a pickup request with a couple of taps — no account, no app-store
install, just a link. You get an instant alert (on-screen, and a push
notification to your phone/computer) every time someone sends one, review
requests in an Admin tab locked behind a PIN, and mark them fulfilled —
which automatically subtracts the quantity from inventory.

It's a real web app that needs to run somewhere so the link works for
everyone, all the time. This guide walks you through the one-time setup —
about 15 minutes, no coding involved.

---

## 1. What you're deploying

- `server.js` + `lib/` — the backend (Node.js). Talks to the world through
  a small number of API routes and keeps everything in one file,
  `data/db.json`, which is created automatically the first time it runs.
- `public/` — the app your crew and you actually see in the browser.
- `data/seed-inventory.json` — the 56 items pulled from your
  `TAQA_Ferrier_Receiving_Material_Control_rev.5.xlsx` (Received Items tab).
  This loads in automatically the first time the app starts.

Only two external packages are used (`express`, `web-push`), both extremely
common and stable, so the install step is quick and low-risk.

## 2. Put the code on GitHub (no command line needed)

Render (the host we'll use) deploys from a GitHub repository, and GitHub's
website lets you upload files by dragging them in — you never need to
install git or type a git command.

1. Go to [github.com](https://github.com) and sign up (free) if you don't
   already have an account.
2. Click the **+** in the top right → **New repository**. Name it
   `ferrier-field-inventory`, keep it **Private**, and click **Create repository**.
3. On the new repo's page, click **uploading an existing file**.
4. Drag the entire contents of this folder in (everything inside
   `ferrier-inventory/`, not the folder itself — `server.js`, `lib/`,
   `public/`, `data/`, `package.json`, this `README.md`). Commit the upload.

## 3. Deploy to Render (free, no credit card)

1. Go to [render.com](https://render.com) and sign up — you can use your
   GitHub account to sign in, which also connects the two automatically.
2. Click **New +** → **Web Service**.
3. Choose the `ferrier-field-inventory` repo you just created.
4. Fill in:
   - **Name:** `ferrier-inventory` (or whatever you like — this becomes part of your URL)
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
5. Click **Advanced** and add these environment variables:

   | Key | Value |
   |---|---|
   | `ADMIN_PIN` | a PIN only you know, e.g. `7749` (digits or letters, your choice) |
   | `VAPID_CONTACT_EMAIL` | your email, e.g. `073074@gmail.com` |

   (You can skip `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` entirely — the app
   generates its own the first time it starts and remembers them.)

6. Click **Create Web Service**. Render will install dependencies and start
   the app — takes 2-3 minutes the first time. When it's done, you'll get a
   URL like `https://ferrier-inventory.onrender.com`. **That's the link you
   share with your crew.**

### A note on the free tier

Render's free instance goes to sleep after 15 minutes of no traffic and
takes about a minute to wake back up on the next visit — the first person
to open the link after a quiet spell will see a short delay, everyone after
that is instant. It also means push notifications still work (they don't
depend on the app being awake), but the site itself needs that one visitor
to "tap it awake."

If that wake-up delay bothers you, or once this is actually running your
job site day to day, Render's paid **Starter** instance ($7/mo at the time
of writing) removes the sleep delay and adds a real persistent disk, so
`data/db.json` survives every redeploy automatically. On the free tier the
data survives normal restarts fine, but **can** reset on a redeploy — see
the Backups section below.

## 4. Try it

Open your new URL. You should see the inventory (Pile Caps, rotameters,
structural frames, etc. — pulled straight from your spreadsheet). Tap a
quantity on any item, hit **Review & Send**, fill in a name, and send a
test request to yourself.

Then tap **Admin** in the top right, enter the PIN you set, and you should
see that test request waiting in **Requests**. Fulfilling it will subtract
the quantity from inventory automatically.

### Turning on phone/computer alerts

In **Admin → Alerts**, tap **Enable Alerts on This Device** on your phone
and your computer (do this separately on each — it's a one-time toggle per
device/browser). Tap **Send Test Alert** to confirm it arrives.

- **Android / desktop Chrome, Edge, Firefox:** works immediately, even with
  the browser closed.
- **iPhone:** open the link in Safari, tap the Share icon → **Add to Home
  Screen**, then open the app from that home screen icon (not from Safari)
  before enabling alerts — this is an Apple requirement for web push, not
  something this app can skip.

Even without enabling push on a given device, any browser tab you have open
on the **Admin** view gets an instant on-screen banner and a chime the
moment a request comes in.

## 5. Day-to-day

- **Changing the PIN:** In Render, go to your service → **Environment**,
  update `ADMIN_PIN`, save. The service restarts automatically with the
  new PIN.
- **Recording a new delivery (the normal way):** keep logging it in your
  Excel workbook the way you always have — a new row per item on the
  RECEIVED ITEMS tab, under its MRR #. Then go to Admin → Inventory →
  **Import from Excel…** and pick that same workbook file. New rows get
  added as new inventory items; rows the app has already seen (matched by
  the workbook's own per-row ID) get their details refreshed instead of
  duplicated. If you correct a received quantity in Excel and re-import,
  the app adjusts what's available by that difference rather than
  overwriting it — so anything already picked up through the app isn't
  affected. A toast after each import tells you how many rows were added,
  updated, or left unchanged.
- **Searching by area:** add an **Area** column to the RECEIVED ITEMS tab
  (any of the headers `Area`, `Work Area`, or `Zone` is recognized) and fill
  it in per row — job-site zone, unit number, whatever your crew calls it.
  Once imported, an "Area" dropdown appears next to the Discipline filter on
  the Search & Request screen so your crew can narrow results to just their
  area. Items with no Area value show up under "Unassigned" until you tag
  them.
- **Adding a one-off item that isn't in Excel:** Admin → Inventory →
  **+ Add Item**.
- **Editing quantities, area, or storage locations by hand:** Admin →
  Inventory, edit directly in the list — it saves as you tab away from the
  field.
- **Backups:** Admin → Alerts → **Download Backup** gives you the full
  inventory + request history as a file. Worth doing occasionally, and
  definitely right before you push a code change to redeploy.

## 6. Testing locally (optional)

If you or someone technical wants to try this on a laptop first:

```
npm install
npm start
```

Then open `http://localhost:3000`. The default PIN is `7749` unless you set
`ADMIN_PIN` yourself. Push notifications need a real HTTPS site to work in
the browser, so they won't work on `localhost` — that part only needs
testing after deploying.

## How the alerts actually work (so you know what to expect)

There's no such thing as a fully public website that pings your phone the
instant something happens *with zero setup* — every "live alert" system
(text messages, email, app notifications) needs some kind of one-time
opt-in. This app uses the same technology as normal app push notifications
(the W3C Push API), which is why enabling it is a one-time toggle per
device rather than a account you sign up for. Once it's on, it's genuinely
instant — the server pushes to your phone/computer the moment a request
is submitted, it doesn't check on a timer.
