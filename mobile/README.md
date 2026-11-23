# Anagram Jam for iPhone

The iOS app is a [Capacitor](https://capacitorjs.com) shell: a full-screen web view that loads the live site,
https://www.anagramjam.com (`server.url` in `capacitor.config.json`). The web files aren't copied into the app. The
pages and the server are deployed together and version-checked against each other (PAGE_VERSION), so the app always
shows whatever is live, and a site deploy updates the app without an App Store release.

## What's where

- `capacitor.config.json`: the app's settings (site address, colours, status bar).
- `www/index.html`: the only page inside the app. Shown when a page of the site can't load. It tries the site every few
  seconds and goes back by itself, to the page that failed (a room, say) rather than home.
- `ios/`: the Xcode project. `ios/App/App/AppViewController.swift` decides when the offline page shows: when a page
  fails to load, when the server answers with a 5xx error (a broken deploy would otherwise leave the player on an
  error page with no reload button), or when nothing has shown 10 seconds after launch. Not when a load was only
  replaced by another, like a button tapped twice.
- `ios/App/App/LaunchView.swift`: the loading screen (see "The loading screen" below).
- On the site: `shared/app.js` (on every page: tells the app the page is ready, so the loading screen can go), haptics in
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
there. A reminder that arrives while the app is open shows nothing, so it can't interrupt a round (the box's **Send a test**
says so when one gets there, as it would otherwise look like it hadn't).

The site looks for the plugin (`isPluginAvailable('PushNotifications')`), not the build number, so older builds simply
don't offer reminders.

The project now has the push entitlement, so archiving fails until Push Notifications is on for the App ID and the
"Anagram Jam App Store" profile has been made again. Both are in SETUP-PUSH.md at the project root, with the rest of the
setup. Simulators can't get an address from Apple without that either, so turning reminders on needs a real iPhone
(TestFlight is fine: it uses the same APNs service as the App Store).

Build 5 is version 1.0.1: build 4 was 1.0, and 1.0 went out on the App Store with build 3 (without reminders), so a
build with reminders needed a version number of its own. Nothing else changed between 4 and 5.

## The loading screen

Build 6 opens on a loading screen drawn by the app itself (`LaunchView.swift`), so it's there before anything has come
from the site: letter tiles fall in jumbled and sort themselves into ANAGRAM JAM. It always plays through (about a
second and a half) and then waits, with a little wave along the tiles, until the first page says it's ready
(`Launch.ready()` in `shared/app.js`, through `LaunchPlugin.swift`). On the home page the tiles then glide onto the
page's own title: the app asks the page where its title tiles are (`window.launchTitle`), so the two must keep looking
alike. If the site's tiles change (`.tile` in `shared/theme.css`: size, corners, shadow, font), change `TileView` to
match. Any other first page (a room from a link, the offline page) gets a plain fade.

iOS only allows a still picture for the first moment (`LaunchScreen.storyboard`), which is the game's plain dark
background, so the tiles fall into an empty screen. The SplashScreen plugin is still installed but no longer shows
anything (`launchShowDuration: 0`). The tiles' font is `Rubik-Black.ttf` (Rubik 900, the site's font, under the SIL
Open Font License: `Rubik-OFL.txt`). With Reduce Motion on, the name appears in place and fades to the page.

## Links that open the app

Build 6 opens links to the site in the app (universal links): a room link from a friend goes straight to that room.
Three things make it work, and all three have to agree:

- The site's `/.well-known/apple-app-site-association` (in `index.js` at the project root) names the app
  (`UXXL68D688.com.krishchavan.anagramjam`) and the addresses it takes: rooms, Daily Jam, solo, practice, home and
  `/app`. Not signing in, help or privacy.
- `App.entitlements` names the site (`applinks:www.anagramjam.com`), and the App ID has Associated Domains turned on
  in Apple's developer portal (the "Anagram Jam App Store" profile has to be made again after turning it on).
- `AppViewController.swift` (`open(link:)`) takes the link to its page in the web view.

iPhones fetch that file through Apple's servers when the app is installed or updated, so a change to it can take a day
to reach phones. The room and Daily Jam pages also carry Safari's app banner (`apple-itunes-app` in their `<head>`):
"Open" for someone who has the app, the App Store for someone who doesn't. A link only opens the app when it's tapped
somewhere else (Messages, Notes, another app); typed into Safari, or followed from a page of the site itself, it stays
in Safari, and that banner is the way across.

## Sound

The game's sound is set up by the site (`shared/sfx.js`): the 'ambient' kind, like a game's, so the silent switch
silences it, it stops when the app isn't in front, and the phone shows no media player for it. Build 6 adds
`OtherAudioPlugin.swift`, which tells the page whether the phone is already playing something of its own (a song, a
podcast); then the game's music stays off and only its sound effects play over it. The simulator always says nothing
else is playing, so this part can only be tried on a real iPhone.

## Sharing the app

A link to the App Store shows the listing's first screenshot when it's sent in iMessage, and only a new App Store
version can change that. The home page's **Share Anagram Jam** sends `https://www.anagramjam.com/app` instead, which
shows the site's banner (`share.png` at the project root) and opens the App Store on an iPhone (see `/app` in index.js).
