#!/usr/bin/env node
/**
 * Local web UI for setting up Claude File Manager MCP.
 *
 * Run:  npm run ui
 * Opens http://127.0.0.1:4317 — pick a folder and connect the server
 * to Claude Desktop. Everything runs on your machine only.
 */

import http from "node:http";
import fs from "node:fs/promises";
import { constants as fsConstants, createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const UI_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(UI_DIR, "..");
const PUBLIC_DIR = path.join(UI_DIR, "public");
const STATE_FILE = process.env.UI_STATE_FILE
  ? path.resolve(process.env.UI_STATE_FILE)
  : path.join(UI_DIR, "state.json");
const SERVER_ENTRY = path.join(PROJECT_ROOT, "src", "index.js");
const BUNDLED_NODE = path.join(
  PROJECT_ROOT,
  "runtime",
  process.platform === "win32" ? "node.exe" : "node",
);
const NODE_BIN = existsSync(BUNDLED_NODE) ? BUNDLED_NODE : "node";

const HOST = "127.0.0.1";
const BASE_PORT = Number(process.env.UI_PORT || 4317);
const TOKEN = process.env.UI_TOKEN || crypto.randomBytes(24).toString("hex");
const MAX_PORT_TRIES = 20;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/* -------------------------------------------------------------------------- */
/*                                     State                                  */
/* -------------------------------------------------------------------------- */

const defaultRoot = path.resolve(process.env.MCP_FILE_ROOT || PROJECT_ROOT);
let state = {
  root: defaultRoot,
  extraRoots: [],
  allowOutside: false,
  allowShell: false,
  sandbox: false,
  recent: [],
};

function samePath(a, b) {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function uniquePaths(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const abs = path.resolve(item);
    const key = process.platform === "win32" ? abs.toLowerCase() : abs;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(abs);
  }
  return out;
}

function allRoots() {
  return uniquePaths([state.root, ...state.extraRoots]);
}

function applyRoots(env) {
  const roots = allRoots();
  delete env.MCP_FILE_ROOTS;
  delete env.MCP_FILE_ROOT;
  if (roots.length > 1) env.MCP_FILE_ROOTS = roots.join(path.delimiter);
  else env.MCP_FILE_ROOT = roots[0];
  return env;
}

function dataDir() {
  return path.join(state.root, ".mcp");
}

async function statOrNull(target) {
  try {
    return await fs.stat(target);
  } catch {
    return null;
  }
}

async function readJsonSafe(file, fallback) {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

async function writeJsonSafe(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Write through a temp file and rename, the same way the MCP server does:
  // a reader never sees a half-written JSON, even if two processes write
  // to the same activity/trash index at once.
  const tmp = `${file}.tmp-${crypto.randomBytes(4).toString("hex")}`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(tmp, file);
}

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed.root === "string" && parsed.root.trim()) {
      state.root = path.resolve(parsed.root);
    }
    if (Array.isArray(parsed.extraRoots)) {
      state.extraRoots = uniquePaths(
        parsed.extraRoots
          .filter((item) => typeof item === "string" && item.trim())
          .map((item) => path.resolve(item)),
      ).filter((item) => !samePath(item, state.root));
    }
    state.allowOutside = Boolean(parsed.allowOutside);
    state.allowShell = Boolean(parsed.allowShell);
    state.sandbox = Boolean(parsed.sandbox);
    if (Array.isArray(parsed.recent)) {
      state.recent = parsed.recent
        .filter((item) => typeof item === "string" && item.trim())
        .map((item) => path.resolve(item))
        .slice(0, 8);
    }
  } catch {
    /* first run */
  }
}

async function saveState() {
  await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

/* -------------------------------------------------------------------------- */
/*                                 Claude Desktop                             */
/* -------------------------------------------------------------------------- */

function desktopConfigCandidates() {
  if (process.env.MCP_UI_DESKTOP_CONFIG) {
    return [path.resolve(process.env.MCP_UI_DESKTOP_CONFIG)];
  }
  const candidates = [];
  // Newer Claude builds keep per-account data (config included) in
  // %LOCALAPPDATA%\Claude-Data\<instance>\. Older builds use %APPDATA%\Claude.
  const dataDir = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "Claude-Data")
    : null;
  if (dataDir && existsSync(dataDir)) {
    try {
      for (const entry of readdirSync(dataDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          candidates.push(path.join(dataDir, entry.name, "claude_desktop_config.json"));
        }
      }
    } catch {
      /* unreadable dir: fall through to the legacy path */
    }
  }
  candidates.push(
    path.join(
      process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
      "Claude",
      "claude_desktop_config.json",
    ),
  );
  if (process.platform === "darwin") {
    candidates.push(
      path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    );
  }
  if (process.platform === "linux") {
    candidates.push(
      path.join(
        process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
        "Claude",
        "claude_desktop_config.json",
      ),
    );
  }
  return candidates;
}

