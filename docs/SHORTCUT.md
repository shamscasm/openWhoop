# WhoopPullWeight Shortcut — Install Walkthrough

A 30-second Apple Shortcut that reads your latest Body Mass from HealthKit
and hands it back to the whoof PWA via `x-callback-url`. This is the
"on-demand" weight sync path (the always-on path uses Health Auto Export;
see the README's *Sync weight from Apple Health* section).

## What it does

The PWA's **Pull from iPhone** button does:

```
window.location = "shortcuts://x-callback-url/run-shortcut?name=WhoopPullWeight&x-success=<callback>"
```

The Shortcut you install:

1. Reads the most recent Body Mass sample from HealthKit.
2. Builds a URL = `<callback>` with `?weight_from_shortcut=<value>` appended.
3. Opens that URL → which pops your whoof tab back into focus with the
   weight in the query string. The PWA parses it, writes
   `profile.weight_kg` in IndexedDB, then strips the query param.

## Build it (iPhone, ~30 seconds)

Open the **Shortcuts** app and tap the `+` in the top-right.

### Step 1 — Find Health Sample

- Action: **Find Health Samples**
- Sample type: **Body Mass**
- Sort by: **End Date**
- Order: **Latest First**
- Limit: **1**

### Step 2 — Get the value

- Action: **Get Details of Health Samples**
- Get: **Quantity** (just the numeric kg, no units)

### Step 3 — Build the return URL

- Action: **URL**
- Tap the URL field, then tap **Shortcut Input** (this is the `x-success`
  URL whoof passed in).
- Append the literal text `?weight_from_shortcut=` and then the magic
  variable from Step 2.
- The composed URL looks like:
  `<<Shortcut Input>>?weight_from_shortcut=<<Quantity>>`

### Step 4 — Open the URL

- Action: **Open URLs**
- URL: the magic variable from Step 3.

### Step 5 — Name it

Tap the title bar, name it exactly **WhoopPullWeight** (case-sensitive —
the PWA looks for this name).

### Step 6 — Test it

In the whoof panel tap **Pull from iPhone**. Safari/Bluefy → Shortcuts
app opens briefly → bounces back → weight populates.

## Troubleshooting

**"Nothing happens when I tap Pull from iPhone"** — you're on desktop or in
a browser that doesn't honor the `shortcuts://` URL scheme. Use Safari or
Bluefy on iPhone.

**"Shortcut opens, but I land in Safari, not Bluefy"** — `x-success`
opens in the system default browser. If you start in Bluefy, the bounce
likely lands in Safari unless Bluefy is your default. You can either:
- Set Bluefy as default in iOS Settings → Apps → Default Browser App, or
- Use Safari as your everyday browser for the PWA.

**"HealthKit access denied"** — first time the Shortcut runs, iOS prompts
for Health permissions for the Shortcuts app. Settings → Privacy & Security
→ Health → Shortcuts → enable **Body Mass (Read)**.

**Wrong units (lbs)** — the Shortcut returns the value in whatever unit
HealthKit stores it in. If you log weight in lbs, the PWA stores the
lbs value as `weight_kg`. Two fixes: change your Health.app units to kg
under Health → Browse → Body Measurements → Weight → Unit, OR add a
Calculate step in the Shortcut: `Quantity × 0.45359237` before the URL.

## Why not skip the Shortcut entirely?

We could open a URL like `health://...` to read HealthKit directly. We
can't — there's no public URL scheme into HealthKit. The Shortcut is the
sanctioned third-party bridge.

If you want zero-tap, set up Health Auto Export's REST API automation
(README → Sync weight from Apple Health). The Shortcut is for the "I just
weighed myself, show me the new number right now" case.
