#!/usr/bin/env node
/**
 * Makes the macOS menu bar and Dock show "Jobomate" instead of "Electron"
 * when running unpackaged (`electron .`).
 *
 * On macOS the application-menu title and Dock name are read from the running
 * bundle's `CFBundleName` (Info.plist) — `app.setName()` does NOT override it.
 * In development the running bundle is `node_modules/electron/dist/Electron.app`,
 * so the menu shows "Electron". Packaged builds already get the correct name
 * from electron-builder's `productName`, so this script is a dev-only shim and
 * is re-applied on every `npm start` (npm reinstalls reset node_modules).
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const APP_NAME = "Jobomate";

if (process.platform !== "darwin") {
  process.exit(0);
}

const plist = path.join(
  __dirname,
  "..",
  "node_modules",
  "electron",
  "dist",
  "Electron.app",
  "Contents",
  "Info.plist"
);

if (!fs.existsSync(plist)) {
  process.exit(0);
}

function setKey(key, value) {
  try {
    execFileSync("/usr/libexec/PlistBuddy", [
      "-c",
      `Set :${key} ${value}`,
      plist,
    ]);
  } catch {
    try {
      execFileSync("/usr/libexec/PlistBuddy", [
        "-c",
        `Add :${key} string ${value}`,
        plist,
      ]);
    } catch {
      /* best effort */
    }
  }
}

setKey("CFBundleName", APP_NAME);
setKey("CFBundleDisplayName", APP_NAME);
console.log(`[dev] Electron app name set to "${APP_NAME}"`);
