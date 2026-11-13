"use strict";

/* ------------------------------------------------------------------ helpers */

const token = new URLSearchParams(location.search).get("token") || "";

const $ = (id) => document.getElementById(id);

let current = null;
let toastTimer = null;
let savedRoot = "";
let recentList = [];
let extraRoots = [];
let history = null;
let activeTab = "trash";

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

function sameFolder(a, b) {
  if (!a || !b) return false;
  return a.replace(/[\\/]+$/, "").toLowerCase() ===
    b.replace(/[\\/]+$/, "").toLowerCase();
}

function updateConnStatus(state) {
  const el = $("connStatus");
  const text = $("connText");

  const roots = state.roots && state.roots.length ? state.roots : [state.root];
  const configured = state.configuredRoots && state.configuredRoots.length
    ? state.configuredRoots
    : state.configuredRoot
      ? [state.configuredRoot]
      : [];
  const sameRoots =
    configured.length === roots.length &&
    configured.every((item, index) => sameFolder(item, roots[index]));
  const otherRoot = state.configured && !sameRoots;

  el.classList.toggle("ok", Boolean(state.configured) && !otherRoot);
  el.classList.toggle("warn", Boolean(otherRoot) || (!state.configured && state.desktopExists));

  if (otherRoot) {
    text.textContent = `Connected, but to different folders: ${configured.join(", ")}`;
  } else if (state.configured) {
    text.textContent = "Connected to Claude Desktop";
  } else if (state.desktopExists) {
    text.textContent = "The server is not added to Claude Desktop yet";
  } else {
    text.textContent = "The Claude Desktop config does not exist yet";
  }
}

function renderExtraRoots() {
  const list = $("extraRoots");
  list.textContent = "";

  if (!extraRoots.length) {
    const empty = document.createElement("p");
    empty.className = "root-empty";
    empty.textContent = "None yet — the working folder above is the only one.";
    list.append(empty);
    return;
  }

  for (const item of extraRoots) {
    const row = document.createElement("div");
    row.className = "root-item";

    const code = document.createElement("code");
    code.textContent = item;
    code.title = item;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ghost";
    btn.textContent = "Remove";
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await setState({ removeRoot: item }, "Folder removed");
      } catch (e) {
        toast(e.message, true);
      } finally {
        btn.disabled = false;
      }
    });

    row.append(code, btn);
    list.append(row);
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "…";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = -1;
  do {
    value /= 1024;
    index += 1;
  } while (value >= 1024 && index < units.length - 1);
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatDate(value) {
  if (!value) return "unknown time";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown time";
  return date.toLocaleString();
}

function historyRow({ title, sub, tag, action }) {
  const row = document.createElement("div");
  row.className = "history-row";

  const main = document.createElement("div");
  main.className = "history-main";

  const titleEl = document.createElement("div");
  titleEl.className = "history-title";
  titleEl.textContent = title;
  if (tag) {
    const tagEl = document.createElement("span");
    tagEl.className = "history-tag";
    tagEl.textContent = tag;
    titleEl.append(tagEl);
  }
  main.append(titleEl);

  if (sub) {
    const subEl = document.createElement("div");
    subEl.className = "history-sub";
    subEl.textContent = sub;
    main.append(subEl);
  }

  row.append(main);
  if (action) row.append(action);
  return row;
}

function makeRestoreButton(label, handler) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ghost history-action";
  btn.textContent = label;
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      await handler();
    } finally {
      btn.disabled = false;
    }
  });
  return btn;
}

async function restoreTrashEntry(id) {
  try {
    const result = await api("/api/trash/restore", {
      method: "POST",
      body: JSON.stringify({ id }),
    });
    toast(
      result.replacedTrashId
        ? "Restored — the replaced item was moved to the trash"
        : "Restored from the trash",
    );
    await loadHistory();
  } catch (e) {
    if (/already exists/i.test(e.message) && confirm(`${e.message}\n\nReplace it?`)) {
      try {
        await api("/api/trash/restore", {
          method: "POST",
          body: JSON.stringify({ id, overwrite: true }),
        });
        toast("Restored and replaced the existing item");
        await loadHistory();
      } catch (err) {
        toast(err.message, true);
      }
      return;
    }
    toast(e.message, true);
  }
}