/** The config of a modern Claude build when one exists; legacy otherwise. */
async function resolveDesktopConfigFile() {
  const candidates = desktopConfigCandidates();
  const legacy = candidates[candidates.length - 1];
  const modern = candidates.slice(0, -1);
  for (const candidate of modern) {
    if (statSync(candidate, { throwIfNoEntry: false })?.isFile()) return candidate;
  }
  for (const candidate of modern) {
    // No modern config yet: create it next to the instance data that exists.
    if (statSync(path.dirname(candidate), { throwIfNoEntry: false })?.isDirectory()) {
      return candidate;
    }
  }
  return legacy;
}

function buildServerEntry(existing = null) {
  // Preserve env keys the UI does not manage (e.g. MCP_SANDBOX, MCP_MAX_*):
  // a reconnect must not silently wipe hand-added settings.
  const env = applyRoots({ ...(existing?.env ?? {}) });
  if (state.allowOutside) env.MCP_ALLOW_OUTSIDE_ROOT = "1";
  else delete env.MCP_ALLOW_OUTSIDE_ROOT;
  if (state.allowShell) env.MCP_ALLOW_SHELL = "1";
  else delete env.MCP_ALLOW_SHELL;
  if (state.sandbox) env.MCP_SANDBOX = "1";
  else delete env.MCP_SANDBOX;
  return { command: NODE_BIN, args: [SERVER_ENTRY], env };
}

function buildConfigObject(existingEntry = null) {
  return { mcpServers: { files: buildServerEntry(existingEntry) } };
}

function buildCodeCommand() {
  const q = (s) => `"${s.replace(/"/g, '\\"')}"`;
  const parts = ["claude mcp add files", "--scope user"];
  const roots = allRoots();
  if (roots.length > 1) {
    parts.push(`--env MCP_FILE_ROOTS=${q(roots.join(path.delimiter))}`);
  } else {
    parts.push(`--env MCP_FILE_ROOT=${q(roots[0])}`);
  }
  if (state.allowOutside) parts.push("--env MCP_ALLOW_OUTSIDE_ROOT=1");
  if (state.allowShell) parts.push("--env MCP_ALLOW_SHELL=1");
  if (state.sandbox) parts.push("--env MCP_SANDBOX=1");
  parts.push("--", q(NODE_BIN), q(SERVER_ENTRY));
  return parts.join(" ");
}

async function connectDesktop() {
  const file = await resolveDesktopConfigFile();

  // Replace the mcpServers section with the canonical JSON (the same object
  // the preview shows). A backup of the previous content is always saved
  // next to it; hand-added env keys of the files entry itself survive.
  // Newer Claude builds keep app-owned top-level sections (preferences,
  // coworkUserFilesPath) in the same file — those are preserved.
  const APP_OWNED_KEYS = ["preferences", "coworkUserFilesPath"];
  let existingEntry = null;
  let appOwned = null;
  let existed = false;
  let backup = null;
  try {
    const raw = await fs.readFile(file, "utf8");
    existed = true;
    backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await fs.copyFile(file, backup);
    if (raw.trim()) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          existingEntry = parsed.mcpServers?.files ?? null;
          for (const key of APP_OWNED_KEYS) {
            if (parsed[key] !== undefined) appOwned = appOwned || {};
            if (parsed[key] !== undefined) appOwned[key] = parsed[key];
          }
        }
      } catch {
        // Broken JSON is not a reason to block: the backup keeps the old
        // content and we write a clean file over it.
      }
    }
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }

  await fs.mkdir(path.dirname(file), { recursive: true });
  const next = buildConfigObject(existingEntry);
  if (appOwned) Object.assign(next, appOwned);
  await fs.writeFile(file, JSON.stringify(next, null, 2) + "\n", "utf8");

  return {
    message: existed
      ? "Config replaced with the canonical JSON. Fully close and reopen Claude Desktop."
      : "Configuration file created. Start Claude Desktop.",
    configPath: file,
    backup,
  };
}

/* -------------------------------------------------------------------------- */
/*                        Checks and system actions                           */
/* -------------------------------------------------------------------------- */

