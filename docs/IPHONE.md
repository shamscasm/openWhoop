# Installing whoof on iPhone (no App Store, no developer account)

whoof is a Progressive Web App (PWA). With iOS Safari's **Add to Home
Screen** feature, it installs as a real-feeling app — your own icon on the
Home Screen, opens fullscreen, runs without a browser chrome — and **does not
require an Apple Developer account or the App Store**.

It works exactly like the official WHOOP app's home screen tile, but it's
yours, free, and your data never leaves your phone.

---

## Quick install (2 minutes)

### 1. Make the dashboard reachable from your iPhone

The dashboard is served from your Mac. The iPhone needs to be able to reach
it. Three options, easiest first:

#### A. Same Wi-Fi (recommended for home use)

```bash
# On your Mac, from the repo root:
./run.sh dash --host 0.0.0.0 --port 8765
```

The `--host 0.0.0.0` is the magic bit — it makes the server listen on every
network interface, not just localhost. Find your Mac's LAN IP:

```bash
ipconfig getifaddr en0   # most common (Wi-Fi)
# or
ipconfig getifaddr en1   # if you're on Ethernet
```

You'll get something like `192.168.1.42`. From the iPhone's Safari, open:

```
http://192.168.1.42:8765
```

#### B. ngrok tunnel (works from anywhere, even on cellular)

```bash
brew install ngrok    # one-time
ngrok http 8765
```

ngrok prints an `https://…ngrok-free.app` URL. Open that in iPhone Safari.

> ⚠️ ngrok free tier shows a warning page once per session. Click "Visit Site"
> to dismiss it. For production-grade access, use a static domain.

#### C. Cloudflare Tunnel (free, with your own domain)

```bash
brew install cloudflared
cloudflared tunnel --url http://localhost:8765
```

Same idea, prettier URL. See <https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/>.

### 2. Open in Safari

It **must** be Safari — Chrome and Firefox on iOS can't install PWAs.

### 3. Tap **Share → Add to Home Screen**

1. Tap the **Share** icon at the bottom of Safari (square with arrow up)
2. Scroll down → **Add to Home Screen**
3. Confirm the name (defaults to "whoof") → tap **Add**

You'll see the whoof icon appear on your Home Screen.

### 4. Launch from the Home Screen

Tap the icon and the app opens fullscreen, with no Safari address bar,
respects the notch / Dynamic Island, and lives in its own task switcher
card — just like an App Store app.

---

## What you get

| Feature | Installed PWA | Mobile Safari tab |
|---|---|---|
| Own app icon on Home Screen | ✅ | ❌ |
| Fullscreen (no address bar) | ✅ | ❌ |
| Status bar themed dark | ✅ | ❌ |
| Splash screen on launch | ✅ | ❌ |
| Own task-switcher card | ✅ | ❌ (lives inside Safari) |
| Works offline (cached) | ✅ | ✅ (after first load) |
| Web Bluetooth to read Whoop | ❌* | ❌* |
| Push notifications | ✅** | ✅** |

\* iOS Safari doesn't expose Web Bluetooth at all — Apple's restriction.
The strap can only be paired through a Mac/Chromebook/Android. Once paired
and synced, all the metrics, charts, and insights work fine on the iPhone PWA.

\** Push notifications require iOS 16.4+ and only fire while the PWA is
installed to the Home Screen — not from a Safari tab.

---

## Recommended workflow

1. **Pair + sync the Whoop strap on a Mac** (Chrome / Edge / Arc — anything
   with Web Bluetooth). The strap dumps its history into your browser's
   IndexedDB.
2. **Export to JSON** via the sidebar's `JSON` button.
3. **On iPhone**, open the installed PWA and use the same `Import` button
   to load the JSON.
4. From then on, view all your metrics on the phone. Re-sync from the Mac
   whenever you want fresh data (or set up a recurring export).

A future version can do this sync via a cloud bucket you control (e.g.
Backblaze B2 + signed URLs); for now JSON export/import keeps it simple
and 100% local.

---

## Updating the app

PWAs auto-update — when you change the code on your Mac, the next time
you open the installed app on your iPhone (with network reachable), the
service worker fetches the new HTML/JS/CSS and uses it. There's no App
Store review, no version bump, no waiting.

If you ever want to force a clean install:

1. Long-press the icon on the Home Screen → **Remove App**
2. Re-open the URL in Safari and **Add to Home Screen** again

---

## Troubleshooting

**"This page is not responding"** on first launch
→ The dashboard needs to fetch CSS/JS from your Mac. Confirm the Mac is on
   the same Wi-Fi and the server is running. The PWA caches everything on
   first successful load, so subsequent launches work offline.

**Icon looks blurry or wrong**
→ Long-press → Remove App → re-add. iOS aggressively caches Home Screen
   icons.

**App opens in Safari instead of fullscreen**
→ Make sure you launched from the Home Screen icon, not a bookmark or
   shared URL. Bookmarks always open in Safari.

**Bluetooth icon dimmed**
→ Expected. iOS Safari has no Web Bluetooth. Pair on a desktop browser,
   then import the JSON on the phone.

**My data disappeared**
→ iOS clears website storage (IndexedDB) for sites that haven't been
   visited in 7 days. Installing the PWA to the Home Screen *should*
   exempt it from that policy, but as a safety net, export to JSON
   periodically and store it somewhere durable.
