#!/usr/bin/env node
/**
 * Makes macOS show "Jobomate" instead of "Electron" everywhere (menu bar, ⌘-Tab, AND the Dock tile)
 * when running unpackaged (`electron .`).
 *
 * Why this is more than `app.setName()`:
 *  - `app.setName()` only changes the menu-bar title.
 *  - The Dock / ⌘-Tab label a RUNNING app by its bundle + executable name, and `electron .` launches
 *    the binary directly (bypassing LaunchServices/CFBundleName). So to relabel the Dock we rename the
 *    dev bundle `Electron.app` -> `Jobomate.app`, rename its executable `Electron` -> `Jobomate`, fix
 *    the Info.plist keys, repoint electron's `path.txt`, and re-sign the bundle ad-hoc.
 *
 * This is a dev-only shim (re-applied on every `npm start` / `npm run dev:electron`, since npm
 * reinstalls reset node_modules). Packaged builds are unaffected — electron-builder's `productName`
 * already names them "Jobomate". Idempotent and best-effort: any failure falls back to the previous
 * (correctly-named menu bar) behaviour rather than breaking the launch.
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const APP_NAME = "Jobomate";

if (process.platform !== "darwin") {
  process.exit(0);
}

const distDir = path.join(__dirname, "..", "node_modules", "electron", "dist");
const electronApp = path.join(distDir, "Electron.app");
const jobomateApp = path.join(distDir, `${APP_NAME}.app`);

// Resolve the bundle, preferring the already-renamed one (idempotency).
const appBundle = fs.existsSync(jobomateApp)
  ? jobomateApp
  : fs.existsSync(electronApp)
    ? electronApp
    : null;

if (!appBundle) {
  process.exit(0); // electron not installed yet — nothing to do
}

function setKey(plist, key, value) {
  try {
    execFileSync("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${value}`, plist]);
  } catch {
    try {
      execFileSync("/usr/libexec/PlistBuddy", ["-c", `Add :${key} string ${value}`, plist]);
    } catch {
      /* best effort */
    }
  }
}

let bundle = appBundle;
let renamed = false;

try {
  // 1) Rename the executable Electron -> Jobomate inside the bundle.
  const oldBin = path.join(bundle, "Contents", "MacOS", "Electron");
  const newBin = path.join(bundle, "Contents", "MacOS", APP_NAME);
  if (fs.existsSync(oldBin) && !fs.existsSync(newBin)) {
    fs.renameSync(oldBin, newBin);
    renamed = true;
  }

  // 2) Fix the Info.plist names (CFBundleExecutable drives the Dock/process label).
  const plist = path.join(bundle, "Contents", "Info.plist");
  setKey(plist, "CFBundleName", APP_NAME);
  setKey(plist, "CFBundleDisplayName", APP_NAME);
  if (fs.existsSync(newBin)) setKey(plist, "CFBundleExecutable", APP_NAME);

  // 3) Rename the bundle directory Electron.app -> Jobomate.app so the Dock tile reads "Jobomate".
  if (bundle === electronApp && !fs.existsSync(jobomateApp)) {
    fs.renameSync(electronApp, jobomateApp);
    bundle = jobomateApp;
    renamed = true;
  }

  // 4) Repoint electron's launcher: `electron .` reads dist/<path.txt> to find the binary.
  const pathTxt = path.join(__dirname, "..", "node_modules", "electron", "path.txt");
  if (fs.existsSync(pathTxt)) {
    fs.writeFileSync(pathTxt, `${APP_NAME}.app/Contents/MacOS/${APP_NAME}`);
  }
} catch {
  /* best effort — fall back to the existing (menu-bar-correct) behaviour */
}

// 5) Renaming the executable/bundle + editing the plist breaks the bundle's code signature; re-seal
//    it ad-hoc so macOS still launches it. Only needed right after a rename. Best-effort.
if (renamed) {
  try {
    execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", bundle], {
      stdio: "ignore",
    });
  } catch {
    /* best effort */
  }
}

console.log(`[dev] Dev app relabelled to "${APP_NAME}" (menu bar, ⌘-Tab + Dock).`);
