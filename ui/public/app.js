"use strict";

/* ------------------------------------------------------------------ helpers */

const token = new URLSearchParams(location.search).get("token") || "";

const $ = (id) => document.getElementById(id);

let current = null;
let toastTimer = null;
let savedRoot = "";
let recentList = [];

async function api(path, options = {}) {
  const headers = { "x-auth-token": token, ...(options.headers || {}) };
  if (options.body) headers["content-type"] = "application/json";

  let res;
  try {
    res = await fetch(path, { ...options, headers });
  } catch {
    throw new Error("Could not reach the local server. Is it still running?");
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Error ${res.status}`);
  }
  return data;
}

function toast(message, isError = false) {
  const el = $("toast");
  el.textContent = message;
  el.classList.toggle("err", isError);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
}

function showLog(title, lines, isError = false) {
  const log = $("log");
  log.hidden = false;
  log.classList.toggle("error", isError);
  log.textContent = "";

  const heading = document.createElement("div");
  heading.className = "log-title";
  heading.textContent = title;
  log.append(heading);

  for (const line of lines) {
    const p = document.createElement("div");
    if (line.code) {
      if (line.text) p.append(line.text + " ");
      const code = document.createElement("code");
      code.textContent = line.code;
      p.append(code);
    } else {
      p.textContent = line.text || "";
    }
    log.append(p);
  }
}

async function copyText(text, okMessage) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  toast(okMessage);
}

const FOLDER_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">' +
  '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/></svg>';

/* ------------------------------------------------------------------- render */

function renderDrives(drives, active) {
  const el = $("drives");
  el.textContent = "";
  if (!drives || drives.length <= 1) return;

  for (const drive of drives) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "drive";
    btn.textContent = drive;
    btn.disabled = active.toLowerCase().startsWith(drive.toLowerCase());
    btn.addEventListener("click", () => navigate(drive));
    el.append(btn);
  }
}

function renderCrumbs(crumbs) {
  const el = $("crumbs");
  el.textContent = "";

  crumbs.forEach((crumb, index) => {
    if (index > 0) {
      const sep = document.createElement("span");
      sep.className = "sep";
      sep.textContent = "›";
      el.append(sep);
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "crumb";
    btn.textContent = crumb.name;
    btn.title = crumb.path;
    btn.addEventListener("click", () => navigate(crumb.path));
    el.append(btn);
  });
}

function renderFolders(folders) {
  const el = $("folders");
  el.textContent = "";

  if (!folders.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No subfolders — you can use this folder.";
    el.append(empty);
    return;
  }

  for (const folder of folders) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "folder";
    btn.title = folder.path;
    btn.innerHTML = FOLDER_ICON;
    const name = document.createElement("span");
    name.textContent = folder.name;
    btn.append(name);
    btn.addEventListener("click", () => navigate(folder.path));
    el.append(btn);
  }
}

function folderName(fullPath) {
  const parts = fullPath.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : fullPath;
}

function renderRecent(recent, activePath) {
  const row = $("recentRow");
  const list = $("recent");
  list.textContent = "";

  if (!recent || !recent.length) {
    row.hidden = true;
    return;
  }
  row.hidden = false;

  for (const fullPath of recent) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.title = fullPath;
    chip.textContent = folderName(fullPath);
    if (activePath && fullPath.toLowerCase() === activePath.toLowerCase()) {
      chip.classList.add("active");
    }
    chip.addEventListener("click", () => navigate(fullPath));
    list.append(chip);
  }
}

function updateConnStatus(state) {
  const el = $("connStatus");
  const text = $("connText");

  const sameRoot =
    state.configuredRoot &&
    state.configuredRoot.toLowerCase() === String(state.root).toLowerCase();
  const otherRoot = state.configured && !sameRoot;

  el.classList.toggle("ok", Boolean(state.configured) && !otherRoot);
  el.classList.toggle("warn", Boolean(otherRoot) || (!state.configured && state.desktopExists));

  if (otherRoot) {
    text.textContent = `Connected, but to a different folder: ${state.configuredRoot}`;
  } else if (state.configured) {
    text.textContent = "Connected to Claude Desktop";
  } else if (state.desktopExists) {
    text.textContent = "The server is not added to Claude Desktop yet";
  } else {
    text.textContent = "The Claude Desktop config does not exist yet";
  }
}

/* --------------------------------------------------------------------- data */

async function navigate(target) {
  try {
    const data = await api("/api/browse?path=" + encodeURIComponent(target));
    current = data;
    $("pathInput").value = data.path;
    renderDrives(data.drives, data.path);
    renderCrumbs(data.crumbs);
    renderFolders(data.folders);
    $("up").disabled = !data.parent;

    const note = $("browseNote");
    note.hidden = !data.note;
    note.textContent = data.note || "";
    $("folders").scrollTop = 0;
    renderRecent(recentList, data.path);
  } catch (e) {
    toast(e.message, true);
  }
}

async function refreshStatus() {
  const state = await api("/api/state");
  savedRoot = state.root;
  recentList = state.recent || [];
  $("currentRoot").textContent = state.root;
  $("allowOutside").checked = state.allowOutside;
  $("allowShell").checked = state.allowShell;
  $("serverPath").textContent = state.serverEntry;
  $("configPath").textContent =
    state.desktopConfig + (state.desktopExists ? "" : " (no file yet)");
  updateConnStatus(state);
  renderRecent(recentList, current?.path || state.root);
  return state;
}

async function refreshPreview() {
  try {
    const data = await api("/api/preview");
    $("preview").textContent = data.json;
    $("serverPath").textContent = data.serverEntry;
    $("configPath").textContent = data.desktopConfig;
  } catch (e) {
    $("preview").textContent = "Could not load the config: " + e.message;
  }
}

async function setState(patch, okMessage) {
  const data = await api("/api/state", {
    method: "POST",
    body: JSON.stringify(patch),
  });
  savedRoot = data.root;
  recentList = data.recent || [];
  $("currentRoot").textContent = data.root;
  $("allowOutside").checked = data.allowOutside;
  $("allowShell").checked = data.allowShell;
  renderRecent(recentList, current?.path || data.root);
  await refreshPreview();
  updateConnStatus(await api("/api/state"));
  if (okMessage) toast(okMessage);
  return data;
}

async function init() {
  if (!token) {
    showLog("No access token", [
      { text: "Open the UI using the link printed by the server in the console." },
    ], true);
    return;
  }

  try {
    const state = await refreshStatus();
    await refreshPreview();
    await navigate(state.root);
  } catch (e) {
    showLog("Could not load the settings", [{ text: e.message }], true);
    toast(e.message, true);
  }
}

/* ------------------------------------------------------------------- events */

$("go").addEventListener("click", () => {
  const value = $("pathInput").value.trim();
  if (value) navigate(value);
});

$("pathInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    $("go").click();
  }
});

$("up").addEventListener("click", () => {
  if (current?.parent) navigate(current.parent);
});

$("pick").addEventListener("click", async () => {
  if (!current) return;
  const btn = $("pick");
  btn.disabled = true;
  try {
    await setState({ root: current.path }, "Folder saved");
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
  }
});

$("pickNative").addEventListener("click", async () => {
  const btn = $("pickNative");
  btn.disabled = true;
  btn.textContent = "Opening…";
  try {
    const result = await api("/api/pick-folder", {
      method: "POST",
      body: JSON.stringify({ start: current?.path || savedRoot }),
    });
    if (result.cancelled) return;
    await navigate(result.path);
    await setState({ root: result.path }, "Folder selected and saved");
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "Browse…";
  }
});

$("openFolder").addEventListener("click", async () => {
  if (!current) return;
  try {
    await api("/api/open-folder", {
      method: "POST",
      body: JSON.stringify({ path: current.path }),
    });
  } catch (e) {
    toast(e.message, true);
  }
});

$("checkServer").addEventListener("click", async () => {
  const btn = $("checkServer");
  const box = $("checkResult");
  btn.disabled = true;
  btn.textContent = "Checking…";
  box.hidden = false;
  box.className = "check-result";
  box.textContent = "Starting the server and requesting the tool list…";

  try {
    const result = await api("/api/check", {
      method: "POST",
      body: JSON.stringify({}),
    });
    box.className = "check-result ok";
    box.textContent = `Server responds. Tools: ${result.count}.`;

    const tools = document.createElement("div");
    tools.className = "check-tools";
    tools.textContent = result.tools.join(", ");
    box.append(tools);

    toast("Server is running");
  } catch (e) {
    box.className = "check-result err";
    box.textContent = e.message;
    toast(e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "Check server";
  }
});

$("allowOutside").addEventListener("change", async (e) => {
  try {
    await setState({ allowOutside: e.target.checked }, "Setting saved");
  } catch (err) {
    e.target.checked = !e.target.checked;
    toast(err.message, true);
  }
});

$("allowShell").addEventListener("change", async (e) => {
  try {
    await setState({ allowShell: e.target.checked }, "Setting saved");
  } catch (err) {
    e.target.checked = !e.target.checked;
    toast(err.message, true);
  }
});

$("connectDesktop").addEventListener("click", async () => {
  const btn = $("connectDesktop");
  btn.disabled = true;
  btn.textContent = "Connecting…";
  try {
    const result = await api("/api/connect", {
      method: "POST",
      body: JSON.stringify({ target: "desktop" }),
    });
    const lines = [{ text: result.message }];
    lines.push({ text: "Config:", code: result.configPath });
    if (result.backup) lines.push({ text: "Backup:", code: result.backup });
    showLog("Done", lines);
    await refreshStatus();
    toast("Claude Desktop is configured");
  } catch (e) {
    showLog("Could not write the config", [{ text: e.message }], true);
    toast(e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "Connect to Claude Desktop";
  }
});

$("copyConfig").addEventListener("click", async () => {
  try {
    const data = await api("/api/preview");
    await copyText(data.json, "JSON config copied");
  } catch (e) {
    toast(e.message, true);
  }
});

$("copyCode").addEventListener("click", async () => {
  try {
    const data = await api("/api/preview");
    await copyText(data.command, "Claude Code command copied");
  } catch (e) {
    toast(e.message, true);
  }
});

init();
