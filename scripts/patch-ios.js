// Adds Odo's native tracking code to the iPhone project that "npx cap add ios" generates.
// Safe to run more than once. After this, scripts/ios-add-files.rb registers the files with Xcode.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const appDir = path.join(root, 'ios', 'App', 'App');
if (!fs.existsSync(appDir)) {
  console.error('ios/App/App not found. Run "npx cap add ios" first.');
  process.exit(1);
}

function fail(msg) {
  console.error('patch-ios: ' + msg);
  process.exit(1);
}

// 1. Copy Swift sources.
const src = path.join(root, 'native', 'ios', 'App');
for (const f of fs.readdirSync(src)) {
  if (f.endsWith('.swift')) fs.copyFileSync(path.join(src, f), path.join(appDir, f));
}

// 2. Start the tracker at every launch (iPhone relaunches Odo in the background for location events).
const delegatePath = path.join(appDir, 'AppDelegate.swift');
let delegate = fs.readFileSync(delegatePath, 'utf8');
if (!delegate.includes('Tracker.shared.boot()')) {
  const re = /(didFinishLaunchingWithOptions[^{]*\{)/;
  if (!re.test(delegate)) fail('could not find didFinishLaunchingWithOptions in AppDelegate.swift');
  delegate = delegate.replace(re, '$1\n        Tracker.shared.boot()');
  fs.writeFileSync(delegatePath, delegate);
}

// 3. Use Odo's view controller so the tracker plugin is registered.
const sbPath = path.join(appDir, 'Base.lproj', 'Main.storyboard');
let sb = fs.readFileSync(sbPath, 'utf8');
if (!sb.includes('customClass="MainViewController"')) {
  const re = /customClass="CAPBridgeViewController"\s+customModule="Capacitor"/;
  if (!re.test(sb)) fail('could not find CAPBridgeViewController in Main.storyboard');
  sb = sb.replace(re, 'customClass="MainViewController" customModule="App" customModuleProvider="target"');
  fs.writeFileSync(sbPath, sb);
}

// 4. Info.plist: permission messages, background location, export compliance.
const plistPath = path.join(appDir, 'Info.plist');
let plist = fs.readFileSync(plistPath, 'utf8');
const entries = [
  ['NSLocationWhenInUseUsageDescription',
    '<string>Odo uses your location to measure the miles you drive.</string>'],
  ['NSLocationAlwaysAndWhenInUseUsageDescription',
    '<string>Odo records your drives automatically, even when the app is closed, so no work miles are missed.</string>'],
  ['NSLocationAlwaysUsageDescription',
    '<string>Odo records your drives automatically, even when the app is closed, so no work miles are missed.</string>'],
  ['NSMotionUsageDescription',
    '<string>Odo uses motion data to notice when you start and stop driving, which saves battery.</string>'],
  ['UIBackgroundModes', '<array>\n\t\t<string>location</string>\n\t</array>'],
  ['ITSAppUsesNonExemptEncryption', '<false/>'],
];
let added = '';
for (const [key, value] of entries) {
  if (!plist.includes(`<key>${key}</key>`)) added += `\t<key>${key}</key>\n\t${value}\n`;
}
if (added) {
  const end = plist.lastIndexOf('</dict>');
  if (end < 0) fail('Info.plist looks wrong (no </dict>)');
  plist = plist.slice(0, end) + added + plist.slice(end);
  fs.writeFileSync(plistPath, plist);
}

console.log('Odo native code added to the iPhone project.');
