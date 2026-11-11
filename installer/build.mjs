#!/usr/bin/env node
/**
 * Builds the Windows installer and the portable version.
 *
 *   node installer/build.mjs
 *
 * Requires Inno Setup 6 (ISCC.exe). The Node runtime is copied from the
 * current installation, so the target machine does not need Node.
 */

import fs from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const INSTALLER_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(INSTALLER_DIR, "..");
const BUILD_DIR = path.join(INSTALLER_DIR, "build");
const APP_DIR = path.join(BUILD_DIR, "app");
const OUT_DIR = path.join(INSTALLER_DIR, "out");
const ICON_FILE = path.join(INSTALLER_DIR, "app.ico");

const pkg = JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8"));
const VERSION = pkg.version;

const ISCC_CANDIDATES = [
  process.env.ISCC,
  "C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe",
  "C:\\Program Files\\Inno Setup 6\\ISCC.exe",
  path.join(process.env.LOCALAPPDATA || "", "Programs", "Inno Setup 6", "ISCC.exe"),
].filter(Boolean);

function findIscc() {
  return ISCC_CANDIDATES.find((candidate) => existsSync(candidate)) || null;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      windowsHide: true,
      ...options,
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(command)} exited with code ${code}`));
    });
  });
}

function formatMb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/* ----------------------------------- icon ---------------------------------- */

function makeIconFile(file) {
  const SIZE = 256;
  const SCALE = 2;
  const S = SIZE * SCALE;

  const canvas = new Uint8Array(S * S * 4);
  const px = (offset, r, g, b, a = 255) => {
    canvas[offset] = r;
    canvas[offset + 1] = g;
    canvas[offset + 2] = b;
    canvas[offset + 3] = a;
  };

  const inRoundRect = (x, y, left, top, right, bottom, radius) => {
    if (x < left || x > right || y < top || y > bottom) return false;
    const cx = Math.min(Math.max(x, left + radius), right - radius);
    const cy = Math.min(Math.max(y, top + radius), bottom - radius);
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= radius * radius;
  };

  const fill = (left, top, right, bottom, radius, color) => {
    const l = left * SCALE;
    const t = top * SCALE;
    const r = right * SCALE;
    const b = bottom * SCALE;
    const rad = radius * SCALE;
    for (let y = Math.floor(t); y < Math.ceil(b); y += 1) {
      for (let x = Math.floor(l); x < Math.ceil(r); x += 1) {
        if (inRoundRect(x + 0.5, y + 0.5, l, t, r, b, rad)) {
          const offset = (y * S + x) * 4;
          px(offset, color[0], color[1], color[2], 255);
        }
      }
    }
  };

  // Background: dark rounded square.
  fill(10, 10, 246, 246, 46, [26, 27, 31]);
  // Folder: tab and body.
  fill(56, 76, 140, 112, 14, [217, 119, 87]);
  fill(50, 98, 206, 192, 20, [217, 119, 87]);
  // Lighter strip on top of the body.
  fill(50, 98, 206, 120, 11, [230, 138, 107]);
  // Dark slot inside the folder.
  fill(86, 138, 170, 146, 4, [60, 40, 32]);

  const pixels = new Uint8Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
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
      const offset = (y * SIZE + x) * 4;
      pixels[offset] = Math.round(r / count);
      pixels[offset + 1] = Math.round(g / count);
      pixels[offset + 2] = Math.round(b / count);
      pixels[offset + 3] = Math.round(a / count);
    }
  }

  // BMP inside ICO: rows bottom-up, BGRA.
  const xor = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y += 1) {
    const sourceRow = SIZE - 1 - y;
    for (let x = 0; x < SIZE; x += 1) {
      const src = (sourceRow * SIZE + x) * 4;
      const dst = (y * SIZE + x) * 4;
      xor[dst] = pixels[src + 2];
      xor[dst + 1] = pixels[src + 1];
      xor[dst + 2] = pixels[src];
      xor[dst + 3] = pixels[src + 3];
    }
  }

  const maskRow = Math.ceil(SIZE / 32) * 4;
  const mask = Buffer.alloc(maskRow * SIZE, 0);

  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(SIZE, 4);
  header.writeInt32LE(SIZE * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);
  header.writeUInt32LE(xor.length + mask.length, 20);
  header.writeInt32LE(0, 24);
  header.writeInt32LE(0, 28);
  header.writeUInt32LE(0, 32);
  header.writeUInt32LE(0, 36);

  const image = Buffer.concat([header, xor, mask]);

  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(1, 4);

  const entry = Buffer.alloc(16);
  entry.writeUInt8(0, 0);
  entry.writeUInt8(0, 1);
  entry.writeUInt8(0, 2);
  entry.writeUInt8(0, 3);
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(image.length, 8);
  entry.writeUInt32LE(6 + 16, 12);

  writeFileSync(file, Buffer.concat([dir, entry, image]));
}


async function dirSize(dir) {
  let total = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(full);
    else if (entry.isFile()) total += (await fs.stat(full)).size;
  }
  return total;
}

async function copyProject() {
  await fs.rm(BUILD_DIR, { recursive: true, force: true });
  await fs.mkdir(APP_DIR, { recursive: true });

  for (const item of ["src", "package.json", "package-lock.json", "README.md", "LICENSE", "start-ui.cmd"]) {
    await fs.cp(path.join(ROOT, item), path.join(APP_DIR, item), { recursive: true });
  }

  await fs.mkdir(path.join(APP_DIR, "ui"), { recursive: true });
  await fs.cp(path.join(ROOT, "ui", "public"), path.join(APP_DIR, "ui", "public"), {
    recursive: true,
  });
  await fs.copyFile(path.join(ROOT, "ui", "server.js"), path.join(APP_DIR, "ui", "server.js"));

  // Instruction file with BOM so Notepad and Inno Setup read UTF-8 correctly.
  const instruction = await fs.readFile(path.join(INSTALLER_DIR, "INSTRUCTION.txt"), "utf8");
  const instructionFile = path.join(APP_DIR, "INSTRUCTION.txt");
  await fs.writeFile(instructionFile, "\uFEFF" + instruction, "utf8");
  await fs.writeFile(path.join(APP_DIR, "READ_ME.txt"), "\uFEFF" + instruction, "utf8");
  await fs.copyFile(ICON_FILE, path.join(APP_DIR, "icon.ico"));

  return instructionFile;
}

async function copyNodeRuntime() {
  if (process.platform !== "win32") {
    throw new Error("Building the installer requires Windows.");
  }

  const source = process.execPath;
  if (path.basename(source).toLowerCase() !== "node.exe") {
    throw new Error(`Could not find node.exe (current: ${source}).`);
  }

  const runtimeDir = path.join(APP_DIR, "runtime");
  await fs.mkdir(runtimeDir, { recursive: true });
  await fs.copyFile(source, path.join(runtimeDir, "node.exe"));
  return path.join(runtimeDir, "node.exe");
}

async function installProductionDeps() {
  const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");

  if (existsSync(npmCli)) {
    await run(process.execPath, [npmCli, "ci", "--omit=dev", "--no-audit", "--no-fund"], {
      cwd: APP_DIR,
    });
    return;
  }

  await run(process.env.ComSpec || "cmd.exe", [
    "/c",
    "npm ci --omit=dev --no-audit --no-fund",
  ], { cwd: APP_DIR });
}

async function verify() {
  const required = [
    path.join(APP_DIR, "src", "index.js"),
    path.join(APP_DIR, "ui", "server.js"),
    path.join(APP_DIR, "ui", "public", "index.html"),
    path.join(APP_DIR, "runtime", "node.exe"),
    path.join(APP_DIR, "node_modules", "@modelcontextprotocol", "sdk", "package.json"),
  ];
  for (const file of required) {
    if (!existsSync(file)) throw new Error(`Missing file in the build: ${file}`);
  }
}

async function makePortableZip() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const zip = path.join(OUT_DIR, `ClaudeFileManager-Portable-${VERSION}.zip`);
  await fs.rm(zip, { force: true });

  const script = `Compress-Archive -Path '${APP_DIR}\\*' -DestinationPath '${zip}' -CompressionLevel Optimal -Force`;
  await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);

  const stat = await fs.stat(zip);
  console.log(`  Portable version: ${zip} (${formatMb(stat.size)})`);
  return zip;
}

async function makeInstaller(instructionFile) {
  const iscc = findIscc();
  if (!iscc) {
    console.log("");
    console.log("  Inno Setup 6 not found — the .exe installer was not built.");
    console.log("  Install it: winget install --id JRSoftware.InnoSetup -e");
    console.log("  Then run again: node installer/build.mjs");
    return null;
  }

  await fs.mkdir(OUT_DIR, { recursive: true });

  await run(iscc, [
    `/DMyAppVersion=${VERSION}`,
    `/DSourceDir=${APP_DIR}`,
    `/DOutputDir=${OUT_DIR}`,
    `/DInstructionFile=${instructionFile}`,
    `/DIconFile=${ICON_FILE}`,
    path.join(INSTALLER_DIR, "setup.iss"),
  ]);

  const exe = path.join(OUT_DIR, `ClaudeFileManager-Setup-${VERSION}.exe`);
  if (!existsSync(exe)) throw new Error(`Inno Setup did not create the file: ${exe}`);

  const stat = await fs.stat(exe);
  console.log(`  Installer:         ${exe} (${formatMb(stat.size)})`);
  return exe;
}

async function main() {
  console.log("");
  console.log(`Building Claude File Manager ${VERSION}`);
  console.log("------------------------------------------");

  console.log("• Drawing the icon…");
  makeIconFile(ICON_FILE);

  console.log("• Copying project files…");
  const instructionFile = await copyProject();

  console.log("• Copying the Node.js runtime…");
  await copyNodeRuntime();

  console.log("• Installing production dependencies…");
  await installProductionDeps();

  console.log("• Verifying the build…");
  await verify();

  const total = await dirSize(APP_DIR);
  console.log(`• Application size: ${formatMb(total)}`);

  console.log("• Creating the portable archive…");
  await makePortableZip();

  console.log("• Building the installer…");
  await makeInstaller(instructionFile);

  console.log("");
  console.log("Done. Files are in installer\\out");
  console.log("");
}

main().catch((error) => {
  console.error("");
  console.error("Build error:", error.message);
  process.exit(1);
});