async function configStatus() {
  const file = await resolveDesktopConfigFile();
  try {
    const config = JSON.parse(await fs.readFile(file, "utf8"));
    const entry = config?.mcpServers?.files;
    const raw = entry?.env?.MCP_FILE_ROOTS;
    const configuredRoots = raw
      ? String(raw)
          .split(path.delimiter)
          .map((item) => item.trim())
          .filter(Boolean)
          .map((item) => path.resolve(item))
      : entry?.env?.MCP_FILE_ROOT
        ? [path.resolve(entry.env.MCP_FILE_ROOT)]
        : [];
    return {
      configured: Boolean(entry),
      configuredRoot: configuredRoots[0] || null,
      configuredRoots,
      configPath: file,
    };
  } catch {
    return {
      configured: false,
      configuredRoot: null,
      configuredRoots: [],
      configPath: file,
    };
  }
}

function checkServer() {
  return new Promise((resolve, reject) => {
    const env = applyRoots({ ...process.env });
    if (state.allowOutside) env.MCP_ALLOW_OUTSIDE_ROOT = "1";
    if (state.allowShell) env.MCP_ALLOW_SHELL = "1";
    delete env.MCP_DATA_DIR;

    const child = spawn(NODE_BIN, [SERVER_ENTRY], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let buffer = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      finish(new Error("The server did not respond within 10 seconds."));
    }, 10_000);

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* already stopped */
      }
      if (error) reject(error);
      else resolve(value);
    }

    child.on("error", (error) => finish(error));
    child.on("exit", (code) => {
      if (!settled) {
        finish(
          new Error(
            `The server exited with code ${code}.` + (stderr ? " " + stderr.trim() : ""),
          ),
        );
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });

    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "ui-check", version: "1.0" },
        },
      }) + "\n",
    );

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;

        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }

        if (message.id === 1) {
          if (message.error) {
            finish(new Error(message.error.message || "MCP initialization error."));
            return;
          }
          child.stdin.write(
            JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
          );
          child.stdin.write(
            JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) +
              "\n",
          );
        } else if (message.id === 2) {
          if (message.error) {
            finish(new Error(message.error.message || "Failed to get the tool list."));
            return;
          }
          const tools = (message.result?.tools || []).map((tool) => tool.name);
          finish(null, { ok: true, tools, count: tools.length, root: state.root });
        }
      }
    });
  });
}

