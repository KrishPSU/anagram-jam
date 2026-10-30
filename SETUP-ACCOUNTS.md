# Setting up accounts, Sign in with Apple and PostHog

Players can sign in with Google or Apple so one score follows them across their devices, and PostHog records how the
site is used. The code for all of it deploys with the site; this is the part that happens in other people's
dashboards, in order, with the exact values to type. Everything here is done once, except the Apple client secret,
which Apple only accepts for 6 months ([see the end](#twice-a-year-a-new-apple-secret)).

The website gets all of this with the site deploy. The iPhone app needs one new build before anyone can sign in inside
it: its web view hands other sites to Safari, where a sign-in can't finish, so mobile/capacitor.config.json now lets
`*.supabase.co` and `appleid.apple.com` through and calls itself build 2 (`AnagramJamApp/2`). Until that build is on
people's phones, the app's account box sends them to the website to sign in (see mobile/README.md, "Signing in").

## What you need

- The Supabase project the site already uses (`SUPABASE_URL` in Vercel's settings). Its **project ref** is the part of
  that address before `.supabase.co` (also Supabase -> Project Settings -> General -> Project ID). It's written
  `<project-ref>` below, in a dozen places - fill it in as you go.
- A Google account, for Google Cloud. Any; it only owns the OAuth client.
- The Apple Developer account the iPhone app is signed with: team WEREWARDS LLC, Team ID `UXXL68D688`.
- The Vercel project that deploys the live repo (KrishSChavan/anagram-jam), and the PostHog account (US cloud).

## 1. Supabase: where players come back to

Supabase -> **Authentication** -> **URL Configuration**:

- **Site URL**: `https://www.anagramjam.com`
- **Redirect URLs**: add `https://www.anagramjam.com/account/callback` and `http://localhost:3000/account/callback`

Save. Supabase only sends a player back to an address on this list, and the pages ask for `/account/callback` (see
shared/account.js). The localhost one is for working on sign-in locally (below); it does no harm on the live project.

## 2. Google

In the [Google Cloud console](https://console.cloud.google.com), pick a project with the chooser at the top (**New
project** if there isn't one; call it Anagram Jam). Then, from the left menu, **APIs & Services** - Google is renaming
this part **Google Auth Platform**, and the pages are the same under either name:

1. **OAuth consent screen** (Google Auth Platform -> Branding). App name `Anagram Jam`, user support email: yours. No
   logo (a logo starts a brand review that takes days; the name shows without one). App domain: home page
   `https://www.anagramjam.com`, privacy policy `https://www.anagramjam.com/privacy`, terms of service: leave empty.
   **Authorized domains**: `anagramjam.com` and `<project-ref>.supabase.co` - the sign-in bounces through that host, and
   Google refuses to send anyone to a domain that isn't listed. It has to be the project's own host: `supabase.co` on
   its own is a shared suffix and Google turns it down ("must be a top private domain"). Developer contact: your email.
   Save.
2. **Audience**: user type **External**, then **Publish app** (from Testing to In production). With only the basic
   scopes (email, profile and openid - the defaults, which is all Supabase asks for) Testing already lets any Google
   account sign in, with no warning and nothing expiring, so publishing changes nothing for players - do it anyway, so
   the project isn't left marked Testing. It needs no review.
3. **Credentials** (Google Auth Platform -> Clients) -> **Create credentials** -> **OAuth client ID**. Application
   type **Web application**, name `Anagram Jam web`.
   - Authorized JavaScript origins: `https://www.anagramjam.com` and `https://<project-ref>.supabase.co`
   - Authorized redirect URIs: `https://<project-ref>.supabase.co/auth/v1/callback`

   Create, and copy the **Client ID** (ends in `.apps.googleusercontent.com`) and the **Client secret**. The secret is
   shown here only, so copy it now; if it's lost, the client's page can make a new one.
4. In Supabase: **Authentication** -> **Providers** (newer dashboards: Sign In / Providers) -> **Google**. Turn on
   "Enable Sign in with Google", paste the Client ID into **Client IDs** and the secret into **Client Secret**, leave
   "Skip nonce check" off, Save. The **Callback URL** shown on that panel must be exactly the redirect URI you gave
   Google.

What players see: Google's account chooser, headed "to continue to `<project-ref>.supabase.co`". That's how every
Supabase sign-in looks. Making it say anagramjam.com needs Supabase's custom-domain add-on (paid) and a change to
`SUPABASE_URL`; not worth it for now.

## 3. Apple

Sign in with Apple needs three things from [developer.apple.com/account](https://developer.apple.com/account)
(Certificates, Identifiers & Profiles) and a client secret you make yourself with the script in this repo.

1. **The App ID.** Identifiers -> filter to **App IDs** -> `com.krishchavan.anagramjam` (the iPhone app's). Under
   Capabilities tick **Sign in with Apple** (leave "Enable as a primary App ID"), Save, and confirm the warning about
   changing capabilities. Nothing changes in Xcode: the app signs in through the website, so it doesn't need the
   entitlement; the capability only has to be on the App ID for the next step to attach to it. (Xcode's automatic
   signing makes a fresh provisioning profile the next time you build.)
2. **A Services ID** - the "client" for sign-ins from a website. Identifiers -> **+** -> **Services IDs** -> Continue.
   Description `Anagram Jam website`, identifier `com.krishchavan.anagramjam.web`. Continue, Register. Then open it
   (filter the list to Services IDs), tick **Sign in with Apple**, **Configure**:
   - Primary App ID: `com.krishchavan.anagramjam`
   - Domains and Subdomains: `www.anagramjam.com, <project-ref>.supabase.co`
   - Return URLs: `https://<project-ref>.supabase.co/auth/v1/callback`

   Next, Done, Continue, Save.
3. **A key.** Keys -> **+**. Key name `Anagram Jam sign-in`, tick **Sign in with Apple**, Configure -> Primary App ID
   `com.krishchavan.anagramjam`, Save, Continue, Register. **Download** it: `AuthKey_XXXXXXXXXX.p8`, where
   XXXXXXXXXX is the **Key ID** shown on the same page. Apple lets you download it exactly once, so put it somewhere
   safe straight away (a password manager) and never in this folder: `npm run deploy` commits every new file.
4. **The client secret.** Apple doesn't give you one; it's a token you sign with that key, and it expires. From this
   folder:

   ```sh
   node scripts/apple-secret.js --key ~/Downloads/AuthKey_XXXXXXXXXX.p8 --key-id XXXXXXXXXX --team-id UXXL68D688 --client-id com.krishchavan.anagramjam.web
   ```

   It prints the token (one long line in three dot-separated parts) and, above it, the day it stops working. Put
   `| pbcopy` on the end to get the token straight onto the clipboard. (`--key-id` can be left off while the file
   still has Apple's name for it, and the team and client IDs are the defaults, so
   `node scripts/apple-secret.js --key ~/Downloads/AuthKey_XXXXXXXXXX.p8` is enough.)
5. In Supabase: **Authentication** -> **Providers** -> **Apple**. Turn on "Enable Sign in with Apple", **Client IDs**:
   `com.krishchavan.anagramjam.web`, **Secret Key (for OAuth)**: the token. Save. (If the app ever signs in natively
   instead of through the site, its bundle ID goes into Client IDs too - after the Services ID, which has to stay
   first.)
6. **Set a reminder** for a week before the day the script printed. When the secret runs out, Apple sign-ins fail
   (the callback page shows an error from Apple; Google, and everyone already signed in, carry on) until a new one is
   pasted in. See [the end](#twice-a-year-a-new-apple-secret).

Apple's "Sign in with Apple for Email Communication" (registering an email source) is only for sending email to
players who used Hide My Email. The game sends no email, so skip it.

## 4. The database

The tables and functions for accounts are `supabase/migrations/20261029000000_accounts.sql`. Supabase's GitHub
integration applies new files in that folder when the connected repo's main changes, as it did for the three before
it. Run it by hand as well, right before deploying: Supabase -> **SQL Editor** -> New query, paste the whole file,
**Run**. It's written to be safe to run more than once (the integration running it again included), so nothing is lost
by doing both.

Order matters a little: the new server calls the new functions the moment it's live, so run the migration first, then
`npm run deploy`. The old server keeps working in between - the migration leaves the old shapes of `solo_standings` and
`open_daily` in place as wrappers - so there's no gap to hurry through.

To check: Table Editor shows `accounts`, `player_links` and `players` (empty for now), and Database -> Functions
lists `link_account`.

## 5. PostHog

The project is **Default project** on PostHog's US cloud ([us.posthog.com](https://us.posthog.com)), so the host is
`https://us.i.posthog.com` and everything it keeps is in the United States, as the privacy policy says.

1. The key: Settings -> Project -> **Project API key**. It's `phc_xErDsaesGf6qSm9o8xPyFgtwKjBvGZk3Hsp9kqMwrvvo`. It's
   a public key (every page gets it from /site-config.json, so anyone can read it), which is why it can be written
   here. The server's environment variable (below) is how the pages learn it.
2. Settings -> Project -> **Session replay**: check that **Record user sessions** is on (it already is on this project)
   and that the retention says 30 days. The rest can stay as it is: the pages ask for every input to be masked
   (`maskAllInputs` in shared/analytics.js), and the project masks inputs too. 30 days is the number in the privacy
   policy - don't lengthen it without changing that page.
3. Billing: stay on the free plan and don't add a card unless you mean to pay. Without one, PostHog stops collecting
   for the month once the free allowance is used up, and nothing is ever charged.
4. Nothing to do for the admin page: PostHog isn't on it, on purpose - its scripts aren't on those pages, and the
   admin pages' Content-Security-Policy wouldn't allow them anyway.

Where to look: **Activity** (every event as it arrives, with the person's id - an account id for signed-in players,
a random one for everyone else; names and emails are never sent), **Session replay**, **Web analytics**.

## 6. Vercel

[vercel.com](https://vercel.com) -> the project -> **Settings** -> **Environment Variables**. Add, for all
environments:

| Name | Value |
| --- | --- |
| `POSTHOG_KEY` | `phc_xErDsaesGf6qSm9o8xPyFgtwKjBvGZk3Hsp9kqMwrvvo` |
| `POSTHOG_HOST` | `https://us.i.posthog.com` (optional: that's the default) |
| `AUTH_PROVIDERS` | optional: `google,apple` is the default. Button order; `apple` alone hides Google. |

`AUTH_PROVIDERS` set to `apple` is handy while Google's side isn't done yet.

Already there from before, and needed: `SUPABASE_URL` and `SUPABASE_SECRET_KEY` (accounts are only offered when these
are set - without Supabase the account box says signing in isn't set up on this server), `REDIS_URL`, `ADMIN_PASSWORD`,
`ADMIN_SESSION_SECRET`. A new or changed variable only reaches the next deployment, so deploy (or Deployments ->
Redeploy) after adding them.

## 7. Deploy and test

`npm run deploy` (it commits what's changed, pushes to the live repo and waits for Vercel). Then, on the live site:

1. **Google, on a laptop.** Home page -> 👤 -> Continue with Google. Google's chooser, then back on the home page with
   the toast "Signed in as <your Google name>. Your scores on this device are now one with your account." The name
   field is locked to that name, the 👤 button has a green dot, and https://www.anagramjam.com/site-config.json shows
   `"enabled": true` with both providers.
2. **The merge.** Play a solo run on the laptop. In a private window (a fresh "device" as far as the game knows), play
   a run with a different score, then sign in with the same Google account there. The leaderboard (⏱ Solo) has one row
   for you - the higher score, under your Google name, with a ✓ - and the private window's old nickname is gone.
3. **Daily Jam.** Finish a word, then open the leaderboard's 📅 Daily tab: you're on it, with a ✓.
4. **Apple, on the iPhone.** In Safari on the phone, 👤 offers both; sign in with Apple to see that it works on the
   web. In the app as it is today (build 1), 👤 says to sign in on the website for now. Once build 2 (see the top of
   this file) is on the phone, 👤 in the app offers Continue with Apple only, says Google works on the website, and
   Apple's sheet appears inside the app; back in the app you're signed in.
5. **The admin page.** Live tab: "On the site" counts you and the People section says what you're doing. Leaderboard
   tab: a Google chip on your row. Daily Jam tab: you're under Players.
6. **PostHog.** Activity shows `$pageview`s within a minute. Session replay shows your session with the name field
   masked. On /privacy, tap "Turn off analytics on this device": it changes to "Analytics are off on this device", and
   nothing more arrives from that browser.
7. **The exits.** On one device, "Sign out on this device": the page reloads signed out, and your score is still on the
   leaderboard under the account. Then, with a throwaway account, "Delete account": its row goes from the leaderboard,
   and the user from Supabase -> Authentication -> Users.

## Local development

Accounts need a real Supabase project. In memory mode (no `.env`) the server runs as before and the account box says
signing in isn't set up on this server, which is fine for working on anything else. To work on sign-in itself, put
the live project's address and secret key in `.env` (`SUPABASE_URL` and `SUPABASE_SECRET_KEY`, from Vercel's
settings) and `npm start`. That is the live database, so sign in with a test account, not your own.

- The redirect URL for local work is already on Supabase's list from step 1: `http://localhost:3000/account/callback`.
  Open the site as `http://localhost:3000`, not `127.0.0.1` or a LAN address: the list is exact, and the sign-in needs
  `crypto.subtle`, which browsers only give to secure pages - `localhost` counts, `http://192.168.x.x` doesn't (the
  account box says "Needs a secure connection").
- Google and Apple don't need to know about localhost. The browser goes from them to Supabase, and from Supabase to
  localhost; only Supabase's list has to have it.
- `PORT=3977 npm start` runs on another port; then the redirect URL on Supabase's list has to say that port too.
- Leave `POSTHOG_KEY` out of `.env` unless you're working on analytics, or local sessions land in the real project.

## Twice a year: a new Apple secret

The secret from step 4 of the Apple section is good for 180 days from the day it was made (the script prints the
date). Before then:

1. Make a new token with the same key:

   ```sh
   node scripts/apple-secret.js --key AuthKey_XXXXXXXXXX.p8 --key-id XXXXXXXXXX --team-id UXXL68D688 --client-id com.krishchavan.anagramjam.web
   ```

2. Supabase -> Authentication -> Providers -> Apple -> replace **Secret Key (for OAuth)** with the new token, Save.
3. Sign in with Apple once, in Safari, to see it work. Set the next reminder.

Nothing else changes: the key, the Services ID and the App ID are good indefinitely. If the .p8 is lost, revoke the
key under Keys, make a new one (step 3 of the Apple section - it gets a new Key ID), and do the two steps above with
that. If the secret has already run out, players tapping Continue with Apple get an error page from the callback
until the new one is in; nobody already signed in notices.

## What's where

- `account.js`: the server side - who a device is, linking it to an account (and merging the device's scores in),
  renaming, unlinking, deleting, and who's on the site. The sign-in's code exchange with Supabase happens here, so
  the pages never hold Supabase's tokens.
- `shared/account.js`: the account box on the pages and the sign-in itself (straight to Supabase's
  `/auth/v1/authorize`); `account/callback.html` is where Supabase sends players back to.
- `shared/presence.js`: the heartbeat that puts players on the admin page's Live tab. `shared/analytics.js`: PostHog,
  and the opt-out button on /privacy. `shared/config.js`: fetches `/site-config.json` (the providers and the PostHog
  key, from the environment variables above).
- `supabase/migrations/20261029000000_accounts.sql`: the tables and functions, the merge (`link_account`) included.
- `scripts/apple-secret.js`: the Apple client secret.
- `info/privacy.html`: says in plain words what all of this stores and for how long. Change it when any of this
  changes, and the date at its top.

## What to tell players

The admin page's banner, or its message to everyone, is enough. Something like:

> New: sign in with Google or Apple (👤 on the home page) and your scores follow you between your phone and laptop -
> your best from each device is merged into one. Daily Jam has a leaderboard now too. The privacy policy
> (anagramjam.com/privacy) is updated: it explains the new analytics and how to turn them off on your device.

In the iPhone app the box only offers Apple (from build 2 - the build before it sends people to the website), because
Google doesn't allow sign-ins from inside apps; the help page (/support) explains that and everything else about
accounts, so point people there.

## Checklist

- [ ] Supabase: Site URL `https://www.anagramjam.com`; Redirect URLs `https://www.anagramjam.com/account/callback`
  and `http://localhost:3000/account/callback`
- [ ] Google Cloud: consent screen filled in, External, **published**; authorized domains `anagramjam.com` and
  `<project-ref>.supabase.co`
- [ ] Google Cloud: Web application client with origins `https://www.anagramjam.com` and
  `https://<project-ref>.supabase.co`, redirect URI `https://<project-ref>.supabase.co/auth/v1/callback`
- [ ] Supabase: Google provider on, with the Client ID and secret
- [ ] Apple: Sign in with Apple ticked on App ID `com.krishchavan.anagramjam`
- [ ] Apple: Services ID `com.krishchavan.anagramjam.web`, configured with both domains and the return URL
- [ ] Apple: a key with Sign in with Apple; the `.p8` in a password manager (not in this folder); its Key ID noted
- [ ] `node scripts/apple-secret.js ...` run; Supabase: Apple provider on, Client IDs `com.krishchavan.anagramjam.web`,
  the token as the Secret Key
- [ ] Calendar reminder a week before the date the script printed (and every 6 months after)
- [ ] Supabase: `20261029000000_accounts.sql` run in the SQL Editor
- [ ] PostHog: Record user sessions on; no card added
- [ ] Vercel: `POSTHOG_KEY` (and `POSTHOG_HOST` or `AUTH_PROVIDERS` if wanted)
- [ ] `npm run deploy`, then the seven tests above
- [ ] Players told; /privacy and /support read through once more
