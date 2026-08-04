# Diet Tracker — Telegram WebApp Bot

A Telegram bot that opens a small web app for tracking a flexible daily
grams budget: 8 fixed categories (garnish, dairy, "anything", protein,
veggies, fats, fruits, nuts), each with its own calorie target and a list
of items with a maximum daily allowance in grams. Log any amount against
any item, any number of times a day — it accumulates, and going over a
category's budget is tracked (and shown), not blocked.

Daily logs live entirely in the browser via **Telegram WebApp
CloudStorage** (falling back to `localStorage` outside Telegram) — the
server holds no per-user data at all, just the static product catalog.
Built with **grammY** (Telegram bot framework) and **Express** (serves the
WebApp and the catalog).

## What's inside

```
diet-tracker-bot/
├── .env                # your secrets & config (never share this)
├── .gitignore
├── package.json
├── database.js         # builds the static catalog from seed-data.js (no database, despite the name)
├── seed-data.js         # editable product list — grams allowance per item
├── server.js            # Express: serves the catalog + the Telegram bot
└── public/
    ├── index.html        # the WebApp screen shown inside Telegram
    └── app.js             # all app logic — CloudStorage read/write, calorie math, rendering
```

**Where your data actually lives:** each day's logged grams are saved under
a Telegram CloudStorage key like `diet_log_2026-08-06`, synced by Telegram
across that user's devices — not stored on the server, so it survives
Render restarts/sleeps. If CloudStorage isn't available (testing outside
Telegram, or an older Telegram client), the app automatically falls back to
the browser's own `localStorage`, which stays on that one device/browser.

## Step 1 — Install Node.js

If you don't already have it: download and install the **LTS** version from
https://nodejs.org (this also installs `npm`, which you'll use next).

## Step 2 — Install dependencies

"Dependencies" are the pieces of code this project relies on (grammY,
Express). You don't need to understand them — you just need
to tell your computer to download them, once, using a command.

**2a. Open a terminal.** A terminal is just a window where you type text
commands instead of clicking icons.

- **Windows**: click the Start menu, type `cmd`, and press Enter. (Or
  right-click the Start button and choose "Terminal".)
- **Mac**: press `Cmd + Space`, type `Terminal`, and press Enter.
- **Linux**: most distros open a terminal with `Ctrl + Alt + T`.

A black or white window will open with some text and a blinking cursor —
that's it, that's the terminal.

**2b. Navigate into this project's folder.** After unzipping the file I
gave you, you need to move the terminal "into" that folder. Type `cd `
(with a space after it), then drag the unzipped `diet-tracker-bot` folder
from your file explorer/Finder straight into the terminal window — the
full path will be typed in automatically. Then press Enter. For example it
will look something like:

```bash
cd /Users/yourname/Downloads/diet-tracker-bot
```

(On Windows it will look like `cd C:\Users\yourname\Downloads\diet-tracker-bot`.)

**2c. Run the install command.** Now that the terminal is "standing inside"
the right folder, type this exactly and press Enter:

```bash
npm install
```

You'll see some text scroll by for anywhere from a few seconds to a
couple of minutes — that's normal, it's downloading the pieces of code
this project needs into a new `node_modules` folder. When it stops and
gives you a new blank line, it's done. If you see the word `error` in red,
copy the message and I can help you troubleshoot it.

## Step 3 — Create your Telegram bot & get a token

1. In Telegram, open a chat with **@BotFather**.
2. Send `/newbot` and follow the prompts (pick a name and a username ending
   in `bot`).
3. BotFather will give you a token that looks like
   `123456789:AAExampleTokenAbcDefGhi`. Copy it.
4. Open `.env` in this folder and replace `your_token_here` with that token:
   ```
   BOT_TOKEN=123456789:AAExampleTokenAbcDefGhi
   ```

## Step 4 — Make the WebApp reachable over HTTPS

Telegram WebApps **must** be served over a public HTTPS URL — `localhost`
will not work from the Telegram app on your phone. While developing, the
easiest way is a tunnel tool:

```bash
# using ngrok (https://ngrok.com), after installing it:
ngrok http 3000
```

