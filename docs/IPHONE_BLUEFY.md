# whoof on iPhone — **truly free forever, phone-only**

This is the recommended install path for iOS 17.1+, where TrollStore is
blocked and AltStore needs a Mac on the same Wi-Fi every week.

The trick: a third-party iOS browser called **Bluefy** ships its own
Web Bluetooth implementation. iOS Safari has had Web Bluetooth blocked
forever (Apple's choice), but third-party browser apps can build it in,
and Bluefy does.

Result:

- ✅ **Free forever** — Bluefy is a free App Store app, no developer account
- ✅ **No Mac, no Pi, no AltServer, no re-signing** — pure App Store install
- ✅ **Pair the Whoop strap directly from your iPhone** via Bluetooth
- ✅ **Uses the exact dashboard from `/web`** — no native rebuild required
- ✅ **Persistent** — doesn't expire after 7 days

## 30-minute setup, 4 steps

### 1. Install Bluefy on iPhone (1 minute)

Open the App Store on your iPhone and search **"Bluefy — Web BLE
Browser"**. Install it. It's free, no in-app purchases.

> Direct link: <https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055>

### 2. Deploy `/web` to Cloudflare Pages — *one time* (15 minutes)

This gives you a permanent `https://whoof-<you>.pages.dev` URL so
you never need your Mac running again.

#### Sign up (free, no credit card)

1. Go to <https://dash.cloudflare.com/sign-up> and create an account
2. Verify your email

#### Authenticate the CLI once

```bash
cd /Users/helios/claude/whoop
npx wrangler login
```

A browser tab opens — click **Allow** to authorise wrangler against
your Cloudflare account.

#### Deploy

```bash
npm run deploy
```

The first time, wrangler asks:
- **Create new project?** → Yes
- **Project name?** → press Enter to accept `whoof`
- **Production branch?** → press Enter to accept `main`

After 10–20 seconds it prints:

```
✨  Deployment complete! Take a peek over at
    https://getwhoof.pages.dev
```

That's your permanent URL. Bookmark it.

### 3. Open in Bluefy on iPhone (30 seconds)

1. Open **Bluefy** on iPhone
2. Tap the address bar, type your URL: `getwhoof.pages.dev` (or
   whichever name Cloudflare gave you)
3. The full dashboard loads

### 4. Add to Home Screen *from inside Bluefy* (10 seconds)

Tap Bluefy's share icon → **Add to Home Screen** → **Add**.

You now have a `whoof` icon on your Home Screen. Tapping it
opens Bluefy directly to the dashboard with Web Bluetooth working.

When you tap **Connect Whoop**, you'll see iOS's standard Bluetooth
permission prompt the first time, then the strap picker.

---

## Updating the dashboard

Whenever you change the code in `/web`:

```bash
npm run deploy
```

Cloudflare pushes the new build to the CDN in ~20 seconds. Next time
you open the icon on your iPhone, it pulls the fresh version. The
service worker also auto-updates app code on each launch (since the
SW switch in commit `a08658d` made HTML/JS/CSS network-first).

---

## Comparison: free-forever iOS install options

| Option | Cost | Re-sign? | Phone-only? | Bluetooth from phone? | iOS version |
|---|---|---|---|---|---|
| **This guide (Bluefy + Cloudflare)** | $0 | Never | ✅ | ✅ | Any |
| Native via Xcode + free Apple ID | $0 | Every 7 days | ❌ (need Mac) | ✅ | Any |
| AltStore + AltServer auto-resign | $0 | Auto every 7d | ❌ (Mac on same Wi-Fi) | ✅ | Any |
| TrollStore (permanent) | $0 | Never | ✅ | ✅ | ≤ 17.0.x only |
| Apple Developer Program | $99/yr | Yearly | ✅ | ✅ | Any |

---

## Troubleshooting

**"Bluefy can't connect to getwhoof.pages.dev"**
→ Cloudflare's free tier sometimes takes 30–60 seconds to propagate the
first deploy. Wait a minute and refresh.

**Connect Whoop shows the picker but no devices appear**
→ Make sure Bluetooth is on in iOS Settings. Tap your strap to wake it
up. iOS's first BT permission prompt for Bluefy might also be hiding
behind the picker — check Settings → Bluefy → Bluetooth.

**Icon launches Safari instead of Bluefy**
→ You added it to Home Screen from Safari, not Bluefy. Re-add from
inside Bluefy.

**Data resets after a few days**
→ iOS aggressively clears third-party browser storage. Open the
dashboard, go to Trends → **Export CSV** every couple of weeks as a
backup. Import on a fresh install.

**Cloudflare Pages won't deploy — "wrangler not found"**
→ Run `npm install` again from the repo root to install dev
dependencies.

**Want to use a custom domain?**
→ Cloudflare Pages → your project → Custom domains → Set up. Free
even on the free tier. You'll need to own the domain.

---

## Architecture

```
iPhone (no Mac involved after step 2)
└── Bluefy app (free, App Store)
    └── WKWebView + custom Web Bluetooth implementation
        └── https://getwhoof.pages.dev  ← Cloudflare Pages CDN
            └── /web (your dashboard)
                └── navigator.bluetooth.requestDevice(...)
                    └── Bluefy's BLE bridge
                        └── Core Bluetooth → 📶 → Whoop 4.0
```

The Mac is only touched once — for the initial `wrangler login` +
`npm run deploy`. After that, you can throw the Mac away (or just
close the lid forever) and the iPhone runs the whole thing.

## Privacy

- All Whoop strap data lives in **IndexedDB inside Bluefy on your
  phone** — nothing is uploaded to Cloudflare
- Cloudflare Pages only serves the static HTML/CSS/JS files; it never
  sees your biometric data
- No accounts, no analytics, no tracking
