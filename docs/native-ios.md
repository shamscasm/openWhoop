# whoof native iOS (Capacitor) — overnight background BLE

The web PWA can only talk to a strap while the tab is foregrounded. **True
overnight capture needs a native shell** so iOS keeps the Bluetooth session
alive in the background. This is a thin Capacitor wrapper around the exact same
`web/` app — no second codebase. `web/js/ble/capacitor-bridge.js` already
synthesises `navigator.bluetooth` on top of the native BLE plugin, so all the
existing BLE/metric code runs unchanged inside the shell.

> A **free** Apple developer account works for running on *your own* device.
> Caveat: free-provisioning certificates expire after **7 days**, so the app
> stops launching until you re-build from Xcode (Product ▸ Run). No App Store
> distribution without a paid account. Fine for personal use.

## One-time setup

CocoaPods + Xcode are required (Xcode is on this Mac; install CocoaPods with
`brew install cocoapods` if `pod` is missing).

```bash
npm install                      # pulls @capacitor/* + @capacitor-community/bluetooth-le
rm -rf ios                       # the checked-in ios/App stub is incomplete — regenerate cleanly
npx cap add ios                  # generates ios/App.xcodeproj + Podfile + installs pods
npm run cap:sync                 # copies web/ into the native project (re-run after any web change)
npm run cap:open                 # opens the project in Xcode
```

## Background BLE — the part that makes overnight work

Capacitor won't add background entitlements for you. In Xcode:

1. **Signing & Capabilities** → select your free Apple ID team → set a unique
   bundle id (e.g. `dev.<you>.whoof`). Then **+ Capability ▸ Background Modes**
   and tick **Uses Bluetooth LE accessories** (this is what survives free
   provisioning; it writes `UIBackgroundModes` for you).

2. Confirm `ios/App/App/Info.plist` contains:

   ```xml
   <key>UIBackgroundModes</key>
   <array>
     <string>bluetooth-central</string>
   </array>
   <key>NSBluetoothAlwaysUsageDescription</key>
   <string>whoof reads heart rate and recovery data from your WHOOP strap, including overnight.</string>
   ```

3. **State restoration** — so iOS relaunches the app and hands back the strap
   after it suspends the process overnight. The `@capacitor-community/bluetooth-le`
   plugin is initialised from JS; to opt into CoreBluetooth restoration, the
   native `CBCentralManager` must be created with a restore identifier. Add to
   `ios/App/App/AppDelegate.swift`:

   ```swift
   import CoreBluetooth

   // Minimal restoration handler: iOS calls this on background relaunch so the
   // central manager (and its reconnect-pending peripherals) survive a suspend.
   extension AppDelegate {
     func application(_ application: UIApplication,
                      didFinishLaunchingWithOptions launchOptions:
                        [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
       if launchOptions?[.bluetoothCentrals] != nil {
         // Woken to service a restored BLE central — the WebView + plugin
         // re-initialise and the JS reconnect loop in ble/client.js takes over.
       }
       return true
     }
   }
   ```

   > The community plugin opens its own central manager; full
   > `willRestoreState` wiring may require a small fork or a companion native
   > plugin that owns the `CBCentralManagerOptionRestoreIdentifierKey`. The
   > Info.plist background mode above is necessary and sufficient to keep an
   > *already-connected* session streaming through the night; restoration only
   > matters for surviving a full process kill.

## Coach tab in the native shell

`web/` is bundled locally, so BLE + all metrics work fully offline. The Coach
tab calls `/api/coach`, a Cloudflare Pages Function — unreachable from the
`capacitor://` origin. To use Coach in the native app, either set
`server.url` in `capacitor.config.json` to `https://getwhoof.pages.dev` (loads
the live PWA; needs connectivity) or point the coach fetch at an absolute base
URL. Left local-only by default so the core tracker has no network dependency.

## Re-running after web changes

```bash
npm run cap:sync && npm run cap:open   # then Product ▸ Run in Xcode
```