It will print a URL like `https://abcd1234.ngrok-free.app`. Copy that URL
into `.env`:

```
WEBAPP_URL=https://abcd1234.ngrok-free.app
```

(For a permanent setup later, deploy `server.js` to any Node host — Render,
Railway, Fly.io, a VPS, etc. — and put that host's real HTTPS URL here
instead of a tunnel.)

## Step 5 — Run the bot

```bash
npm start
```

You should see:

```
✅ Server listening on http://localhost:3000
✅ Telegram bot is polling for updates
```

Keep this terminal window open — closing it stops the bot.

## Step 6 — Try it

1. In Telegram, open a chat with your bot (search its username).
2. Send `/start`.
3. Tap the **"🍽️ Відкрити щоденник харчування"** button — the WebApp opens
   inside Telegram.
4. Tap a category to expand it, tap an item to log grams against it —
   quick-add buttons, "fill remaining", or type an exact amount, then
   confirm.

Each Telegram user's data is private automatically — CloudStorage is scoped
per-user by Telegram itself, so there's no login screen, password, or
server-side auth to worry about.

## How data is stored

There's no database file anymore. Each day's logged grams live in a
Telegram CloudStorage entry keyed like `diet_log_2026-08-06`, holding a
small JSON object of `{ product_key: grams }` for that day — written and
read directly by `public/app.js`, synced by Telegram across that user's
devices. Outside Telegram (or if CloudStorage ever errors), the app
automatically falls back to the browser's `localStorage` instead, using the
same key format.

The server (`database.js` + `seed-data.js` + `server.js`) only builds and
serves the static product catalog — categories, items, gram allowances,
calorie targets — fetched once when the app opens. It holds no logs, no
user list, nothing that needs to survive a restart.

**Note:** this replaces the previous SQLite-based version. There's no
migration — any history logged under the old version stayed in the old
`diet.db` file and isn't carried forward, since it lived in a different
place entirely (server disk vs. Telegram CloudStorage).

## No more scheduled messages

The previous version sent a 22:00 evening summary and ran a 00:00 reset via
`node-cron`. Both are gone: the evening summary needed the server to read a
user's logged data to build the message, and there is no way to read
CloudStorage from outside the Mini App (no Bot API method for it) — so that
job simply can't work anymore. The daily reset isn't needed either: since
each day is its own CloudStorage key, a new day already starts empty with
no action required.

If you want push-style daily summaries back, that needs a different
approach — e.g. the app itself POSTing its computed status to the server at
some point in the day, with the server caching it somewhere durable enough
to survive a restart (a real hosted database, unlike the local SQLite file
this project used to rely on). That's a bigger change than this refactor
covers.

## Customizing

- **Change category calorie targets or add/remove categories**: edit the
  `CATEGORIES_META` array in `database.js`.
- **Change macro goals**: edit `PROTEIN_TARGET_G` / `CARBS_TARGET_G` /
  `FAT_TARGET_G` in `database.js`.
- **Add/edit products**: edit `seed-data.js` and restart the server — the
  catalog rebuilds fresh every boot, no reseeding step needed. Only append
  new items at the end of a category's list, though — reordering existing
  items shifts their internal keys and orphans any grams users already
  logged against them (see the comment in `database.js` for why).
- **Style/colors**: the app automatically follows Telegram's light/dark
  theme via CSS variables at the top of `public/index.html` — edit the
  `:root { ... }` block to tweak fallback colors.

## Common issues

- **"BOT_TOKEN is not set" on startup** — you still have the placeholder
  value in `.env`; paste your real token from BotFather.
- **Button does nothing / "app not configured"** — `WEBAPP_URL` in `.env`
  is missing or still a placeholder. It must be a real `https://` URL
  Telegram can reach (see Step 4).
- **"CloudStorage недоступний — дані зберігаються локально..."** toast —
  you're testing outside Telegram (a plain desktop browser), or an older
  Telegram client without CloudStorage support. Expected in that case; the
  app is working correctly, just saving to `localStorage` on that one
  browser instead of syncing via Telegram. Opening it through the actual
  Telegram bot button should not show this.
