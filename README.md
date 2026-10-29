# Odo – Android and iPhone test builds

Free automatic mileage tracker. These versions are for testing on your own phone while dashing.

**iPhone:** see SETUP-IPHONE.md. It builds in the cloud with Codemagic, so no Mac is needed.
The rest of this file covers Android.

## What it does

- **Automatic drive detection.** Android's Activity Recognition notices when you're riding in a car (motion sensors, almost no battery). Only then does GPS turn on.
- **No lost start miles.** Each trip starts from your phone's last known location, so the stretch before detection kicks in is counted.
- **"Are you dashing?" notification** when a drive ends, with Yes / No buttons. If you add two or more work types, you get one button per gig (first two) plus No.
- **Trip list** by week, 2 weeks, month or year, with business miles, estimated deduction (2026 IRS rate, 72.5¢/mi, editable) and trips that still need a label.
- **Edit any trip:** switch Work/Personal, change purpose, delete. Each trip shows its route on a map.
- **Start drive / Stop button** for manual control.
- Everything stays on the phone (`trips.json` in the app's private storage).

How a trip ends (automatic mode): when Android says you left the car, Odo waits until you've been still for 2 minutes, then ends the trip. If that signal never comes, it ends after 6 minutes without movement. Automatic trips under 0.25 mile are dropped. Manual trips run until you press Stop.

## One-time setup on the Windows laptop

1. Install **Node.js LTS** from nodejs.org.
2. Install **Android Studio** from developer.android.com/studio. Open it once and let it finish downloading the SDK.
3. Unzip this folder somewhere simple, like `C:\dev\odo`.
4. Open **Command Prompt** in that folder and run:

   ```
   npm install
   npm run setup
   npm run open
   ```

   `setup` creates the Android project and adds Odo's tracking code to it. `open` launches Android Studio.

5. In Android Studio, wait for "Gradle sync" to finish (first time takes a few minutes).

## Put it on your phone

1. On the phone: **Settings → About phone →** tap **Build number** 7 times to unlock Developer options.
2. **Settings → System → Developer options →** turn on **USB debugging**.
3. Plug the phone into the laptop, tap **Allow** on the phone.
4. In Android Studio, pick your phone at the top and press the green **Run ▶** button.

## First run on the phone

Go to **Settings** in the app and work down the Setup list:

1. **Location** → Allow while using the app.
2. **Allow all the time** → Android opens a settings page; pick **Allow all the time**.
3. **Physical activity** → Allow.
4. **Notifications** → Allow.
5. **Battery** → find Odo, choose **Unrestricted** (Samsung: "Unrestricted"; Pixel: "Unrestricted" under App battery usage). This matters: phones love to kill background apps mid-shift.

Then turn on **Record drives automatically** and add your work types (DoorDash, Uber Eats…).

## After changing code

Edit files in `www/` (screens) or `native/android/` (tracking), then:

```
npm run sync
```

and press Run ▶ again.

## Testing tips

- First drive: watch for the "Recording a drive" notification within a minute or two of pulling out.
- Compare a few trips with your car's trip odometer or Google Maps distance.
- To check battery, look at **Settings → Battery → Odo** after a full shift.
- Android Studio's **Logcat** tab shows errors if something misbehaves. Copy any red lines to Claude.

## Known limits of this test build

- Maps use free OpenStreetMap tiles. Fine for personal testing; before publishing, switch to a provider with a free tier meant for apps (their usage policy discourages heavy app use).
- No tax report, export or one-time unlock yet (next step in the plan).
- No home-screen widget yet; the Start drive button covers manual control for now.

## Files

```
www/                  App screens (HTML/CSS/JS). Open www/index.html in Chrome to preview with sample data.
native/android/java/  Tracking code: drive detection, GPS service, trip storage, notifications
native/android/res/   Notification icon
native/ios/App/       iPhone tracking code (Swift) and Shortcuts actions
codemagic.yaml        Cloud build that sends the iPhone version to TestFlight
scripts/              Setup helpers (copy map library, patch the Android project)
```