async function restoreBackupEntry(name) {
  try {
    await api("/api/backup/restore", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    toast("Backup restored — the previous version was saved as a new backup");
    await loadHistory();
  } catch (e) {
    toast(e.message, true);
  }
}

const HISTORY_EMPTY = {
  trash: "The trash is empty.",
  backups: "No backups yet. Backups appear when Claude edits or replaces files.",
  commands: "No commands have been run by the server yet.",
  activity: "No activity recorded yet.",
};

function renderHistory() {
  const body = $("historyBody");
  body.textContent = "";

  if (!history) return;
  const items = history[activeTab] || [];

  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    empty.textContent = HISTORY_EMPTY[activeTab] || "Nothing here yet.";
    body.append(empty);
    return;
  }

  for (const item of items) {
    if (activeTab === "trash") {
      body.append(
        historyRow({
          title: folderName(item.originalPath),
          tag: item.type,
          sub: `${formatDate(item.deletedAt)} · ${item.originalPath}`,
          action: item.exists
            ? makeRestoreButton("Restore", () => restoreTrashEntry(item.id))
            : null,
        }),
      );
    } else if (activeTab === "backups") {
      body.append(
        historyRow({
          title: item.target ? folderName(item.target) : item.name,
          sub:
            `${item.target || "Target unknown — use undo_last_change in Claude"} · ` +
            `${formatBytes(item.size)} · ${formatDate(item.modified)}`,
          action: item.target
            ? makeRestoreButton("Restore", () => restoreBackupEntry(item.name))
            : null,
        }),
      );
    } else if (activeTab === "commands") {
      const isEvent = Boolean(item.event);
      const title = isEvent
        ? `${item.event}: ${item.command || item.id}`
        : item.command || "(no command)";
      const parts = [formatDate(item.at)];
      if (item.cwd) parts.push(item.cwd);
      if (item.exitCode !== undefined && item.exitCode !== null) {
        parts.push(`exit ${item.exitCode}`);
      }
      if (item.timedOut) parts.push("timed out");
      if (item.durationMs) parts.push(`${item.durationMs} ms`);
      body.append(historyRow({ title, tag: isEvent ? item.event : null, sub: parts.join(" · ") }));
    } else {
      body.append(
        historyRow({
          title: item.description || item.kind,
          tag: item.kind,
          sub: formatDate(item.at),
        }),
      );
    }
  }
}

async function loadHistory() {
  try {
    history = await api("/api/history");
    $("historyDataDir").textContent = "Data folder: " + history.dataDir;
    $("countTrash").textContent = history.trash.length;
    $("countBackups").textContent = history.backups.length;
    $("countCommands").textContent = history.commands.length;
    $("countActivity").textContent = history.activity.length;
    renderHistory();
  } catch (e) {
    history = null;
    $("historyBody").textContent = "";
    const empty = document.createElement("div");
    empty.className = "history-empty";
    empty.textContent = "Could not load the history: " + e.message;
    $("historyBody").append(empty);
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
  extraRoots = state.extraRoots || [];
  $("currentRoot").textContent = state.root;
  $("allowOutside").checked = state.allowOutside;
  $("allowShell").checked = state.allowShell;
  $("serverPath").textContent = state.serverEntry;
  $("configPath").textContent =
    state.desktopConfig + (state.desktopExists ? "" : " (no file yet)");
  renderExtraRoots();
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
  extraRoots = data.extraRoots || [];
  $("currentRoot").textContent = data.root;
  $("allowOutside").checked = data.allowOutside;
  $("allowShell").checked = data.allowShell;
  renderExtraRoots();
  renderRecent(recentList, current?.path || data.root);
  await refreshPreview();
  updateConnStatus(await api("/api/state"));
  await loadHistory();
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
    await loadHistory();
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

async function addExtraRoot(value) {
  if (!value || !value.trim()) {
    toast("Enter a folder path first", true);
    return;
  }
  await setState({ addRoot: value.trim() }, "Folder added");
}

$("addRoot").addEventListener("click", async () => {
  const btn = $("addRoot");
  btn.disabled = true;
  try {
    await addExtraRoot($("extraRootInput").value);
    $("extraRootInput").value = "";
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
  }
});

$("extraRootInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    $("addRoot").click();
  }
});

