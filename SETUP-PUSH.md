# Setting up reminders

Players can ask for a push notification reminding them to play the Daily Jam, or Solo every few days (see `push.js`). The
code deploys with the site and stays dormant until it has its keys: the pages don't offer reminders, and nothing is sent.
This is the part that happens in other people's dashboards, in order. Everything here is done once.

You can stop at the end of step 3: browsers, and the game added to a home screen, get reminders from there. Steps 4 to 6
are for the iPhone app, and step 6 needs a new App Store build.

## 1. Keys for the server

On your Mac, in this folder:

```sh
npx web-push generate-vapid-keys   # the pair browsers' push services check. Don't change it later: every browser's
                                   # subscription is tied to it, so they'd all have to turn reminders on again.
openssl rand -hex 32               # for PUSH_SEND_SECRET, below
```

In Vercel, the project that deploys KrishSChavan/anagram-jam -> Settings -> Environment Variables, for Production:

| Name | Value |
| --- | --- |
| `VAPID_PUBLIC_KEY` | Public Key from the first command |
| `VAPID_PRIVATE_KEY` | Private Key from the first command |
| `PUSH_SEND_SECRET` | the second command's output |

## 2. The database

Supabase -> SQL Editor, for the anagram-jam project:

1. Paste all of `supabase/migrations/20261104000000_push_reminders.sql` and run it. Check it's needed first: this project's
   migration history is empty, so the GitHub integration doesn't seem to have been applying these, and it's safe to run
   twice either way. It adds the `push_devices` table and turns on `pg_cron` and `pg_net`, and sets up the hourly job.
2. Then run this, with the same value as `PUSH_SEND_SECRET`:

   ```sql
   select vault.create_secret('<PUSH_SEND_SECRET>', 'push_send_secret');
   ```

## 3. Deploy, and check it

Vercel only gives new deployments new variables, so deploy after step 1 (`npm run deploy`, or Redeploy in Vercel).

- https://www.anagramjam.com/site-config.json should show `"push":{"app":false,"webKey":"B..."}`.
- The home page shows **🔔 Get a reminder to play** on a computer or Android. Turn it on, pick the next hour, and wait.
- After the next hour, in the SQL Editor:

  ```sql
  select status_code, content, created from net._http_response order by created desc limit 5;
  ```

  A `200` with `{"due":0,"sent":0,...}` means the job and the secret are right. `403` means the secret in Vault doesn't
  match `PUSH_SEND_SECRET`.

iPhones and iPads in a browser only get them once the game has been added to the home screen (Apple's rule).

## 4. Apple: turn on push for the app

In [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources), team WEREWARDS LLC:

1. **Identifiers** -> Anagram Jam (`com.krishchavan.anagramjam`) -> tick **Push Notifications** -> Save.
2. **Keys** -> + -> name it "Anagram Jam Push", tick **Apple Push Notifications service (APNs)** -> Continue -> Register.
   Download the `.p8` file. **Apple only lets you download it once.** Note the **Key ID** on that page.
3. **Profiles** -> Anagram Jam App Store -> Edit -> Save -> Download, then open the file to install it. Changing the App ID
   made the old one out of date, and archiving fails until this is done.

## 5. Vercel: Apple's key

Add these the same way as in step 1, then deploy again:

| Name | Value |
| --- | --- |
| `APNS_KEY` | everything in the `.p8` file, including the BEGIN and END lines |
| `APNS_KEY_ID` | the Key ID from step 4 |
| `APNS_TEAM_ID` | `UXXL68D688` |

`site-config.json` should now show `"app":true`. Old builds don't change: they don't have the plugin, so they don't offer
reminders.

## 6. Release the app

Build 4 is ready in `mobile/` (`AnagramJamApp/4`, build number 4). See "Releasing" in `mobile/README.md`.

- Once a version has been released, new builds need a new version number. If 1.0 is live by then, raise it to 1.0.1 or 1.1
  in Xcode (target App -> General) before archiving.
- App Privacy: the push address is a device identifier. Device ID is already declared for Analytics, so add **App
  Functionality** as a purpose for it.
- Try it on TestFlight first, on a real iPhone: turn reminders on at the next hour and wait. Simulators can't get an
  address from Apple. Only raise `minAppBuild` once it's on the App Store.

## If something goes wrong

- To stop all reminders at once, in the SQL Editor: `select cron.unschedule('send-push-reminders');`
  (running the migration again puts it back).
- To see who has reminders on: `select kind, time_zone, hour, daily, solo, last_day, seen_at from push_devices;`
- A run's result is logged in Vercel: `Reminders: 12 due, 11 sent, 1 gone, 0 failed`. **Gone** is normal: that address no
  longer works (the app was deleted), and it's been removed. **Failed** means the service turned it down, and the reason
  is logged just above it.
