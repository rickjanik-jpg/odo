// Adds Odo's native tracking code to the Android project that "npx cap add android" generates.
// Safe to run more than once.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const app = path.join(root, 'android', 'app');
if (!fs.existsSync(app)) {
  console.error('android/ folder not found. Run "npx cap add android" first.');
  process.exit(1);
}

// 1. Copy Java sources (this also replaces the generated MainActivity).
const javaSrc = path.join(root, 'native', 'android', 'java', 'com', 'odomiles', 'app');
const javaDest = path.join(app, 'src', 'main', 'java', 'com', 'odomiles', 'app');
fs.mkdirSync(javaDest, { recursive: true });
for (const f of fs.readdirSync(javaSrc)) {
  fs.copyFileSync(path.join(javaSrc, f), path.join(javaDest, f));
}

// 2. Copy resources (notification icon).
const resSrc = path.join(root, 'native', 'android', 'res');
const resDest = path.join(app, 'src', 'main', 'res');
for (const dir of fs.readdirSync(resSrc)) {
  fs.mkdirSync(path.join(resDest, dir), { recursive: true });
  for (const f of fs.readdirSync(path.join(resSrc, dir))) {
    fs.copyFileSync(path.join(resSrc, dir, f), path.join(resDest, dir, f));
  }
}

// 3. Manifest: permissions, service and receivers.
const manifestPath = path.join(app, 'src', 'main', 'AndroidManifest.xml');
let manifest = fs.readFileSync(manifestPath, 'utf8');
if (!manifest.includes('<!-- odo:permissions -->')) {
  const perms = `    <!-- odo:permissions -->
    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
    <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
    <uses-permission android:name="android.permission.ACCESS_BACKGROUND_LOCATION" />
    <uses-permission android:name="android.permission.ACTIVITY_RECOGNITION" />
    <uses-permission android:name="com.google.android.gms.permission.ACTIVITY_RECOGNITION" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_LOCATION" />
    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
    <uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />
`;
  manifest = manifest.replace(/(\s*)<application/, `\n${perms}$1<application`);
}
if (!manifest.includes('<!-- odo:components -->')) {
  const comps = `
        <!-- odo:components -->
        <service
            android:name=".TrackingService"
            android:exported="false"
            android:foregroundServiceType="location" />
        <receiver android:name=".TransitionReceiver" android:exported="false" />
        <receiver android:name=".TripActionReceiver" android:exported="false" />
        <receiver android:name=".BootReceiver" android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.BOOT_COMPLETED" />
                <action android:name="android.intent.action.MY_PACKAGE_REPLACED" />
            </intent-filter>
        </receiver>
`;
  manifest = manifest.replace(/(\s*)<\/application>/, `${comps}$1</application>`);
}
fs.writeFileSync(manifestPath, manifest);

// 4. Gradle: Google Play location services (Activity Recognition + fused GPS).
const gradlePath = path.join(app, 'build.gradle');
let gradle = fs.readFileSync(gradlePath, 'utf8');
if (!gradle.includes('play-services-location')) {
  gradle = gradle.replace(
    /dependencies\s*\{/,
    "dependencies {\n    implementation 'com.google.android.gms:play-services-location:21.3.0'"
  );
  fs.writeFileSync(gradlePath, gradle);
}

console.log('Odo native code added to the Android project.');
