# Odo for iPhone – setup guide

You don't need a Mac. Codemagic builds the app on its Macs in the cloud and sends it to
TestFlight, Apple's app for installing test versions. Plan on about an hour the first time,
spread over a day or two while Apple approves your account.

## What the iPhone version does

- **Automatic drive detection.** iPhone wakes Odo when you drive away (motion sensors plus
  low-power location). Odo records the trip with GPS even with the screen off or Dasher open.
- **No lost start miles.** Each trip starts from the spot where you last parked.
- **"Was this drive for work?" notification** when a drive ends, with Work and Personal buttons (or one button per work label you add, like DoorDash).
  Long-press or swipe down on it to see the buttons.
- **Shifts.** Tap **Start shift** (or let a Shortcuts automation do it when you open Dasher) and every drive is logged
  as DoorDash without asking. It ends when you tap End shift, say "End shift in Odo", or after 12 hours.
- **Start Shift / End Shift actions** in the Shortcuts app and Siri.
- The same trip list, totals, deduction and trip editing as the Android version.
- Everything stays on the phone.

---

## Step 1. Join the Apple Developer Program ($99/year)

1. Go to **developer.apple.com/programs/enroll** and sign in with your Apple ID.
2. Enroll as an **Individual**. Approval usually takes a day or two.

## Step 2. Put the code on GitHub (free)

Codemagic builds from a GitHub repository.

1. Create a free account at **github.com**.
2. Click **+** (top right) → **New repository**. Name it `odo`, choose **Private**, click **Create repository**.
3. On the new repository page, click **uploading an existing file**.
4. Unzip `odo.zip`. Open the `odo` folder, select **everything inside it** (codemagic.yaml, package.json,
   native, scripts, www and the rest), and drag it onto the GitHub page. Click **Commit changes**.

   `codemagic.yaml` must be at the top level of the repository, not inside an `odo` folder.

## Step 3. Set up the app in Apple's websites

Once Apple approves your developer account:

**Register the app ID**
1. Go to **developer.apple.com/account** → **Certificates, Identifiers & Profiles** → **Identifiers** → **+**.
2. Choose **App IDs** → **App** → Continue.
3. Description: `Odo`. Bundle ID: **Explicit**, `com.odomiles.app`. Click Continue, then Register.
   No extra capabilities are needed.

**Create the app listing**
1. Go to **appstoreconnect.apple.com** → **Apps** → **+** → **New App**.
2. Platform **iOS**. Name: anything not already taken, like `Odo Mileage Tracker`
   (you can change it before public launch). Language English. Bundle ID `com.odomiles.app`. SKU `odo`.
   User Access: Full Access. Click Create.

**Create an API key for Codemagic**
1. In App Store Connect: **Users and Access** → **Integrations** → **App Store Connect API** → **Team Keys** → **+**.
2. Name `Codemagic`, Access **App Manager**, click Generate.
3. **Download** the key file (.p8). Apple only lets you download it once, so keep it safe.
4. Write down the **Issuer ID** (top of the page) and the **Key ID** (in the key's row).

## Step 4. Set up Codemagic (free plan: 500 build minutes a month)

1. Go to **codemagic.io** and sign up with your GitHub account.
2. Open **Team settings** → **Team integrations** → **Developer Portal** → **Manage keys** → **Add key**.
   - Name: **`Odo API key`** (exactly this, since the build file looks for this name)
   - Issuer ID and Key ID from Step 3, and upload the .p8 file.
3. Still in Team settings, open **Code signing identities** → **iOS certificates** → **Generate certificate**.
   Choose type **Apple Distribution** and the `Odo API key`. Codemagic creates and stores it for you.
4. Back on **developer.apple.com/account** → **Profiles** → **+**:
   - Choose **App Store Connect** (under Distribution) → Continue.
   - App ID: `com.odomiles.app` → Continue.
   - Pick the certificate Codemagic just made → Continue.
   - Name it `Odo App Store` → Generate.
5. In Codemagic: **Code signing identities** → **iOS provisioning profiles** → **Fetch profiles**,
   then select `Odo App Store`.
6. Go to **Apps** → **Add application** → **GitHub** → pick the `odo` repository.
   Codemagic finds `codemagic.yaml` on its own.
7. Click **Start new build**, choose the workflow **Odo iPhone to TestFlight**, and start it.

The build takes about 15 minutes. If it fails, download the log from the build page and
paste the red error lines to Claude.

## Step 5. Install on your iPhone

1. After the build finishes, Apple takes another 10–30 minutes to process it.
   You'll get an email when it's ready.
2. In App Store Connect → your app → **TestFlight** → **Internal Testing** → **+**,
   create a group (for example `Me`) and add yourself.
3. Install the **TestFlight** app from the App Store on your iPhone, signed in with the same Apple ID.
4. Odo appears in TestFlight. Tap **Install**.

TestFlight builds last 90 days. Each new build replaces the old one, and your trips are kept.

## Step 6. First run

Open Odo → **Settings** and work down the Setup list:

1. **Location** → Allow While Using App.
2. **Location: Always** → tap **Change to Always Allow** when iPhone asks.
   If it doesn't ask, Odo opens Settings: tap **Location** → **Always**.
3. **Precise Location** → make sure it's on in the same Location settings page.
4. **Motion & Fitness** → Allow.
5. **Notifications** → Allow.

Then turn on **Record drives automatically** and check your work types.

**Set up the Dasher shortcut** (instructions are also in Odo's Settings):
1. Open **Shortcuts** → **Automation** → **+**.
2. Choose **App**, pick **Dasher**, check **Is Opened**, select **Run Immediately**.
3. Tap **Next** → **New Blank Automation** → **Add Action**, search **Odo**, choose **Start Shift**, tap **Done**.

If the Start Shift action doesn't show up yet, open Odo once, then try again.

## Testing tips

- First drive: watch for the small location arrow in the status bar soon after you pull out.
- Detection can take a minute or two to notice you're driving. Odo backfills from where you parked.
- Compare a few trips with your car's trip odometer.
- Check battery in **Settings → Battery** after a full shift.
- Don't swipe Odo away in the app switcher. iPhone usually relaunches it for the next drive anyway,
  but leaving it open is more reliable.

## Making changes later

1. Upload the changed files to the GitHub repository (same "Add file → Upload files" page; it replaces files
   with the same name).
2. In Codemagic, click **Start new build**.

Bundle a few fixes into one build to save minutes.

## Not in this test build yet

- Miles on the lock screen while driving (Live Activity). It needs a separate widget part of the app, so it comes
  after this version is building cleanly.
- The year-end tax report and Pro purchase. Planned next, with the report as the Pro feature.
- Backup and export to Files.