function pickFolder(start) {
  if (process.platform === "win32") {
    const script = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Choose a folder for Claude'
$dialog.ShowNewFolderButton = $true
if ($env:PICK_START -and (Test-Path -LiteralPath $env:PICK_START)) {
  $dialog.SelectedPath = $env:PICK_START
}
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.WindowState = 'Minimized'
$result = $dialog.ShowDialog($owner)
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.Write($dialog.SelectedPath)
}
`;
    return new Promise((resolve, reject) => {
      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-STA", "-Command", script],
        {
          timeout: 300_000,
          windowsHide: true,
          env: { ...process.env, PICK_START: start || "" },
        },
        (error, stdout) => {
          if (error) return reject(new Error(`Could not open the folder picker: ${error.message}`));
          const picked = stdout.trim();
          resolve(picked || null);
        },
      );
    });
  }

  if (process.platform === "darwin") {
    return new Promise((resolve, reject) => {
      execFile(
        "osascript",
        ["-e", 'POSIX path of (choose folder with prompt "Choose a folder for Claude")'],
        { timeout: 300_000 },
        (error, stdout) => {
          if (error) return resolve(null);
          resolve(stdout.trim() || null);
        },
      );
    });
  }

  return new Promise((resolve, reject) => {
    execFile(
      "zenity",
      ["--file-selection", "--directory", "--title=Choose a folder for Claude"],
      { timeout: 300_000 },
      (error, stdout) => {
        if (error) return resolve(null);
        resolve(stdout.trim() || null);
      },
    );
  });
}

function openInExplorer(target) {
  return new Promise((resolve, reject) => {
    let command;
    let args;
    if (process.platform === "win32") {
      command = "explorer.exe";
      args = [target];
    } else if (process.platform === "darwin") {
      command = "open";
      args = [target];
    } else {
      command = "xdg-open";
      args = [target];
    }

    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", reject);
    child.unref();
    resolve({ ok: true, path: target });
  });
}

/* -------------------------------------------------------------------------- */
/*                                    Drives                                 */
/* -------------------------------------------------------------------------- */

let drivesCache = { at: 0, drives: [] };

async function listDrives() {
  if (process.platform !== "win32") return ["/"];
  if (Date.now() - drivesCache.at < 30_000 && drivesCache.drives.length) {
    return drivesCache.drives;
  }

  let drives = [];
  try {
    const out = await new Promise((resolve, reject) => {
      execFile(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-PSDrive -PSProvider FileSystem | Select-Object -ExpandProperty Root",
        ],
        { timeout: 4000, windowsHide: true },
        (err, stdout) => (err ? reject(err) : resolve(stdout)),
      );
    });
    drives = out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => /^[A-Za-z]:\\$/.test(s));
  } catch {
    drives = [];
  }

  if (!drives.length) {
    const letters = "CDEFGHIJKLMNOPQRSTUVWXYZ".split("");
    const checks = await Promise.all(
      letters.map(async (letter) => {
        const root = `${letter}:\\`;
        try {
          await fs.access(root, fsConstants.R_OK);
          return root;
        } catch {
          return null;
        }
      }),
    );
    drives = checks.filter(Boolean);
  }

  drives.sort((a, b) => a.localeCompare(b));
  drivesCache = { at: Date.now(), drives };
  return drives;
}

/* -------------------------------------------------------------------------- */
/*                                 Folder browser                            */
/* -------------------------------------------------------------------------- */

function breadcrumbs(abs) {
  const parsed = path.parse(abs);
  const parts = abs.slice(parsed.root.length).split(path.sep).filter(Boolean);
  const items = [{ name: parsed.root, path: parsed.root }];
  let current = parsed.root;
  for (const part of parts) {
    current = path.join(current, part);
    items.push({ name: part, path: current });
  }
  return items;
}

async function browse(inputPath) {
  const abs = path.resolve(inputPath);
  let stat;
  try {
    stat = await fs.stat(abs);
  } catch {
    throw new Error(`Folder not found: ${abs}`);
  }
  if (!stat.isDirectory()) throw new Error(`Not a folder: ${abs}`);

  let entries;
  try {
    entries = await fs.readdir(abs, { withFileTypes: true });
  } catch (e) {
    throw new Error(`No access to ${abs}: ${e.message}`);
  }

  const allFolders = entries
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, path: path.join(abs, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, "en"));

  const LIMIT = 2000;
  const folders = allFolders.slice(0, LIMIT);

  return {
    path: abs,
    parent: path.dirname(abs) === abs ? null : path.dirname(abs),
    crumbs: breadcrumbs(abs),
    folders,
    drives: await listDrives(),
    note:
      allFolders.length > LIMIT
        ? `Showing the first ${LIMIT} folders of ${allFolders.length}. Enter a full path to go to another one.`
        : null,
  };
}

/* -------------------------------------------------------------------------- */
/*                                   History                                  */
/* -------------------------------------------------------------------------- */

async function moveItem(source, destination) {
  try {
    await fs.rename(source, destination);
  } catch (e) {
    if (e.code !== "EXDEV") throw e;
    await fs.cp(source, destination, { recursive: true });
    await fs.rm(source, { recursive: true, force: true });
  }
}

async function readActivityItems() {
  const log = await readJsonSafe(path.join(dataDir(), "activity.json"), { items: [] });
  return Array.isArray(log.items) ? log.items : [];
}

async function recordUiActivity(kind, description, undo) {
  const items = await readActivityItems();
  items.push({ at: new Date().toISOString(), kind, description, undo: undo || null });
  await writeJsonSafe(path.join(dataDir(), "activity.json"), {
    items: items.slice(-100),
  });
}

/** Maps backup file paths to the file they belong to, using the activity log. */
async function backupTargets() {
  const map = new Map();
  for (const entry of await readActivityItems()) {
    const undo = entry.undo;
    if (!undo) continue;
    if (undo.kind === "restore_file" && undo.backup && undo.target) {
      map.set(path.resolve(undo.backup), undo.target);
    }
    if (undo.kind === "restore_files" && Array.isArray(undo.items)) {
      for (const item of undo.items) {
        if (item?.backup && item?.target) {
          map.set(path.resolve(item.backup), item.target);
        }
      }
    }
  }
  return map;
}

async function readBackups() {
  const dir = path.join(dataDir(), "backups");
  const targets = await backupTargets();
  let names = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }

  const items = [];
  for (const name of names) {
    const abs = path.join(dir, name);
    const stat = await statOrNull(abs);
    if (!stat?.isFile()) continue;
    items.push({
      name,
      path: abs,
      size: stat.size,
      modified: stat.mtime.toISOString(),
      target: targets.get(path.resolve(abs)) || null,
    });
  }
  return items.sort((a, b) => b.modified.localeCompare(a.modified));
}

async function readTrash() {
  const index = await readJsonSafe(path.join(dataDir(), "trash.json"), { items: [] });
  const items = Array.isArray(index.items) ? index.items : [];
  const result = [];
  for (const item of items.slice().reverse()) {
    result.push({
      id: item.id,
      originalPath: item.originalPath,
      type: item.type === "directory" ? "folder" : "file",
      deletedAt: item.deletedAt,
      exists: Boolean(await statOrNull(item.trashPath)),
    });
  }
  return result;
}

async function readCommands() {
  let raw = "";
  try {
    raw = await fs.readFile(path.join(dataDir(), "commands.log"), "utf8");
  } catch {
    return [];
  }
  const items = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") items.push(parsed);
    } catch {
      /* ignore malformed lines */
    }
  }
  return items.slice(-200).reverse();
}

async function buildHistory() {
  return {
    dataDir: dataDir(),
    roots: allRoots(),
    trash: await readTrash(),
    backups: await readBackups(),
    commands: await readCommands(),
    activity: (await readActivityItems()).slice().reverse(),
  };
}

function isInsideAllowed(target) {
  if (state.allowOutside) return true;
  for (const root of allRoots()) {
    const rel = path.relative(root, target);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return true;
  }
  return false;
}

async function restoreTrash(id, overwrite) {
  const file = path.join(dataDir(), "trash.json");
  const index = await readJsonSafe(file, { items: [] });
  const items = Array.isArray(index.items) ? index.items : [];
  const item = items.find((entry) => entry.id === id);
  if (!item) throw new Error(`No trash entry with id "${id}".`);
  if (!(await statOrNull(item.trashPath))) {
    throw new Error("The deleted item is no longer in the trash folder.");
  }
  if (!isInsideAllowed(item.originalPath)) {
    throw new Error(`The original path is outside the allowed folders: ${item.originalPath}`);
  }

  let replacedId = null;
  if (await statOrNull(item.originalPath)) {
    if (!overwrite) {
      throw new Error(
        `Something already exists at ${item.originalPath}. Confirm replacing it to continue.`,
      );
    }
    // The previous item goes to the trash too, the same way the MCP server
    // handles it — an accidental overwrite stays reversible.
    const trashId = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
    const trashedPath = path.join(
      dataDir(),
      "trash",
      `${trashId}__${path.basename(item.originalPath)}`,
    );
    await fs.mkdir(path.dirname(trashedPath), { recursive: true });
    await moveItem(item.originalPath, trashedPath);
    items.push({
      id: trashId,
      originalPath: item.originalPath,
      trashPath: trashedPath,
      type: item.type,
      deletedAt: new Date().toISOString(),
    });
    replacedId = trashId;
  }

  await fs.mkdir(path.dirname(item.originalPath), { recursive: true });
  await moveItem(item.trashPath, item.originalPath);

  index.items = items.filter((entry) => entry.id !== id);
  await writeJsonSafe(file, index);

  await recordUiActivity("restore", `Restore ${item.originalPath}`, {
    kind: "remove",
    target: item.originalPath,
  });

  return { ...item, replacedId };
}

async function restoreBackup(name) {
  const dir = path.join(dataDir(), "backups");
  const safeName = path.basename(String(name || ""));
  if (!safeName) throw new Error("Backup name is required.");

  const source = path.resolve(dir, safeName);
  if (path.dirname(source) !== path.resolve(dir)) {
    throw new Error("Invalid backup name.");
  }
  if (!(await statOrNull(source))) {
    throw new Error(`Backup not found: ${safeName}`);
  }

  const target = (await backupTargets()).get(source);
  if (!target) {
    throw new Error(
      "This backup is not linked to a file in the activity log. " +
        "Use undo_last_change in Claude instead.",
    );
  }
  if (!isInsideAllowed(target)) {
    throw new Error(`The target path is outside the allowed folders: ${target}`);
  }

  const existed = Boolean(await statOrNull(target));
  let undo = { kind: "remove", target };
  if (existed) {
    const safety = path.join(dir, `${crypto.randomUUID()}__${path.basename(target)}`);
    await fs.copyFile(target, safety);
    undo = { kind: "restore_file", target, backup: safety };
  }

  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(source, target);
  await fs.rm(source, { force: true });

  await recordUiActivity("restore_backup", `Restore backup of ${target}`, undo);
  return { target, backup: safeName };
}

/* -------------------------------------------------------------------------- */
/*                                Update check                                */
/* -------------------------------------------------------------------------- */

/*
 * Looks at the latest GitHub release of the project and compares it with the
 * version in package.json. This is the ONLY outgoing network request of the UI
 * (the MCP server in src/index.js never touches the network). Disable it with
 * UI_NO_UPDATE_CHECK=1.
 */
const UPDATE_REPO = "sadd11/claude-file-manager-mcp";
const UPDATE_API = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;
const UPDATE_PAGE = `https://github.com/${UPDATE_REPO}/releases`;
const UPDATE_ENABLED = process.env.UI_NO_UPDATE_CHECK !== "1";
const UPDATE_OK_TTL = 30 * 60_000; // GitHub allows 60 anonymous requests per hour
const UPDATE_ERR_TTL = 2 * 60_000;
const UPDATE_MIN_FORCE = 30_000;

let updateCache = { at: 0, ttl: 0, value: null };

async function localVersion() {
  const pkg = await readJsonSafe(path.join(PROJECT_ROOT, "package.json"), {});
  return typeof pkg.version === "string" ? pkg.version : null;
}

function parseVersion(text) {
  const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/i.exec(
    String(text || "").trim(),
  );
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3] || 0)], pre: m[4] || "" };
}