$("addCurrentRoot").addEventListener("click", async () => {
  if (!current) return;
  const btn = $("addCurrentRoot");
  btn.disabled = true;
  try {
    await addExtraRoot(current.path);
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
  }
});

for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => {
    activeTab = tab.dataset.tab || "trash";
    for (const other of document.querySelectorAll(".tab")) {
      other.classList.toggle("active", other === tab);
    }
    renderHistory();
  });
}

$("refreshHistory").addEventListener("click", async () => {
  const btn = $("refreshHistory");
  btn.disabled = true;
  btn.textContent = "Loading…";
  try {
    await loadHistory();
  } finally {
    btn.disabled = false;
    btn.textContent = "Refresh";
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

/* ------------------------------------------------------------------ updates */

const DISMISS_KEY = "cfm-update-dismissed";

function updateSize(n) {
  if (!n) return "";
  return n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";
}

function renderUpdate(info, manual) {
  $("appVersion").textContent = info.current ? "v" + info.current : "";
  const banner = $("updateBanner");

  if (manual) {
    if (!info.enabled) toast("Update check is turned off (UI_NO_UPDATE_CHECK=1).", true);
    else if (info.error) toast(info.error, true);
    else if (info.noReleases) toast("No releases have been published yet.");
    else if (!info.hasUpdate) toast("You have the latest version" + (info.current ? " (v" + info.current + ")" : "") + ".");
  }

  if (!info.hasUpdate) {
    banner.hidden = true;
    return;
  }

  let dismissed = null;
  try {
    dismissed = localStorage.getItem(DISMISS_KEY);
  } catch {
    /* storage unavailable */
  }
  if (!manual && dismissed === info.tag) return;

  $("updateTitle").textContent = "Update available: v" + info.current + " → v" + info.latest;
  const meta = [];
  if (info.publishedAt) meta.push(new Date(info.publishedAt).toLocaleDateString());
  $("updateMeta").textContent = meta.join(" · ");
  $("updateLink").href = info.url;

  const installer = (info.assets || []).find((a) => /\.(exe|msi)$/i.test(a.name)) || (info.assets || [])[0];
  const download = $("updateDownload");
  if (installer) {
    download.href = installer.url;
    download.textContent = "Download " + installer.name + (installer.size ? " (" + updateSize(installer.size) + ")" : "");
    download.hidden = false;
  } else {
    download.hidden = true;
  }

  banner.dataset.tag = info.tag;
  banner.hidden = false;
}

async function checkUpdate(manual = false) {
  const btn = $("checkUpdate");
  if (manual) {
    btn.disabled = true;
    btn.textContent = "Checking…";
  }
  try {
    renderUpdate(await api("/api/update" + (manual ? "?force=1" : "")), manual);
  } catch (e) {
    if (manual) toast(e.message, true);
  } finally {
    if (manual) {
      btn.disabled = false;
      btn.textContent = "Check for updates";
    }
  }
}

$("checkUpdate").addEventListener("click", () => checkUpdate(true));
$("updateDismiss").addEventListener("click", () => {
  const banner = $("updateBanner");
  try {
    localStorage.setItem(DISMISS_KEY, banner.dataset.tag || "");
  } catch {
    /* storage unavailable */
  }
  banner.hidden = true;
});

checkUpdate(false);
init();
