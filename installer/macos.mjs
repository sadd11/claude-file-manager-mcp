#!/usr/bin/env node
/**
 * Builds the macOS app bundle and (on macOS) the drag-to-Applications DMG.
 *
 *   node installer/macos.mjs            # app bundle + DMG
 *   node installer/macos.mjs --app-only # just the .app bundle (for local checks)
 *
 * The .app wraps the whole portable app (src, ui, node_modules) plus a
 * bundled Node.js runtime for both arm64 and x64, so nothing else has to be
 * installed on the target Mac. Run it from the repo root after
 * `npm ci --omit=dev` (the runner or the developer machine needs network
 * access to download the Node.js binaries).
 */

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const INSTALLER_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(INSTALLER_DIR, "..");
const BUILD_DIR = path.join(INSTALLER_DIR, "build", "mac-app");
const OUT_DIR = path.join(INSTALLER_DIR, "out");
const APP_ONLY = process.argv.includes("--app-only");

const pkg = JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8"));
const VERSION = pkg.version;

const APP_NAME = "Claude File Manager";
const BUNDLE_ID = "com.sadd11.claude-file-manager";
const NODE_DIST = "https://nodejs.org/dist/latest-v22.x/";

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

/* --------------------------------- icon ----------------------------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const body = Buffer.concat([head, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 0);
  return Buffer.concat([body, crc]);
}

/** Minimal RGBA PNG encoder — enough for the flat app icon. */
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Renders the folder icon (drawn in a 256-unit space) at any size. */
function renderIconPng(size) {
  const SCALE = 2;
  const S = size * SCALE;
  const u = size / 256;

  const canvas = new Uint8Array(S * S * 4);
  const inRoundRect = (x, y, left, top, right, bottom, radius) => {
    if (x < left || x > right || y < top || y > bottom) return false;
    const cx = Math.min(Math.max(x, left + radius), right - radius);
    const cy = Math.min(Math.max(y, top + radius), bottom - radius);
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= radius * radius;
  };

  const fill = (left, top, right, bottom, radius, color) => {
    const l = left * u * SCALE;
    const t = top * u * SCALE;
    const r = right * u * SCALE;
    const b = bottom * u * SCALE;
    const rad = radius * u * SCALE;
    for (let y = Math.floor(t); y < Math.ceil(b); y += 1) {
      for (let x = Math.floor(l); x < Math.ceil(r); x += 1) {
        if (inRoundRect(x + 0.5, y + 0.5, l, t, r, b, rad)) {
          const offset = (y * S + x) * 4;
          canvas[offset] = color[0];
          canvas[offset + 1] = color[1];
          canvas[offset + 2] = color[2];
          canvas[offset + 3] = 255;
        }
      }
    }
  };

  fill(10, 10, 246, 246, 46, [26, 27, 31]); // background
  fill(56, 76, 140, 112, 14, [217, 119, 87]); // folder tab
  fill(50, 98, 206, 192, 20, [217, 119, 87]); // folder body
  fill(50, 98, 206, 120, 11, [230, 138, 107]); // lighter strip
  fill(86, 138, 170, 146, 4, [60, 40, 32]); // dark slot

  // Box-filter downscale from the supersampled canvas.
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SCALE; sy += 1) {
        for (let sx = 0; sx < SCALE; sx += 1) {
          const offset = ((y * SCALE + sy) * S + (x * SCALE + sx)) * 4;
          r += canvas[offset];
          g += canvas[offset + 1];
          b += canvas[offset + 2];
          a += canvas[offset + 3];
        }
      }
      const count = SCALE * SCALE;
      const offset = (y * size + x) * 4;
      pixels[offset] = Math.round(r / count);
      pixels[offset + 1] = Math.round(g / count);
      pixels[offset + 2] = Math.round(b / count);
      pixels[offset + 3] = Math.round(a / count);
    }
  }
  return encodePng(size, pixels);
}

function makeIcns() {
  const parts = [
    ["ic07", renderIconPng(128)],
    ["ic08", renderIconPng(256)],
    ["ic09", renderIconPng(512)],
  ];
  const chunks = parts.map(([type, png]) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, "ascii");
    head.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([head, png]);
  });
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const header = Buffer.alloc(8);
  header.write("icns", 0, "ascii");
  header.writeUInt32BE(total + 8, 4);
  return Buffer.concat([header, ...chunks]);
}

/* --------------------------------- bundle --------------------------------- */

function infoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>claude-file-manager</string>
  <key>CFBundleIconFile</key><string>app.icns</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`;
}

/** The executable inside Contents/MacOS. LF endings are essential. */
function launcherScript() {
  return `#!/bin/bash
# Claude File Manager ${VERSION} — starts the local setup UI.
DIR="$(cd "$(dirname "$0")" && pwd)"
APP_ROOT="$DIR/../Resources/app"
RUNTIME="$DIR/../Resources/runtime"

case "$(uname -m)" in
  arm64) NODE_BIN="$RUNTIME/node-arm64" ;;
  *)     NODE_BIN="$RUNTIME/node-x64" ;;
esac
if [ ! -x "$NODE_BIN" ]; then
  NODE_BIN="node"
fi

cd "$APP_ROOT" || exit 1
exec "$NODE_BIN" ui/server.js
`;
}

function dmgReadme() {
  return `Claude File Manager ${VERSION} for macOS
=========================================

Install: drag "Claude File Manager" onto the "Applications" folder alias,
then open it from Launchpad or the Applications folder.