function formatVersion(v) {
  return v.nums.join(".") + (v.pre ? `-${v.pre}` : "");
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a.nums[i] !== b.nums[i]) return a.nums[i] > b.nums[i] ? 1 : -1;
  }
  if (a.pre === b.pre) return 0;
  if (!a.pre) return 1; // 1.4.0 is newer than 1.4.0-beta
  if (!b.pre) return -1;
  return a.pre > b.pre ? 1 : -1;
}

function repoUrlOrNull(value) {
  return typeof value === "string" && value.startsWith(`https://github.com/${UPDATE_REPO}/`)
    ? value
    : null;
}

async function fetchLatestRelease() {
  const res = await fetch(UPDATE_API, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "claude-file-manager-ui",
      "x-github-api-version": "2022-11-28",
    },
    signal: AbortSignal.timeout(6000),
  });
  if (res.status === 404) return null; // no releases published yet
  if (res.status === 403 || res.status === 429) {
    throw new Error("GitHub rate limit reached. Try again later.");
  }
  if (!res.ok) throw new Error(`GitHub answered with HTTP ${res.status}.`);
  return res.json();
}

async function checkForUpdate({ force = false } = {}) {
  const current = await localVersion();
  const base = { enabled: UPDATE_ENABLED, current, releasesUrl: UPDATE_PAGE, hasUpdate: false };
  if (!UPDATE_ENABLED) return base;

  const age = Date.now() - updateCache.at;
  if (updateCache.value && age < (force ? UPDATE_MIN_FORCE : updateCache.ttl)) {
    return { ...updateCache.value, current };
  }

  const checkedAt = new Date().toISOString();
  let value;
  let ttl = UPDATE_OK_TTL;
  try {
    const release = await fetchLatestRelease();
    if (!release) {
      value = { ...base, noReleases: true, checkedAt };
    } else {
      const latest = parseVersion(release.tag_name);
      const mine = parseVersion(current);
      const assets = (Array.isArray(release.assets) ? release.assets : [])
        .map((asset) => ({
          name: String(asset?.name || ""),
          size: Number(asset?.size) || 0,
          url: repoUrlOrNull(asset?.browser_download_url),
        }))
        .filter((asset) => asset.name && asset.url)
        .slice(0, 6);
      value = {
        ...base,
        tag: String(release.tag_name || ""),
        latest: latest ? formatVersion(latest) : String(release.tag_name || ""),
        name: typeof release.name === "string" ? release.name : "",
        url: repoUrlOrNull(release.html_url) || UPDATE_PAGE,
        publishedAt: release.published_at || null,
        notes: typeof release.body === "string" ? release.body.slice(0, 1500) : "",
        assets,
        hasUpdate: Boolean(latest && mine && compareVersions(latest, mine) > 0),
        checkedAt,
      };
    }
  } catch (e) {
    ttl = UPDATE_ERR_TTL;
    const message =
      e?.name === "TimeoutError"
        ? "GitHub did not respond in time."
        : e?.name === "TypeError"
          ? "Could not reach GitHub. Is the internet connection working?"
          : e instanceof Error
            ? e.message
            : String(e);
    value = { ...base, error: message, checkedAt };
  }

  updateCache = { at: Date.now(), ttl, value };
  return value;
}

