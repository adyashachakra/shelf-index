# Getting Shelf Index live: step by step

No terminal needed. Everything happens in your browser. Allow about 40 minutes the first time.

**Golden rules**

- Never enter a credit card anywhere. If any screen offers an upgrade, a trial or billing, close it.
- Keys go in exactly one place: Vercel's Environment Variables. Never in GitHub, never in chat.
- If something fails, nothing is charged. The worst case is a pause.

You will need the three keys you already saved: Gemini, Tavily, YouTube.

---

## Step 1. Create the free database (Upstash)

The app needs a small database to remember limits, progress and saved reports.

1. Go to **https://console.upstash.com** and sign up. "Continue with GitHub" is the quickest.
   No card is requested. Do not add one later either: on Upstash, adding a card switches the
   database to a paid plan.
2. Open the **Redis** tab and click **+ Create Database**.
3. Name it `shelf-index`. For the region choose a US East option such as **N. Virginia (us-east-1)**.
   Leave every other setting as it is, keep the **Free** plan, and create it.
4. On the database page, find the **REST API** section. Copy two values into a private note:
   - `UPSTASH_REDIS_REST_URL` (starts with `https://` and ends with `.upstash.io`)
   - `UPSTASH_REDIS_REST_TOKEN` (a long string; use the normal token, not the read-only one)

## Step 2. Look up your Gemini limits

1. Open **https://aistudio.google.com/rate-limit** while signed in to the Google account that owns your Gemini key.
2. Find the row for **Gemini 3.8 Flash** (the model this app uses unless told otherwise).
3. Note two numbers: requests per minute (**RPM**) and requests per day (**RPD**).

One audit sends about 18 requests to Gemini. **If the RPD is below about 40, stop here and tell
Claude what the page shows**: a different free model with more daily room can be selected with one setting.

## Step 3. Put the code on GitHub

1. On **github.com**, click **+** (top right) > **New repository**.
   Name: `shelf-index`. Visibility: **Public**. Do not tick any of the "add a file" boxes. Create it.
2. On the next page click the link **uploading an existing file**.
3. On your computer, open the unzipped `shelf-index` folder. Select everything inside it
   **except the `tests` folder**, and drag the selection onto the GitHub page.
   (GitHub accepts 100 files per upload, which is why `tests` goes separately.)
4. Wait for the list to finish. Check that you see `package.json` and names starting with
   `app/`, `components/` and `lib/`. If every name starts with `shelf-index/`, you dragged the
   outer folder: remove the files and drag its contents instead.
5. Scroll down and click **Commit changes**.
6. Optional, any time: **Add file > Upload files**, drag the `tests` folder itself, commit.

On a Mac, two helper files whose names start with a dot (`.gitignore`, `.env.example`) are
hidden and may not come along. That is fine: the site does not need them.

## Step 4. First deployment on Vercel (no keys yet)

Doing the first deployment without keys tests one thing at a time: does the code build?

1. On **vercel.com** click **Add New > Project**.
2. Under "Import Git Repository" find `shelf-index` and click **Import**. If it is not listed,
   use the link to adjust GitHub permissions and allow Vercel to see that repository.
3. Vercel should detect **Next.js** by itself. Change nothing. Click **Deploy**.
4. Wait two or three minutes.
   - **Success:** you get a web address ending in `.vercel.app`. Open it. You should see the
     landing page. (Running an audit will say the site is not set up yet. Correct: no keys.)
   - **Failure:** click the failed deployment, open **Build Logs**, find the first red lines
     (often starting `Type error:` with a file name), copy about 20 lines around them and send
     them to Claude. You will get back the corrected file to replace on GitHub; Vercel
     redeploys by itself after every change on GitHub.

## Step 5. Add your keys

1. In your Vercel project open **Settings > Environment Variables**.
2. Add each row below. Type the name exactly (capitals and underscores). Paste the value with
   no spaces or quotation marks. For the first five, turn on the **Sensitive** option so the
   value can never be read back.

| Name | Value |
|---|---|
| `GEMINI_API_KEY` | your Gemini key |
| `TAVILY_API_KEY` | your Tavily key |
| `YOUTUBE_API_KEY` | your YouTube key |
| `UPSTASH_REDIS_REST_URL` | from Step 1 |
| `UPSTASH_REDIS_REST_TOKEN` | from Step 1 |
| `GEMINI_RPM` | the RPM number from Step 2 |
| `GEMINI_RPD` | the RPD number from Step 2 |

For this testing weekend only, also add these two so you can run more than one audit a day yourself:

| Name | Value |
|---|---|
| `DAILY_SCAN_LIMIT` | `4` |
| `PER_VISITOR_DAILY_LIMIT` | `4` |

3. New variables only apply to a new deployment. Open **Deployments**, click the **...** menu
   on the latest one, choose **Redeploy**, and confirm.
4. Delete the private note with the Upstash values.

## Step 6. Run the setup check

Open `https://YOUR-ADDRESS.vercel.app/api/health`.

You should see `"ok": true`. The page shows only "set" or "missing" and pass or fail. It never
shows a key, so it is safe to copy and send to Claude.

| If you see | It means |
|---|---|
| a key listed as `missing` | The name has a typo, or you have not redeployed since adding it |
| `redis` not ok | The Upstash URL or token is incomplete or swapped |
| `gemini` says the model was not found | Tell Claude which models your AI Studio page lists |
| `gemini` says the key was rejected | The Gemini key was pasted with a mistake |

## Step 7. Run the first real audit

1. On the landing page enter a well-known brand, pick its category and click **Run audit**.
2. Watch the eleven steps. Expect three to six minutes. Waiting messages are normal: the app
   paces itself to your free Gemini limits.
3. This is the first time the code talks to the real services, so a hiccup here would not be
   surprising. If the audit stops, copy the message on the screen. For more detail open
   **Logs** in your Vercel project and copy the lines from that minute (the app never logs a key).

Things that are meant to happen:

- The same brand and category within 7 days opens the saved report instantly.
- A failed audit that used no search credits gives its daily slot back.
- Daily limits reset at midnight Pacific time (3 a.m. in New York).

## Step 8. Check that no key is exposed

1. **GitHub:** use the search box inside your repository and search for the **last eight**
   characters of each key (the first few are the same for everyone's keys). Expect zero results.
2. **The live site:** on the landing page and on a report, right-click > **View Page Source**,
   then search for `AIza` and `tvly-`. Expect zero results.
3. **Vercel:** in Settings > Environment Variables the five keys should be marked Sensitive.

## Before you share the link publicly

- Set `DAILY_SCAN_LIMIT` back to `2` and `PER_VISITOR_DAILY_LIMIT` back to `1` (or delete both), then redeploy.
- Replace the fictional example report with a real audit.
- Open `/api/health` once more.
- Optional: Vercel's terms for the free Hobby plan cover personal, non-commercial use, and
  let Vercel use Hobby content to improve its AI features unless you opt out. Look in your
  Vercel account settings for the data preference if you would rather opt out.

## Changing things later

- **Edit the eight questions per category:** `lib/audit/questions.ts`. Change the date in
  `QUESTION_BANK_VERSION` when you do.
- **Change a limit:** edit the environment variable in Vercel and redeploy.
- **Replace one file:** on GitHub open the file, click the pencil icon, paste the new
  content, and commit. Vercel redeploys by itself.