The app starts a local web page (http://127.0.0.1:4317) where you choose a
folder and connect the MCP server to Claude Desktop. Node.js is bundled —
nothing else needs to be installed.

Unsigned app note
-----------------
The app is not signed with an Apple Developer certificate, so the first
launch may show a security warning. If macOS refuses to open it, run once
in Terminal:

  xattr -cr "/Applications/Claude File Manager.app"

then open the app again. After that it starts normally.
`;
}

async function fetchBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${url} (HTTP ${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

async function downloadNodeRuntimes(runtimeDir) {
  await fs.mkdir(runtimeDir, { recursive: true });
  const listing = await (await fetch(NODE_DIST)).text();
  for (const arch of ["arm64", "x64"]) {
    const match = listing.match(new RegExp(`node-v[\\w.]+-darwin-${arch}\\.tar\\.gz`));
    if (!match) throw new Error(`Could not find a darwin-${arch} build on ${NODE_DIST}`);
    const file = match[0];
    const url = NODE_DIST + file;
    console.log(`  • node (${arch}): ${file}`);

    // Verify against the official SHASUMS256 and retry — a silently
    // truncated download would otherwise break the tar step.
    const shasums = (await fetchBuffer(`${NODE_DIST}SHASUMS256.txt`)).toString("utf8");
    const expectedSha = new RegExp(`^([0-9a-f]{64})\\s+${file}$`, "m").exec(shasums)?.[1];
    if (!expectedSha) throw new Error(`No SHASUMS256 entry for ${file}.`);

    const tgz = path.join(runtimeDir, file);
    let tarball = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      tarball = await fetchBuffer(url);
      const actualSha = crypto.createHash("sha256").update(tarball).digest("hex");
      if (actualSha === expectedSha) break;
      console.log(`    checksum mismatch (attempt ${attempt}), retrying…`);
      tarball = null;
    }
    if (!tarball) throw new Error(`SHA256 mismatch for ${file} after 3 attempts.`);
    await fs.writeFile(tgz, tarball);
    // Extract only the node binary itself. Run tar with a relative file
    // name: GNU tar treats "E:\…" as a remote host (the colon!).
    const unpackedDir = file.replace(/\.tar\.gz$/, "");
    await run("tar", ["-xzf", file, "-C", ".", `${unpackedDir}/bin/node`], {
      cwd: runtimeDir,
    });
    const dest = path.join(runtimeDir, arch === "arm64" ? "node-arm64" : "node-x64");
    await fs.rename(path.join(runtimeDir, unpackedDir, "bin", "node"), dest);
    await fs.rm(path.join(runtimeDir, unpackedDir), { recursive: true, force: true });
    await fs.rm(tgz, { force: true });
    await fs.chmod(dest, 0o755);
  }
}

async function main() {
  console.log(`Building ${APP_NAME} ${VERSION} (macOS)`);
  console.log("------------------------------------------------");

  await fs.rm(BUILD_DIR, { recursive: true, force: true });
  const appDir = path.join(BUILD_DIR, `${APP_NAME}.app`);
  const contents = path.join(appDir, "Contents");
  const resources = path.join(contents, "Resources");
  const appRoot = path.join(resources, "app");
  await fs.mkdir(path.join(contents, "MacOS"), { recursive: true });
  await fs.mkdir(appRoot, { recursive: true });

  console.log("• Writing the bundle…");
  await fs.writeFile(path.join(contents, "Info.plist"), infoPlist(), "utf8");
  await fs.writeFile(path.join(contents, "MacOS", "claude-file-manager"), launcherScript(), "utf8");
  await fs.chmod(path.join(contents, "MacOS", "claude-file-manager"), 0o755);
  await fs.writeFile(path.join(resources, "app.icns"), makeIcns());

  console.log("• Copying the application…");
  for (const item of ["src", "package.json", "package-lock.json", "README.md", "LICENSE"]) {
    await fs.cp(path.join(ROOT, item), path.join(appRoot, item), { recursive: true });
  }
  await fs.cp(path.join(ROOT, "ui", "public"), path.join(appRoot, "ui", "public"), { recursive: true });
  await fs.copyFile(path.join(ROOT, "ui", "server.js"), path.join(appRoot, "ui", "server.js"));
  if (!existsSync(path.join(ROOT, "node_modules"))) {
    throw new Error("node_modules not found — run `npm ci --omit=dev` first.");
  }
  await fs.cp(path.join(ROOT, "node_modules"), path.join(appRoot, "node_modules"), { recursive: true });

  console.log("• Downloading the Node.js runtime (arm64 + x64)…");
  await downloadNodeRuntimes(path.join(resources, "runtime"));

  await fs.writeFile(path.join(BUILD_DIR, "README.txt"), dmgReadme(), "utf8");

  if (APP_ONLY) {
    console.log(`\nBundle ready (no DMG, --app-only): ${appDir}`);
    return;
  }

  console.log("• Creating the DMG…");
  const dmgStaging = path.join(BUILD_DIR, "dmg");
  await fs.mkdir(dmgStaging, { recursive: true });
  await fs.cp(appDir, path.join(dmgStaging, `${APP_NAME}.app`), { recursive: true });
  await fs.symlink("/Applications", path.join(dmgStaging, "Applications"), "dir");
  await fs.copyFile(path.join(BUILD_DIR, "README.txt"), path.join(dmgStaging, "README.txt"));
  await fs.mkdir(OUT_DIR, { recursive: true });
  const dmg = path.join(OUT_DIR, `ClaudeFileManager-${VERSION}.dmg`);
  await fs.rm(dmg, { force: true });
  await run("hdiutil", [
    "create", "-volname", APP_NAME, "-srcfolder", dmgStaging, "-format", "UDZO", "-ov", dmg,
  ]);

  const stat = await fs.stat(dmg);
  console.log(`\nDMG: ${dmg} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
}

main().catch((error) => {
  console.error("\nBuild error:", error.message);
  process.exit(1);
});