/* -------------------------------------------------------------------------- */
/*                                    HTTP                                    */
/* -------------------------------------------------------------------------- */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(new Error("Request is too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("Invalid JSON in the request"));
      }
    });
    req.on("error", reject);
  });
}

function authorized(req) {
  return req.headers["x-auth-token"] === TOKEN;
}

async function handleApi(req, res, url) {
  if (!authorized(req)) {
    return sendJson(res, 401, { error: "Access denied. Open the UI using the link from the console." });
  }

  if (url.pathname === "/api/state" && req.method === "GET") {
    const desktop = await resolveDesktopConfigFile();
    let desktopExists = false;
    try {
      await fs.access(desktop);
      desktopExists = true;
    } catch {
      /* no file */
    }
    const status = await configStatus();
    return sendJson(res, 200, {
      root: state.root,
      extraRoots: state.extraRoots,
      roots: allRoots(),
      allowOutside: state.allowOutside,
      allowShell: state.allowShell,
      sandbox: state.sandbox,
      recent: state.recent,
      serverEntry: SERVER_ENTRY,
      desktopConfig: desktop,
      desktopExists,
      configured: status.configured,
      configuredRoot: status.configuredRoot,
      configuredRoots: status.configuredRoots,
      projectRoot: PROJECT_ROOT,
      platform: process.platform,
    });
  }

  if (url.pathname === "/api/state" && req.method === "POST") {
    const body = await readBody(req);

    async function validFolder(value) {
      if (typeof value !== "string" || !value.trim()) {
        return { error: "Path is required." };
      }
      const abs = path.resolve(value.trim());
      const stat = await statOrNull(abs);
      if (!stat) return { status: 404, error: `Folder not found: ${abs}` };
      if (!stat.isDirectory()) return { status: 400, error: `Not a folder: ${abs}` };
      try {
        await fs.access(abs, fsConstants.R_OK | fsConstants.W_OK);
      } catch {
        return {
          status: 400,
          error: `No read/write permission for ${abs}. Choose another folder.`,
        };
      }
      return { abs };
    }

    if (body.root !== undefined) {
      const check = await validFolder(body.root);
      if (check.error) return sendJson(res, check.status || 400, { error: check.error });
      state.root = check.abs;
      state.extraRoots = state.extraRoots.filter((item) => !samePath(item, check.abs));
      state.recent = [check.abs, ...state.recent.filter((item) => item !== check.abs)].slice(
        0,
        8,
      );
    }

    if (body.extraRoots !== undefined) {
      if (!Array.isArray(body.extraRoots)) {
        return sendJson(res, 400, { error: "extraRoots must be a list of folders." });
      }
      const next = [];
      for (const item of body.extraRoots) {
        const check = await validFolder(item);
        if (check.error) return sendJson(res, check.status || 400, { error: check.error });
        if (!samePath(check.abs, state.root)) next.push(check.abs);
      }
      state.extraRoots = uniquePaths(next).filter((item) => !samePath(item, state.root));
    }

    if (body.addRoot !== undefined) {
      const check = await validFolder(body.addRoot);
      if (check.error) return sendJson(res, check.status || 400, { error: check.error });
      if (!samePath(check.abs, state.root)) {
        state.extraRoots = uniquePaths([...state.extraRoots, check.abs]).filter(
          (item) => !samePath(item, state.root),
        );
      }
    }

    if (body.removeRoot !== undefined) {
      if (typeof body.removeRoot !== "string" || !body.removeRoot.trim()) {
        return sendJson(res, 400, { error: "Path is required." });
      }
      const abs = path.resolve(body.removeRoot.trim());
      state.extraRoots = state.extraRoots.filter((item) => !samePath(item, abs));
    }

    if (body.allowOutside !== undefined) {
      state.allowOutside = Boolean(body.allowOutside);
    }
    if (body.allowShell !== undefined) {
      state.allowShell = Boolean(body.allowShell);
    }
    if (body.sandbox !== undefined) {
      state.sandbox = Boolean(body.sandbox);
    }
    await saveState();
    return sendJson(res, 200, {
      root: state.root,
      extraRoots: state.extraRoots,
      roots: allRoots(),
      allowOutside: state.allowOutside,
      allowShell: state.allowShell,
      sandbox: state.sandbox,
      recent: state.recent,
    });
  }

  if (url.pathname === "/api/update" && req.method === "GET") {
    const force = url.searchParams.get("force") === "1";
    return sendJson(res, 200, await checkForUpdate({ force }));
  }

  if (url.pathname === "/api/history" && req.method === "GET") {
    return sendJson(res, 200, await buildHistory());
  }

  if (url.pathname === "/api/trash/restore" && req.method === "POST") {
    const body = await readBody(req);
    if (typeof body.id !== "string" || !body.id.trim()) {
      return sendJson(res, 400, { error: "Trash entry id is required." });
    }
    try {
      const item = await restoreTrash(body.id.trim(), Boolean(body.overwrite));
      return sendJson(res, 200, {
        ok: true,
        restored: item.originalPath,
        replacedTrashId: item.replacedId,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const status = /already exists/i.test(message)
        ? 409
        : /outside the allowed folders/i.test(message)
          ? 403
          : /No trash entry|no longer in the trash/i.test(message)
            ? 404
            : 400;
      return sendJson(res, status, { error: message });
    }
  }

  if (url.pathname === "/api/backup/restore" && req.method === "POST") {
    const body = await readBody(req);
    if (typeof body.name !== "string" || !body.name.trim()) {
      return sendJson(res, 400, { error: "Backup name is required." });
    }
    try {
      const result = await restoreBackup(body.name.trim());
      return sendJson(res, 200, { ok: true, ...result });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  if (url.pathname === "/api/browse" && req.method === "GET") {
    const target = url.searchParams.get("path") || state.root;
    try {
      return sendJson(res, 200, await browse(target));
    } catch (e) {
      return sendJson(res, 404, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  if (url.pathname === "/api/preview" && req.method === "GET") {
    return sendJson(res, 200, {
      json: JSON.stringify(buildConfigObject(), null, 2),
      command: buildCodeCommand(),
      serverEntry: SERVER_ENTRY,
      desktopConfig: await resolveDesktopConfigFile(),
    });
  }

  if (url.pathname === "/api/connect" && req.method === "POST") {
    const body = await readBody(req);
    if (body.target !== "desktop") {
      return sendJson(res, 400, { error: "Unknown connection target." });
    }
    const result = await connectDesktop();
    return sendJson(res, 200, result);
  }

  if (url.pathname === "/api/check" && req.method === "POST") {
    const result = await checkServer();
    return sendJson(res, 200, result);
  }

  if (url.pathname === "/api/pick-folder" && req.method === "POST") {
    const body = await readBody(req);
    const start = typeof body.start === "string" ? body.start : state.root;
    const picked = await pickFolder(start);
    if (!picked) return sendJson(res, 200, { cancelled: true });
    return sendJson(res, 200, { path: path.resolve(picked) });
  }

  if (url.pathname === "/api/open-folder" && req.method === "POST") {
    const body = await readBody(req);
    if (typeof body.path !== "string" || !body.path.trim()) {
      return sendJson(res, 400, { error: "Path is required." });
    }
    const abs = path.resolve(body.path.trim());
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat?.isDirectory()) {
      return sendJson(res, 404, { error: `Folder not found: ${abs}` });
    }
    const result = await openInExplorer(abs);
    return sendJson(res, 200, result);
  }

  return sendJson(res, 404, { error: "Not found" });
}

async function serveStatic(req, res, url) {
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400).end("Bad request");
    return;
  }
  if (pathname === "/") pathname = "/index.html";

  const file = path.resolve(PUBLIC_DIR, "." + pathname);
  const rel = path.relative(PUBLIC_DIR, file);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error("not a file");
    res.writeHead(200, {
      "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${HOST}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
    } else {
      await serveStatic(req, res, url);
    }
  } catch (e) {
    sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
});

function listen(port, attempt = 0) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off("listening", onListening);
      if (err.code === "EADDRINUSE" && attempt < MAX_PORT_TRIES) {
        resolve(listen(port + 1, attempt + 1));
      } else {
        reject(err);
      }
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, HOST);
  });
}

function openBrowser(target) {
  try {
    if (process.platform === "win32") {
      spawn("cmd.exe", ["/c", "start", "", target], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [target], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [target], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    /* just show the link */
  }
}

async function main() {
  await loadState();
  const port = await listen(BASE_PORT);
  const url = `http://${HOST}:${port}/?token=${TOKEN}`;

  console.log("");
  console.log("  Claude File Manager — folder setup");
  console.log("  --------------------------------------");
  console.log(`  UI: ${url}`);
  console.log(`  Current folder: ${state.root}`);
  console.log("");
  console.log("  Keep this window open while you use the UI.");
  console.log("  Stop: Ctrl+C");
  console.log("");

  if (!process.env.UI_NO_OPEN) openBrowser(url);

  if (UPDATE_ENABLED) {
    checkForUpdate()
      .then((info) => {
        if (!info.hasUpdate) return;
        console.log(`  Update available: ${info.current} -> ${info.latest}`);
        console.log(`  ${info.url}`);
        console.log("");
      })
      .catch(() => {});
  }
}

main().catch((e) => {
  console.error("Failed to start the UI:", e);
  process.exit(1);
});
