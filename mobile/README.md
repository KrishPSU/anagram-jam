# Anagram Jam for iPhone

The iOS app is a [Capacitor](https://capacitorjs.com) shell: a full-screen web view that loads the live site,
https://www.anagramjam.com (`server.url` in `capacitor.config.json`). The web files aren't copied into the app. The
pages and the server are deployed together and version-checked against each other (PAGE_VERSION), so the app always
shows whatever is live, and a site deploy updates the app without an App Store release.

## What's where

- `capacitor.config.json`: the app's settings (site address, colours, status bar, launch screen timing).
- `www/index.html`: the only page inside the app. Shown when a page of the site can't load. It tries the site every few
  seconds and goes back by itself, to the page that failed (a room, say) rather than home.
- `ios/`: the Xcode project. `ios/App/App/AppViewController.swift` decides when the offline page shows: when a page
  fails to load, when the server answers with a 5xx error (a broken deploy would otherwise leave the player on an
  error page with no reload button), or when nothing has shown 10 seconds after launch. Not when a load was only
  replaced by another, like a button tapped twice.
- On the site: `shared/app.js` (on every page: hides the launch screen once the page is ready), haptics in
  `shared/sfx.js` (`buzz`), and `home/install.js` hides its "add to home screen" hint in the app. Each one checks
  for `window.Capacitor`, so they do nothing in a browser.

- `ios/App/App/AppDelegate.swift` and `App.entitlements`: push notifications (see "Reminders" below).

## Building

```sh
cd mobile
npm install
npx cap sync ios   # after a fresh clone and after any change to capacitor.config.json, www/ or the plugins
npx cap open ios   # opens ios/App/App.xcodeproj in Xcode
```

In Xcode, pick a simulator or your iPhone and press Run. Signing is automatic with the WEREWARDS LLC team
(UXXL68D688); the bundle ID is `com.krishchavan.anagramjam`.

## Releasing

Site changes (including `shared/app.js` and `shared/sfx.js`) go out with `npm run deploy` like any other change. A new
App Store build is only needed for changes in this folder: settings, plugins, the icon, the launch screen, the offline
page, or Swift code. For those:

1. Deploy the site first if it has app-related changes, so the build App Review sees has them.
2. Raise the version (and build number) in Xcode: target App > General.
3. If the site needs to know about the new build, bump `appendUserAgent` (`AnagramJamApp/1` -> `AnagramJamApp/2`).
4. `npx cap sync ios`, every time. Xcode packs the copies of the settings and the offline page in `ios/App/App`, which
   git ignores, so a stale copy wouldn't show up anywhere.
5. Product > Archive, then Distribute App > App Store Connect.

Old app versions stay on people's phones, so site code must check that a plugin exists before using it
(`Capacitor.isPluginAvailable('Haptics')`, as sfx.js does).

## Signing in

Build 2 lets the sign-in pages through: `allowNavigation` in capacitor.config.json names `*.supabase.co` and
`appleid.apple.com`, which the web view would otherwise hand to Safari, where a sign-in can't finish (the verifier is in
the app's own storage). The site tells builds apart by the user agent (`AnagramJamApp/2`): build 1 is sent to the
website to sign in, build 2 gets Continue with Apple, as a plain form. Google never signs anyone in inside an app's web
view, so it stays off in build 2 (see shared/account.js).

Build 3 adds the AuthSession plugin (`ios/App/App/AuthSessionPlugin.swift`, registered in AppViewController): Continue
with Google and Continue with Apple open iOS's sign-in sheet (ASWebAuthenticationSession), where Google is allowed and
Apple shows its own sheet. The sign-in comes back to `/account/callback?via=app` inside the sheet; that page goes to
`com.krishchavan.anagramjam://account/callback`, which closes the sheet and hands the address to the page, and the page
opens the callback again in the web view, where the verifier is. Supabase accepts any address on the site's own host,
so `?via=app` needs no entry in its list. The site looks for the plugin (`isPluginAvailable('AuthSession')`), not the
build number.

## Reminders

Build 4 adds push notifications, through Capacitor's PushNotifications plugin (`@capacitor/push-notifications`). What to
send and when is the server's (`push.js`) and the box that turns them on is the site's (`shared/reminders.js`), so only
three things are here: the plugin, `App.entitlements` (the push capability), and the two callbacks in `AppDelegate.swift`
that hand iOS's answer to the plugin. A tapped reminder carries the page it's about (`url`), and `shared/app.js` goes
there. A reminder that arrives while the app is open shows nothing, so it can't interrupt a round.

The site looks for the plugin (`isPluginAvailable('PushNotifications')`), not the build number, so older builds simply
don't offer reminders.

The project now has the push entitlement, so archiving fails until Push Notifications is on for the App ID and the
"Anagram Jam App Store" profile has been made again. Both are in SETUP-PUSH.md at the project root, with the rest of the
setup. Simulators can't get an address from Apple without that either, so turning reminders on needs a real iPhone
(TestFlight is fine: it uses the same APNs service as the App Store).
