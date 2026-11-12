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
import { constants as fsConstants, createReadStream, existsSync } from "node:fs";
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
let state = { root: defaultRoot, allowOutside: false, allowShell: false, recent: [] };

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed.root === "string" && parsed.root.trim()) {
      state.root = path.resolve(parsed.root);
    }
    state.allowOutside = Boolean(parsed.allowOutside);
    state.allowShell = Boolean(parsed.allowShell);
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

function desktopConfigPath() {
  if (process.env.MCP_UI_DESKTOP_CONFIG) {
    return path.resolve(process.env.MCP_UI_DESKTOP_CONFIG);
  }
  if (process.platform === "win32") {
    return path.join(
      process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
      "Claude",
      "claude_desktop_config.json",
    );
  }
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json",
    );
  }
  return path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
    "Claude",
    "claude_desktop_config.json",
  );
}

function buildServerEntry() {
  const env = { MCP_FILE_ROOT: state.root };
  if (state.allowOutside) env.MCP_ALLOW_OUTSIDE_ROOT = "1";
  if (state.allowShell) env.MCP_ALLOW_SHELL = "1";
  return { command: NODE_BIN, args: [SERVER_ENTRY], env };
}

function buildConfigObject() {
  return { mcpServers: { files: buildServerEntry() } };
}

function buildCodeCommand() {
  const q = (s) => `"${s.replace(/"/g, '\\"')}"`;
  const parts = [
    "claude mcp add files",
    "--scope user",
    `--env MCP_FILE_ROOT=${q(state.root)}`,
  ];
  if (state.allowOutside) parts.push("--env MCP_ALLOW_OUTSIDE_ROOT=1");
  if (state.allowShell) parts.push("--env MCP_ALLOW_SHELL=1");
  parts.push("--", q(NODE_BIN), q(SERVER_ENTRY));
  return parts.join(" ");
}

async function connectDesktop() {
  const file = desktopConfigPath();

  let config = {};
  let existed = false;
  try {
    const raw = await fs.readFile(file, "utf8");
    existed = true;
    if (raw.trim()) {
      try {
        config = JSON.parse(raw);
      } catch {
        throw new Error(
          `Could not parse ${file}: the file contains invalid JSON. ` +
            `Fix it manually or delete it, then try again.`,
        );
      }
    }
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }

  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new Error(`Expected an object in ${file}.`);
  }
  if (!config.mcpServers || typeof config.mcpServers !== "object") {
    config.mcpServers = {};
  }

  let backup = null;
  if (existed) {
    backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await fs.copyFile(file, backup);
  }

  config.mcpServers.files = buildServerEntry();

  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(config, null, 2) + "\n", "utf8");

  return {
    message: existed
      ? "Settings updated. Fully close and reopen Claude Desktop."
      : "Configuration file created. Start Claude Desktop.",
    configPath: file,
    backup,
  };
}

/* -------------------------------------------------------------------------- */
/*                        Checks and system actions                           */
/* -------------------------------------------------------------------------- */

async function configStatus() {
  const file = desktopConfigPath();
  try {
    const config = JSON.parse(await fs.readFile(file, "utf8"));
    const entry = config?.mcpServers?.files;
    return {
      configured: Boolean(entry),
      configuredRoot: entry?.env?.MCP_FILE_ROOT || null,
      configPath: file,
    };
  } catch {
    return { configured: false, configuredRoot: null, configPath: file };
  }
}

function checkServer() {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, MCP_FILE_ROOT: state.root };
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
    const desktop = desktopConfigPath();
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
      allowOutside: state.allowOutside,
      allowShell: state.allowShell,
      recent: state.recent,
      serverEntry: SERVER_ENTRY,
      desktopConfig: desktop,
      desktopExists,
      configured: status.configured,
      configuredRoot: status.configuredRoot,
      projectRoot: PROJECT_ROOT,
      platform: process.platform,
    });
  }

  if (url.pathname === "/api/state" && req.method === "POST") {
    const body = await readBody(req);
    if (body.root !== undefined) {
      if (typeof body.root !== "string" || !body.root.trim()) {
        return sendJson(res, 400, { error: "Path is required." });
      }
      const abs = path.resolve(body.root.trim());
      let stat;
      try {
        stat = await fs.stat(abs);
      } catch {
        return sendJson(res, 404, { error: `Folder not found: ${abs}` });
      }
      if (!stat.isDirectory()) {
        return sendJson(res, 400, { error: `Not a folder: ${abs}` });
      }
      try {
        await fs.access(abs, fsConstants.R_OK | fsConstants.W_OK);
      } catch {
        return sendJson(res, 400, {
          error: `No read/write permission for ${abs}. Choose another folder.`,
        });
      }
      state.root = abs;
      state.recent = [abs, ...state.recent.filter((item) => item !== abs)].slice(0, 8);
    }
    if (body.allowOutside !== undefined) {
      state.allowOutside = Boolean(body.allowOutside);
    }
    if (body.allowShell !== undefined) {
      state.allowShell = Boolean(body.allowShell);
    }
    await saveState();
    return sendJson(res, 200, {
      root: state.root,
      allowOutside: state.allowOutside,
      allowShell: state.allowShell,
      recent: state.recent,
    });
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
      desktopConfig: desktopConfigPath(),
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
}

main().catch((e) => {
  console.error("Failed to start the UI:", e);
  process.exit(1);
});
