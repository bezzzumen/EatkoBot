# Diet Tracker — Telegram WebApp Bot

A Telegram bot that opens a small web app for tracking a flexible daily
grams budget: 8 fixed categories (garnish, dairy, "anything", protein,
veggies, fats, fruits, nuts), each with its own calorie target and a list
of items with a maximum daily allowance in grams. Log any amount against
any item, any number of times a day — it accumulates, and going over a
category's budget is tracked (and shown), not blocked. Built with **grammY**
(Telegram bot framework), **Express** (web server), and **better-sqlite3**
(local database file, no separate database server needed).

## What's inside

```
diet-tracker-bot/
├── .env                # your secrets & config (never share this)
├── .gitignore
├── package.json
├── database.js         # SQLite schema + the 8 category definitions + logic
├── seed-data.js         # editable product list — grams allowance per item
├── server.js            # Express API + Telegram bot + scheduled jobs
├── diet.db               # created automatically on first run
└── public/
    ├── index.html        # the WebApp screen shown inside Telegram
    └── app.js             # frontend logic (talks to the API)
```

## Step 1 — Install Node.js

If you don't already have it: download and install the **LTS** version from
https://nodejs.org (this also installs `npm`, which you'll use next).

## Step 2 — Install dependencies

"Dependencies" are the pieces of code this project relies on (grammY,
Express, better-sqlite3). You don't need to understand them — you just need
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

Each Telegram user automatically gets their own private data — the app
identifies you via Telegram's signed WebApp data (`initData`), which the
server verifies with your bot token before touching the database, so no
login screen or password is needed.

## How data is stored

Everything lives in a single file, `diet.db`, created next to `server.js`
the first time you run the bot. It's a real SQLite database — you can open
it with any SQLite viewer (e.g. the free "DB Browser for SQLite" app) if
you want to look at the raw tables (`users`, `products`, `daily_logs`).

**Note:** this version's schema is not compatible with the earlier
meal-based tracker. If `diet.db` already exists from that version,
`database.js` detects the old schema on startup, drops those two tables,
and reseeds fresh — any previously logged history is lost, since the data
model itself changed (grams-per-item instead of meals/portions).

## Scheduled messages

Two automated jobs run in the background as long as the server is running
(no separate setup needed — they start with `npm start`), both on
**Europe/Kyiv** time regardless of what timezone the server itself is in:

- **22:00 — Evening summary.** Every user gets a Telegram message with
  total calories vs the daily budget and each category's usage % (with a
  ✅/⚠️ status).
- **00:00 — Daily reset.** Clears the (already-empty) new day's state as a
  safety net and sends a "fresh day" good-morning message.

Keep the terminal running `npm start` open (or deploy it somewhere that
stays running) for these to fire — if the process isn't running at 22:00 or
00:00 Kyiv time, that day's message is simply skipped.

## Customizing

- **Change category calorie targets or add/remove categories**: edit the
  `CATEGORIES` array in `database.js`.
- **Change macro goals**: edit `PROTEIN_TARGET_G` / `CARBS_TARGET_G` /
  `FAT_TARGET_G` in `database.js`.
- **Add/edit products**: edit `seed-data.js` — it only seeds once (when
  `products` is empty), so delete `diet.db` and restart to reload from
  scratch.
- **Style/colors**: the app automatically follows Telegram's light/dark
  theme via CSS variables at the top of `public/index.html` — edit the
  `:root { ... }` block to tweak fallback colors.

## Common issues

- **"BOT_TOKEN is not set" on startup** — you still have the placeholder
  value in `.env`; paste your real token from BotFather.
- **Button does nothing / "app not configured"** — `WEBAPP_URL` in `.env`
  is missing or still a placeholder. It must be a real `https://` URL
  Telegram can reach (see Step 4).
- **"Open this from the Telegram bot for it to work correctly"** toast —
  you opened `index.html` directly in a normal browser instead of through
  the Telegram button. That's expected; Telegram injects the auth data the
  app needs.
