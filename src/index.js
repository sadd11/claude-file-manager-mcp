#!/usr/bin/env node
/**
 * MCP server for managing files and folders.
 *
 * Tools:
 *   list_directory, list_tree, list_roots, read_file, read_image, write_file,
 *   append_file, edit_file, multi_edit, replace_in_files, create_directory,
 *   move_path, copy_path, zip_path, unzip_path, delete_path, file_info,
 *   find_files, search_content, list_trash, restore_path, undo_last_change
 *   and, when MCP_ALLOW_SHELL=1: run_command, start_process, read_output,
 *   stop_process, list_processes.
 *
 * Safety:
 *   All operations are limited to MCP_FILE_ROOTS (falls back to
 *   MCP_FILE_ROOT, then the current working directory). To allow arbitrary
 *   paths, set MCP_ALLOW_OUTSIDE_ROOT=1.
 *   The terminal tools are only registered when MCP_ALLOW_SHELL=1 is set.
 *   Commands run with the rights of the current user and are not sandboxed.
 *
 * Trash and backups are stored in <first root>/.mcp.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { spawn, spawnSync } from "node:child_process";

/**
 * Allowed folders. MCP_FILE_ROOTS is a list separated by the platform path
 * delimiter (";" on Windows, ":" elsewhere); relative paths resolve against
 * the first one.
 */
const ROOTS = (() => {
  const raw = (process.env.MCP_FILE_ROOTS || "").trim();
  const items = raw
    ? raw.split(path.delimiter).map((item) => item.trim()).filter(Boolean)
    : [process.env.MCP_FILE_ROOT || process.cwd()];

  const seen = new Set();
  const roots = [];
  for (const item of items) {
    const abs = path.resolve(item);
    const key = process.platform === "win32" ? abs.toLowerCase() : abs;
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(abs);
  }
  return roots.length ? roots : [process.cwd()];
})();
const ROOT = ROOTS[0];
const ALLOW_OUTSIDE = /^(1|true|yes)$/i.test(
  process.env.MCP_ALLOW_OUTSIDE_ROOT || "",
);
const MAX_READ_CHARS = Number(process.env.MCP_MAX_READ_CHARS || 400_000);
const MAX_LIST_ENTRIES = Number(process.env.MCP_MAX_LIST_ENTRIES || 5_000);
const MAX_IMAGE_BYTES = Number(process.env.MCP_MAX_IMAGE_BYTES || 5_000_000);
const ALLOW_SHELL = /^(1|true|yes)$/i.test(process.env.MCP_ALLOW_SHELL || "");
const MAX_OUTPUT_CHARS = Number(process.env.MCP_MAX_OUTPUT_CHARS || 200_000);
const SHELL_TIMEOUT_DEFAULT = 30_000;
const SHELL_TIMEOUT_MAX = 300_000;
const MAX_BG_PROCESSES = Number(process.env.MCP_MAX_PROCESSES || 8);
const MAX_PROCESS_BUFFER = Number(process.env.MCP_MAX_PROCESS_BUFFER || 100_000);
const MAX_ARCHIVE_BYTES = Number(process.env.MCP_MAX_ARCHIVE_BYTES || 500_000_000);

const DATA_DIR = process.env.MCP_DATA_DIR
  ? path.resolve(process.env.MCP_DATA_DIR)
  : path.join(ROOT, ".mcp");
const TRASH_DIR = path.join(DATA_DIR, "trash");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const TRASH_INDEX = path.join(DATA_DIR, "trash.json");
const ACTIVITY_FILE = path.join(DATA_DIR, "activity.json");
const SHELL_LOG = path.join(DATA_DIR, "commands.log");

/** Every folder that belongs to the server, plus the shared data folder. */
const PROTECTED_DIRS = [...new Set([DATA_DIR, ...ROOTS.map((root) => path.join(root, ".mcp"))])];

const DEFAULT_IGNORES = ["node_modules", ".git", ".mcp", ".svn", ".hg"];
const MAX_ACTIVITY = 100;

/* -------------------------------------------------------------------------- */
/*                                   Utilities                                */
/* -------------------------------------------------------------------------- */

function rootOf(abs) {
  for (const root of ROOTS) {
    const rel = path.relative(root, abs);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return root;
  }
  return null;
}

function insideRoots(abs) {
  return rootOf(abs) !== null;
}

function formatRootList() {
  return ROOTS.map((root) => `  • ${root}`).join("\n");
}

function resolvePath(input, { allowRoot = true } = {}) {
  if (typeof input !== "string" || input.trim() === "") {
    throw new Error("Path is required.");
  }

  const target = input.trim();
  const abs = path.isAbsolute(target)
    ? path.resolve(target)
    : path.resolve(ROOT, target);

  if (!allowRoot && ROOTS.includes(abs)) {
    throw new Error(`A root folder cannot be modified: ${abs}`);
  }

  if (!ALLOW_OUTSIDE && !insideRoots(abs)) {
    throw new Error(
      `Path is outside the allowed folders: ${abs}\nAllowed folders:\n${formatRootList()}\n` +
        `To allow other paths, set MCP_ALLOW_OUTSIDE_ROOT=1.`,
    );
  }

  return abs;
}

function assertNotData(abs) {
  for (const dir of PROTECTED_DIRS) {
    const rel = path.relative(dir, abs);
    const inside =
      abs === dir || (!rel.startsWith("..") && !path.isAbsolute(rel) && rel !== "");
    if (inside) {
      throw new Error(
        `Service folder ${dir} is protected: it contains the trash and backups.`,
      );
    }
  }
}

function formatBytes(n) {
  if (!Number.isFinite(n)) return "?";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n;
  let i = -1;
  do {
    value /= 1024;
    i += 1;
  } while (value >= 1024 && i < units.length - 1);
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}

function isProbablyBinary(buf) {
  const sample = buf.subarray(0, Math.min(buf.length, 8000));
  for (const byte of sample) {
    if (byte === 0) return true;
  }
  return false;
}

function text(value) {
  return { content: [{ type: "text", text: value }] };
}

const IMAGE_MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function fail(error) {
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: "text", text: `Error: ${message}` }] };
}

async function statOrNull(p) {
  try {
    return await fs.lstat(p);
  } catch {
    return null;
  }
}

function newId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}

function shortName(abs) {
  const root = rootOf(abs);
  if (!root) return abs;
  const rel = path.relative(root, abs);
  return rel === "" ? "." : rel;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${newId()}`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(tmp, file);
}

/* ------------------------------- activity --------------------------------- */

async function recordActivity(kind, description, undo) {
  const log = await readJson(ACTIVITY_FILE, { items: [] });
  if (!Array.isArray(log.items)) log.items = [];
  log.items.push({
    at: new Date().toISOString(),
    kind,
    description,
    undo: undo || null,
  });
  if (log.items.length > MAX_ACTIVITY) {
    log.items = log.items.slice(-MAX_ACTIVITY);
  }
  await writeJson(ACTIVITY_FILE, log);
}

async function backupFile(abs) {
  const stat = await statOrNull(abs);
  if (!stat || stat.isDirectory()) return null;
  await fs.mkdir(BACKUP_DIR, { recursive: true });
  const dest = path.join(BACKUP_DIR, `${newId()}__${path.basename(abs)}`);
  await fs.copyFile(abs, dest);
  return dest;
}

/* ---------------------------------- trash --------------------------------- */

async function moveToTrash(abs, type) {
  await fs.mkdir(TRASH_DIR, { recursive: true });
  const id = newId();
  const dest = path.join(TRASH_DIR, `${id}__${path.basename(abs)}`);

  try {
    await fs.rename(abs, dest);
  } catch (e) {
    if (e.code !== "EXDEV") throw e;
    await fs.cp(abs, dest, { recursive: true });
    await fs.rm(abs, { recursive: true, force: true });
  }

  const index = await readJson(TRASH_INDEX, { items: [] });
  if (!Array.isArray(index.items)) index.items = [];
  index.items.push({
    id,
    originalPath: abs,
    trashPath: dest,
    type,
    deletedAt: new Date().toISOString(),
  });
  await writeJson(TRASH_INDEX, index);
  return { id, dest };
}

async function takeTrashItem(id) {
  const index = await readJson(TRASH_INDEX, { items: [] });
  const items = Array.isArray(index.items) ? index.items : [];
  const pos = items.findIndex((item) => item.id === id);
  if (pos === -1) throw new Error(`No trash entry with id "${id}".`);
  const [item] = items.splice(pos, 1);
  index.items = items;
  await writeJson(TRASH_INDEX, index);
  return item;
}

async function restoreTrashItem(id, overwrite = false) {
  const index = await readJson(TRASH_INDEX, { items: [] });
  const item = (index.items || []).find((entry) => entry.id === id);
  if (!item) throw new Error(`No trash entry with id "${id}".`);

  const destStat = await statOrNull(item.originalPath);
  if (destStat) {
    if (!overwrite) {
      throw new Error(
        `Something already exists at the original path: ${item.originalPath}. ` +
          `Set overwrite=true to replace it.`,
      );
    }
    await fs.rm(item.originalPath, { recursive: true, force: true });
  }

  await fs.mkdir(path.dirname(item.originalPath), { recursive: true });

  try {
    await fs.rename(item.trashPath, item.originalPath);
  } catch (e) {
    if (e.code !== "EXDEV") throw e;
    await fs.cp(item.trashPath, item.originalPath, { recursive: true });
    await fs.rm(item.trashPath, { recursive: true, force: true });
  }

  await takeTrashItem(id);
  return item;
}

/* ----------------------------- glob / traversal --------------------------- */

function globToRegExp(glob) {
  const source = glob.replace(/\\/g, "/");
  let re = "^";

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (char === "*") {
      if (source[i + 1] === "*") {
        if (source[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (char === "?") {
      re += "[^/]";
    } else if ("+^${}()|[]\\".includes(char)) {
      re += "\\" + char;
    } else {
      re += char;
    }
  }

  re += "$";
  return new RegExp(re, process.platform === "win32" ? "i" : "");
}

function hasWildcard(value) {
  return /[*?[\]]/.test(value);
}

function normalizeRel(p) {
  return p.split(path.sep).join("/");
}

async function walkTree(start, options) {
  const {
    maxDepth = 20,
    maxEntries = 50_000,
    ignore = DEFAULT_IGNORES,
    extraIgnore = [],
    onFile,
    onDir,
  } = options;

  let visited = 0;
  let stopped = false;

  async function rec(dir, depth) {
    if (stopped) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (stopped) return;
      visited += 1;
      if (visited > maxEntries) {
        stopped = true;
        return;
      }

      const name = entry.name;
      if (ignore.includes(name)) continue;
      if (extraIgnore.some((pattern) => globToRegExp(pattern).test(name))) {
        continue;
      }

      const full = path.join(dir, name);

      if (entry.isDirectory()) {
        if (onDir) await onDir(full, entry, depth);
        if (depth + 1 < maxDepth) await rec(full, depth + 1);
      } else if (entry.isFile()) {
        if (onFile) await onFile(full, entry, depth);
      }
    }
  }

  await rec(start, 0);
  return { visited, stopped };
}

/* ---------------------------------- diff ---------------------------------- */

function summarizeChanges(oldText, newText, maxLines = 60) {
  const before = oldText.split(/\r?\n/);
  const after = newText.split(/\r?\n/);

  let start = 0;
  while (
    start < before.length &&
    start < after.length &&
    before[start] === after[start]
  ) {
    start += 1;
  }

  let endBefore = before.length - 1;
  let endAfter = after.length - 1;
  while (
    endBefore >= start &&
    endAfter >= start &&
    before[endBefore] === after[endAfter]
  ) {
    endBefore -= 1;
    endAfter -= 1;
  }

  if (start > endBefore && start > endAfter) return "No changes.";

  const lines = [];
  const contextStart = Math.max(0, start - 2);
  for (let i = contextStart; i < start; i += 1) lines.push("  " + before[i]);
  for (let i = start; i <= endBefore; i += 1) lines.push("- " + before[i]);
  for (let i = start; i <= endAfter; i += 1) lines.push("+ " + after[i]);
  const contextEnd = Math.min(after.length, endAfter + 3);
  for (let i = endAfter + 1; i < contextEnd; i += 1) lines.push("  " + after[i]);

  const removed = Math.max(0, endBefore - start + 1);
  const added = Math.max(0, endAfter - start + 1);
  const clipped =
    lines.length > maxLines
      ? lines.slice(0, maxLines).concat([`… ${lines.length - maxLines} more lines`])
      : lines;

  return `-${removed} / +${added}\n${clipped.join("\n")}`;
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let index = 0;
  while ((index = haystack.indexOf(needle, index)) !== -1) {
    count += 1;
    index += needle.length;
  }
  return count;
}

/* ---------------------------------- shell --------------------------------- */

/* ----------------------------------- zip ---------------------------------- */

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

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time:
      (date.getHours() << 11) |
      (date.getMinutes() << 5) |
      Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

async function collectZipEntries(sources) {
  const entries = [];
  const names = new Set();
  let totalBytes = 0;
  let skippedLinks = 0;

  function push(entry) {
    if (names.has(entry.name)) {
      throw new Error(
        `Duplicate archive entry "${entry.name}". Two sources have the same name — rename one of them.`,
      );
    }
    names.add(entry.name);
    entries.push(entry);
  }

  async function add(abs, name) {
    const stat = await statOrNull(abs);
    if (!stat) throw new Error(`Source not found: ${abs}`);
    if (stat.isSymbolicLink()) {
      skippedLinks += 1;
      return;
    }

    if (stat.isDirectory()) {
      let children = [];
      try {
        children = await fs.readdir(abs);
      } catch {
        /* unreadable folder: keep going */
      }
      if (!children.length) push({ abs, name: `${name}/`, dir: true, stat });
      for (const child of children) {
        await add(path.join(abs, child), `${name}/${child}`);
      }
      return;
    }

    totalBytes += stat.size;
    if (totalBytes > MAX_ARCHIVE_BYTES) {
      throw new Error(
        `The sources are larger than ${formatBytes(MAX_ARCHIVE_BYTES)}; ` +
          `increase MCP_MAX_ARCHIVE_BYTES to zip them.`,
      );
    }
    push({ abs, name, dir: false, stat, size: stat.size });
  }

  for (const source of sources) {
    const abs = resolvePath(source);
    if (ROOTS.includes(abs)) {
      throw new Error(
        `Refusing to zip a whole root folder (${abs}). Zip its subfolders instead.`,
      );
    }
    assertNotData(abs);
    const base = path.basename(abs);
    if (!base) throw new Error(`Cannot zip ${abs}: empty folder name.`);
    await add(abs, base);
  }

  return { entries, totalBytes, skippedLinks };
}

async function writeZip(entries, destination) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    let raw = Buffer.alloc(0);
    let compressed = raw;
    let method = 0;
    let crc = 0;

    if (!entry.dir) {
      raw = await fs.readFile(entry.abs);
      crc = crc32(raw);
      compressed = raw;
      const deflated = zlib.deflateRawSync(raw, { level: 6 });
      if (deflated.length < raw.length) {
        compressed = deflated;
        method = 8;
      }
    }

    const nameBuf = Buffer.from(entry.name, "utf8");
    const flags = /[^\x00-\x7f]/.test(entry.name) ? 0x0800 : 0;
    const { time, date } = dosDateTime(entry.stat.mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBuf, compressed);
    central.push({
      nameBuf,
      flags,
      method,
      time,
      date,
      crc,
      compressedSize: compressed.length,
      size: raw.length,
      offset,
      dir: entry.dir,
    });
    offset += local.length + nameBuf.length + compressed.length;
  }

  const centralStart = offset;
  for (const item of central) {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(item.flags, 8);
    header.writeUInt16LE(item.method, 10);
    header.writeUInt16LE(item.time, 12);
    header.writeUInt16LE(item.date, 14);
    header.writeUInt32LE(item.crc, 16);
    header.writeUInt32LE(item.compressedSize, 20);
    header.writeUInt32LE(item.size, 24);
    header.writeUInt16LE(item.nameBuf.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(item.dir ? 0x10 : 0, 38);
    header.writeUInt32LE(item.offset, 42);
    chunks.push(header, item.nameBuf);
    offset += header.length + item.nameBuf.length;
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(offset - centralStart, 12);
  eocd.writeUInt32LE(centralStart, 16);

  await fs.writeFile(destination, Buffer.concat([...chunks, eocd]));
  return { size: offset + eocd.length };
}

async function readZip(source) {
  const buf = await fs.readFile(source);
  if (buf.length > MAX_ARCHIVE_BYTES) {
    throw new Error(`Archive is larger than ${formatBytes(MAX_ARCHIVE_BYTES)}.`);
  }

  const min = Math.max(0, buf.length - 66_000);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) {
    throw new Error("Not a ZIP archive: the end of the central directory was not found.");
  }

  const count = buf.readUInt16LE(eocd + 10);
  const centralOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || centralOffset === 0xffffffff) {
    throw new Error("ZIP64 archives are not supported.");
  }

  const entries = [];
  let pointer = centralOffset;
  for (let i = 0; i < count; i += 1) {
    if (
      pointer + 46 > buf.length ||
      buf.readUInt32LE(pointer) !== 0x02014b50
    ) {
      throw new Error("The ZIP central directory is damaged.");
    }

    const flags = buf.readUInt16LE(pointer + 8);
    const method = buf.readUInt16LE(pointer + 10);
    const crc = buf.readUInt32LE(pointer + 16);
    const compressedSize = buf.readUInt32LE(pointer + 20);
    const size = buf.readUInt32LE(pointer + 24);
    const nameLength = buf.readUInt16LE(pointer + 28);
    const extraLength = buf.readUInt16LE(pointer + 30);
    const commentLength = buf.readUInt16LE(pointer + 32);
    const localOffset = buf.readUInt32LE(pointer + 42);
    const name = buf
      .subarray(pointer + 46, pointer + 46 + nameLength)
      .toString("utf8");

    if (flags & 0x1) throw new Error(`Encrypted entries are not supported: ${name}`);
    if (method !== 0 && method !== 8) {
      throw new Error(`Unsupported compression method ${method} for ${name}.`);
    }
    if (
      compressedSize === 0xffffffff ||
      size === 0xffffffff ||
      localOffset === 0xffffffff
    ) {
      throw new Error("ZIP64 archives are not supported.");
    }

    entries.push({
      name,
      method,
      crc,
      compressedSize,
      size,
      localOffset,
      dir: name.endsWith("/") || name.endsWith("\\"),
    });
    pointer += 46 + nameLength + extraLength + commentLength;
  }

  return { buf, entries };
}

function safeZipTarget(destination, name) {
  const clean = name.replace(/\\/g, "/");
  if (clean.startsWith("/") || /^[A-Za-z]:/.test(clean)) {
    throw new Error(`Unsafe archive path: ${name}`);
  }
  const target = path.resolve(destination, clean);
  const rel = path.relative(destination, target);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Unsafe archive path: ${name}`);
  }
  return target;
}

async function extractZip(archive, destination, overwrite) {
  const { buf, entries } = await readZip(archive);
  if (entries.length > 20_000) throw new Error("Archive has too many entries (max 20000).");

  let totalSize = 0;
  const planned = entries.map((entry) => {
    totalSize += entry.size;
    if (totalSize > MAX_ARCHIVE_BYTES) {
      throw new Error(
        `Archive expands to more than ${formatBytes(MAX_ARCHIVE_BYTES)}.`,
      );
    }
    return { ...entry, target: safeZipTarget(destination, entry.name) };
  });

  if (!overwrite) {
    const clashes = [];
    for (const item of planned) {
      if (await statOrNull(item.target)) clashes.push(item.name);
      if (clashes.length >= 5) break;
    }
    if (clashes.length) {
      throw new Error(
        `These paths already exist: ${clashes.join(", ")}. ` +
          `Set overwrite=true to replace them.`,
      );
    }
  }

  let files = 0;
  let folders = 0;
  let bytes = 0;

  for (const item of planned) {
    if (item.dir) {
      await fs.mkdir(item.target, { recursive: true });
      folders += 1;
      continue;
    }

    const pointer = item.localOffset;
    if (pointer + 30 > buf.length || buf.readUInt32LE(pointer) !== 0x04034b50) {
      throw new Error(`Damaged entry in the archive: ${item.name}`);
    }
    const nameLength = buf.readUInt16LE(pointer + 26);
    const extraLength = buf.readUInt16LE(pointer + 28);
    const start = pointer + 30 + nameLength + extraLength;
    const data = buf.subarray(start, start + item.compressedSize);

    let content;
    if (item.method === 8) {
      try {
        content = zlib.inflateRawSync(data);
      } catch {
        throw new Error(`Could not decompress ${item.name}: the archive is damaged.`);
      }
    } else {
      content = data;
    }

    if (content.length !== item.size) {
      throw new Error(`Size mismatch for ${item.name}: the archive is damaged.`);
    }
    if (!item.dir && crc32(content) !== item.crc) {
      throw new Error(`CRC mismatch for ${item.name}: the archive is damaged.`);
    }

    await fs.mkdir(path.dirname(item.target), { recursive: true });
    await fs.writeFile(item.target, content);
    files += 1;
    bytes += content.length;
  }

  return { files, folders, bytes, entries: planned.length };
}

const SHELL_MODE = (
  process.env.MCP_SHELL || (process.platform === "win32" ? "powershell" : "sh")
).toLowerCase();

/**
 * Builds the platform shell invocation for a command string.
 *
 * On Windows the default is PowerShell with `-EncodedCommand` (UTF-16LE), so
 * Cyrillic and other non-ASCII text survives in both directions — cmd.exe
 * mangles such arguments down to the OEM code page. Set MCP_SHELL=cmd to use
 * cmd.exe instead, or MCP_SHELL=pwsh for PowerShell 7.
 */
function shellInvocation(command) {
  if (process.platform === "win32") {
    if (SHELL_MODE === "cmd") {
      return {
        file: process.env.ComSpec || "cmd.exe",
        args: ["/d", "/s", "/c", command],
        shellName: "cmd",
      };
    }

    const script = [
      "$ProgressPreference = 'SilentlyContinue'",
      "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
      "$OutputEncoding = [System.Text.Encoding]::UTF8",
      "$global:LASTEXITCODE = 0",
      command,
      "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
      "if ($Error.Count -gt 0) { exit 1 }",
    ].join("\r\n");

    return {
      file: SHELL_MODE === "pwsh" ? "pwsh.exe" : "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-OutputFormat",
        "Text",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      shellName: SHELL_MODE === "pwsh" ? "pwsh" : "powershell",
    };
  }

  return {
    file: SHELL_MODE === "bash" ? "bash" : "/bin/sh",
    args: ["-c", command],
    shellName: SHELL_MODE === "bash" ? "bash" : "sh",
  };
}

function killProcessTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* ignore */
    }
  }
}

function appendCapped(state, chunk) {
  if (state.truncated) return;
  const next = state.text + chunk;
  if (next.length > MAX_OUTPUT_CHARS) {
    state.text = next.slice(0, MAX_OUTPUT_CHARS);
    state.truncated = true;
    return;
  }
  state.text = next;
}

/**
 * powershell.exe serializes its error stream as CLIXML when stderr is a pipe.
 * Turn that back into plain text so Claude sees readable messages.
 */
function decodePowerShellStderr(raw) {
  if (!raw.startsWith("#< CLIXML")) return raw;

  const parts = [...raw.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map((m) => m[1]);
  const source = parts.length ? parts.join("") : raw;

  return source
    .replace(/_x000D__x000A_/g, "\n")
    .replace(/_x000D_/g, "\r")
    .replace(/_x000A_/g, "\n")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

function runCommand(command, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    const { file, args, shellName } = shellInvocation(command);
    const startedAt = Date.now();

    const child = spawn(file, args, {
      cwd,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        // Keep child output stable across platforms.
        GIT_PAGER: "cat",
        PAGER: "cat",
        NO_COLOR: "1",
        TERM: "dumb",
      },
    });

    const out = { text: "", truncated: false };
    const err = { text: "", truncated: false };
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid);
    }, timeoutMs);

    function finish(code, signal, spawnError) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;
      const stderrText =
        shellName.startsWith("powershell") || shellName === "pwsh"
          ? decodePowerShellStderr(err.text)
          : err.text;
      resolve({
        command,
        cwd,
        shell: shellName,
        code: typeof code === "number" ? code : null,
        signal: signal || null,
        timedOut,
        durationMs,
        stdout: out.text,
        stdoutTruncated: out.truncated,
        stderr: stderrText,
        stderrTruncated: err.truncated,
        spawnError: spawnError || null,
      });
    }

    child.on("error", (error) => finish(null, null, error));
    child.on("close", (code, signal) => finish(code, signal));
    child.stdout?.on("data", (chunk) => appendCapped(out, chunk.toString("utf8")));
    child.stderr?.on("data", (chunk) => appendCapped(err, chunk.toString("utf8")));
  });
}

async function logEvent(record) {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const line =
      JSON.stringify({ at: new Date().toISOString(), ...record }) + "\n";
    await fs.appendFile(SHELL_LOG, line, "utf8");
  } catch {
    /* logging must never break a command */
  }
}

async function logCommand(result) {
  await logEvent({
    cwd: result.cwd,
    command: result.command,
    exitCode: result.code,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
  });
}

function formatCommandResult(result) {
  const status = result.spawnError
    ? `Failed to start: ${result.spawnError.message}`
    : result.timedOut
      ? `Stopped after the timeout (${result.durationMs} ms)`
      : `Exit code: ${result.code ?? "unknown"}${
          result.signal ? ` (signal ${result.signal})` : ""
        } (${(result.durationMs / 1000).toFixed(2)} s)`;

  const parts = [
    `$ ${result.command}`,
    `shell: ${result.shell} · folder: ${result.cwd}`,
    status,
  ];

  parts.push("", "--- stdout ---", result.stdout.trimEnd() || "(empty)");
  if (result.stdoutTruncated) {
    parts.push(`… stdout truncated to ${MAX_OUTPUT_CHARS} characters.`);
  }

  if (result.stderr.trim()) {
    parts.push("", "--- stderr ---", result.stderr.trimEnd());
    if (result.stderrTruncated) {
      parts.push(`… stderr truncated to ${MAX_OUTPUT_CHARS} characters.`);
    }
  }

  return parts.join("\n");
}

/* -------------------------------------------------------------------------- */
/*                                   Server                                  */
/* -------------------------------------------------------------------------- */

/* --------------------------- background processes ------------------------- */

const BACKGROUND = new Map();

function appendProcessOutput(record, key, chunk) {
  const truncatedKey = `${key}Truncated`;
  if (record[truncatedKey]) return;
  const next = record[key] + chunk;
  if (next.length > MAX_PROCESS_BUFFER) {
    record[key] = next.slice(0, MAX_PROCESS_BUFFER);
    record[truncatedKey] = true;
    return;
  }
  record[key] = next;
}

function waitForExit(record, ms) {
  if (record.finished) return Promise.resolve(true);
  if (!ms) return Promise.resolve(false);
  return Promise.race([
    record.exitPromise.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), ms)),
  ]);
}

function describeProcess(record) {
  const endedAt = record.finished ? record.endedAt : Date.now();
  const elapsed = (endedAt - record.startedAt) / 1000;
  const state = record.finished
    ? `finished, exit code ${record.exitCode ?? "unknown"}${
        record.signal ? ` (signal ${record.signal})` : ""
      }`
    : `running, pid ${record.pid}`;
  return [
    `Process ${record.id}: ${state} (${elapsed.toFixed(2)} s)`,
    `$ ${record.command}`,
    `shell: ${record.shell} · folder: ${record.cwd}`,
  ];
}

function formatProcessOutput(record) {
  const parts = describeProcess(record);
  parts.push("", "--- stdout ---", record.stdout.trimEnd() || "(empty)");
  if (record.stdoutTruncated) {
    parts.push(`… stdout truncated to ${MAX_PROCESS_BUFFER} characters.`);
  }
  if (record.stderr.trim()) {
    parts.push("", "--- stderr ---", record.stderr.trimEnd());
    if (record.stderrTruncated) {
      parts.push(`… stderr truncated to ${MAX_PROCESS_BUFFER} characters.`);
    }
  }
  if (record.spawnError) parts.push("", `Failed to start: ${record.spawnError}`);
  if (!record.finished) {
    parts.push(
      "",
      `Read more: read_output({ id: "${record.id}" }). Stop: stop_process({ id: "${record.id}" }).`,
    );
  }
  return parts.join("\n");
}

function startBackgroundProcess(command, cwd) {
  const finished = [...BACKGROUND.values()].filter((record) => record.finished);
  while (BACKGROUND.size >= MAX_BG_PROCESSES && finished.length) {
    BACKGROUND.delete(finished.shift().id);
  }
  if (BACKGROUND.size >= MAX_BG_PROCESSES) {
    throw new Error(
      `Too many background processes (max ${MAX_BG_PROCESSES}). Stop one with stop_process first.`,
    );
  }

  const { file, args, shellName } = shellInvocation(command);
  const child = spawn(file, args, {
    cwd,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_PAGER: "cat",
      PAGER: "cat",
      NO_COLOR: "1",
      TERM: "dumb",
    },
  });

  const record = {
    id: newId(),
    command,
    cwd,
    shell: shellName,
    child,
    pid: child.pid,
    startedAt: Date.now(),
    endedAt: null,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    exitCode: null,
    signal: null,
    finished: false,
    spawnError: null,
  };
  record.exitPromise = new Promise((resolve) => {
    record.resolveExit = resolve;
  });

  child.on("error", (error) => {
    record.spawnError = error.message;
    record.finished = true;
    record.endedAt = Date.now();
    record.resolveExit();
  });
  child.on("close", (code, signal) => {
    record.exitCode = typeof code === "number" ? code : null;
    record.signal = signal || null;
    record.finished = true;
    record.endedAt = Date.now();
    if (shellName.startsWith("powershell") || shellName === "pwsh") {
      record.stderr = decodePowerShellStderr(record.stderr);
    }
    logEvent({
      event: "exit",
      id: record.id,
      exitCode: record.exitCode,
      durationMs: record.endedAt - record.startedAt,
    });
    record.resolveExit();
  });
  child.stdout?.on("data", (chunk) =>
    appendProcessOutput(record, "stdout", chunk.toString("utf8")),
  );
  child.stderr?.on("data", (chunk) =>
    appendProcessOutput(record, "stderr", chunk.toString("utf8")),
  );

  BACKGROUND.set(record.id, record);
  logEvent({ event: "start", id: record.id, cwd, command, pid: record.pid });
  return record;
}

function stopAllProcesses() {
  for (const record of BACKGROUND.values()) {
    if (!record.finished) killProcessTree(record.pid);
  }
}

/* -------------------------------------------------------------------------- */
/*                                   Server                                  */
/* -------------------------------------------------------------------------- */

const server = new McpServer({
  name: "claude-file-manager",
  version: "1.3.0",
});

server.registerTool(
  "list_roots",
  {
    title: "Show the allowed folders",
    description:
      "Lists the folders this server may work in. Relative paths in other " +
      "tools resolve against the first root; absolute paths are accepted " +
      "inside any listed root.",
    inputSchema: {},
  },
  async () => {
    try {
      const lines = [];
      for (let i = 0; i < ROOTS.length; i += 1) {
        const root = ROOTS[i];
        const stat = await statOrNull(root);
        const state = !stat ? "missing" : stat.isDirectory() ? "folder" : "not a folder";
        lines.push(
          `${i === 0 ? "*" : " "} ${i + 1}. ${root} (${state})` +
            (i === 0 ? "  ← default for relative paths" : ""),
        );
      }
      return text(
        `Allowed folders (${ROOTS.length}):\n\n${lines.join("\n")}\n\n` +
          (ALLOW_OUTSIDE
            ? "MCP_ALLOW_OUTSIDE_ROOT=1: any path is also allowed."
            : "Paths outside these folders are rejected."),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "list_directory",
  {
    title: "List a folder",
    description:
      "Lists files and folders. Paths can be relative to the server's " +
      "root folder. Supports recursive traversal.",
    inputSchema: {
      path: z.string().default(".").describe("Folder path (defaults to root)"),
      recursive: z.boolean().default(false).describe("Traverse nested folders"),
      max_depth: z
        .number()
        .int()
        .min(1)
        .max(20)
        .default(3)
        .describe("Traversal depth when recursive=true"),
      show_hidden: z
        .boolean()
        .default(true)
        .describe("Show hidden files (names starting with a dot)"),
    },
  },
  async ({ path: inputPath, recursive, max_depth, show_hidden }) => {
    try {
      const abs = resolvePath(inputPath);
      const stat = await statOrNull(abs);
      if (!stat) throw new Error(`Folder not found: ${abs}`);
      if (!stat.isDirectory()) throw new Error(`Not a folder: ${abs}`);

      const lines = [`Folder: ${abs}`, ""];
      let shown = 0;
      let truncated = false;

      async function walk(dir, depth) {
        if (shown >= MAX_LIST_ENTRIES) {
          truncated = true;
          return;
        }
        let entries;
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch (e) {
          lines.push(`${"  ".repeat(depth)}! access denied: ${e.message}`);
          return;
        }
        entries.sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
          return a.name.localeCompare(b.name, "en");
        });

        for (const entry of entries) {
          if (!show_hidden && entry.name.startsWith(".")) continue;
          if (shown >= MAX_LIST_ENTRIES) {
            truncated = true;
            return;
          }
          shown += 1;

          const full = path.join(dir, entry.name);
          const indent = "  ".repeat(depth);
          const isDir = entry.isDirectory();
          const isLink = entry.isSymbolicLink();

          let extra = "";
          if (!isDir) {
            if (isLink) {
              extra = " (symlink)";
            } else {
              try {
                const st = await fs.stat(full);
                extra = ` (${formatBytes(st.size)})`;
              } catch {
                /* ignore */
              }
            }
          }

          lines.push(
            `${indent}${isDir ? "[DIR] " : "[FILE]"} ${entry.name}${isDir ? "/" : ""}${extra}`,
          );

          if (recursive && isDir && !isLink && depth + 1 < max_depth) {
            await walk(full, depth + 1);
          }
        }
      }

      await walk(abs, 0);

      if (truncated) {
        lines.push(
          "",
          `… list truncated: showing at most ${MAX_LIST_ENTRIES} entries.`,
        );
      }
      if (shown === 0) lines.push("(folder is empty)");

      return text(lines.join("\n"));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "list_tree",
  {
    title: "Show a compact project tree",
    description:
      "Renders a compact tree of folders and files with box-drawing characters. " +
      "Much less noisy than a recursive list_directory. Skips node_modules, " +
      ".git, .mcp and other service folders by default; limits depth and total " +
      "entries.",
    inputSchema: {
      path: z.string().default(".").describe("Folder to render (defaults to root)"),
      depth: z
        .number()
        .int()
        .min(1)
        .max(10)
        .default(3)
        .describe("How many levels to show"),
      show_files: z.boolean().default(true).describe("Show files (false = folders only)"),
      include_sizes: z.boolean().default(false).describe("Show file sizes"),
      show_hidden: z.boolean().default(true).describe("Show names starting with a dot"),
      ignore: z
        .array(z.string())
        .default([])
        .describe("Additional names/globs to skip"),
      max_entries: z
        .number()
        .int()
        .min(1)
        .max(5000)
        .default(800)
        .describe("Maximum number of entries to print"),
    },
  },
  async ({
    path: inputPath,
    depth,
    show_files,
    include_sizes,
    show_hidden,
    ignore,
    max_entries,
  }) => {
    try {
      const abs = resolvePath(inputPath);
      const stat = await statOrNull(abs);
      if (!stat) throw new Error(`Folder not found: ${abs}`);
      if (!stat.isDirectory()) throw new Error(`Not a folder: ${abs}`);

      const ignoreSet = new Set([...DEFAULT_IGNORES, ...ignore.filter((p) => !hasWildcard(p))]);
      const ignoreGlobs = ignore.filter((p) => hasWildcard(p)).map((p) => globToRegExp(p));
      const lines = [];
      let shown = 0;
      let dirs = 0;
      let files = 0;
      let truncated = false;

      async function walk(dir, prefix, level) {
        let entries;
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          lines.push(`${prefix}└─ [access denied]`);
          return;
        }

        const visible = entries
          .filter((entry) => {
            if (!show_hidden && entry.name.startsWith(".")) return false;
            if (ignoreSet.has(entry.name)) return false;
            return !ignoreGlobs.some((re) => re.test(entry.name));
          })
          .sort((a, b) => {
            const aDir = a.isDirectory() && !a.isSymbolicLink();
            const bDir = b.isDirectory() && !b.isSymbolicLink();
            if (aDir !== bDir) return aDir ? -1 : 1;
            return a.name.localeCompare(b.name, "en");
          });

        for (let i = 0; i < visible.length; i += 1) {
          if (shown >= max_entries) {
            truncated = true;
            return;
          }

          const entry = visible[i];
          const full = path.join(dir, entry.name);
          const info = await statOrNull(full);
          if (!info) continue;

          const isDir = entry.isDirectory() && !entry.isSymbolicLink();
          if (!isDir && !show_files) continue;

          shown += 1;
          if (isDir) dirs += 1;
          else files += 1;

          const last = i === visible.length - 1;
          const linkMark = entry.isSymbolicLink() ? "@" : "";
          const size =
            include_sizes && !isDir && info.isFile() ? `  ${formatBytes(info.size)}` : "";
          lines.push(
            `${prefix}${last ? "└─ " : "├─ "}${entry.name}${isDir ? "/" : ""}${linkMark}${size}`,
          );

          if (isDir && level + 1 < depth) {
            await walk(full, prefix + (last ? "   " : "│  "), level + 1);
          }
        }
      }

      await walk(abs, "", 0);

      const header = `Tree: ${abs} (depth ${depth})`;
      if (!shown) return text(`${header}\n\n(folder is empty)`);

      const footer =
        `\n\n${dirs} folder(s), ${files} file(s)` +
        (truncated ? ` — stopped at ${max_entries} entries.` : "");

      return text(`${header}\n\n${lines.join("\n")}${footer}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "read_file",
  {
    title: "Read a file",
    description:
      "Reads a text file. An optional line range can be specified (1-based). " +
      "Large files are truncated.",
    inputSchema: {
      path: z.string().describe("File path"),
      start_line: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("First line (1-based)"),
      end_line: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Last line (inclusive)"),
    },
  },
  async ({ path: inputPath, start_line, end_line }) => {
    try {
      const abs = resolvePath(inputPath);
      const stat = await statOrNull(abs);
      if (!stat) throw new Error(`File not found: ${abs}`);
      if (stat.isDirectory()) {
        throw new Error(`This is a folder, not a file: ${abs}. Use list_directory.`);
      }

      const buf = await fs.readFile(abs);
      if (isProbablyBinary(buf)) {
        return text(
          `File looks binary (${formatBytes(buf.length)}): ${abs}\n` +
            `It cannot be read as text.`,
        );
      }

      let content = buf.toString("utf8");

      if (start_line !== undefined || end_line !== undefined) {
        const all = content.split(/\r\n|\n|\r/);
        const from = (start_line ?? 1) - 1;
        const to = end_line ?? all.length;
        content = all.slice(from, to).join("\n");
      }

      let truncated = false;
      if (content.length > MAX_READ_CHARS) {
        content = content.slice(0, MAX_READ_CHARS);
        truncated = true;
      }

      const header = `File: ${abs} (${formatBytes(stat.size)})`;
      const footer = truncated
        ? `\n\n… content truncated to ${MAX_READ_CHARS} characters. ` +
          `Use start_line/end_line to read the part you need.`
        : "";

      return text(`${header}\n---\n${content}${footer}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "read_image",
  {
    title: "View an image",
    description:
      "Returns an image file so you can actually see it (screenshots, design " +
      "mockups, diagrams). Supports PNG, JPEG, GIF and WebP. The file must be " +
      `at most ${formatBytes(MAX_IMAGE_BYTES)}. For text files use read_file.`,
    inputSchema: {
      path: z.string().describe("Image file path"),
    },
  },
  async ({ path: inputPath }) => {
    try {
      const abs = resolvePath(inputPath);
      let stat;
      try {
        stat = await fs.stat(abs);
      } catch {
        throw new Error(`File not found: ${abs}`);
      }
      if (stat.isDirectory()) throw new Error(`This is a folder, not a file: ${abs}`);

      const mime = IMAGE_MIME[path.extname(abs).toLowerCase()];
      if (!mime) {
        throw new Error(
          `Unsupported image format: ${path.extname(abs) || "(no extension)"}. ` +
            `Supported: PNG, JPEG, GIF, WebP.`,
        );
      }
      if (stat.size > MAX_IMAGE_BYTES) {
        throw new Error(
          `Image is ${formatBytes(stat.size)}, the limit is ${formatBytes(MAX_IMAGE_BYTES)}. ` +
            `Resize it or raise MCP_MAX_IMAGE_BYTES.`,
        );
      }

      const buf = await fs.readFile(abs);
      return {
        content: [
          {
            type: "image",
            data: buf.toString("base64"),
            mimeType: mime,
          },
          {
            type: "text",
            text: `Image: ${abs} (${formatBytes(stat.size)}, ${mime})`,
          },
        ],
      };
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "write_file",
  {
    title: "Create or overwrite a file",
    description:
      "Writes text to a file. Creates missing parent folders. " +
      "By default overwrites an existing file and keeps a backup " +
      "(restorable via undo_last_change).",
    inputSchema: {
      path: z.string().describe("File path"),
      content: z.string().describe("Text content of the file"),
      overwrite: z
        .boolean()
        .default(true)
        .describe("false — do not overwrite if the file already exists"),
      create_parents: z
        .boolean()
        .default(true)
        .describe("Create missing parent folders"),
    },
  },
  async ({ path: inputPath, content, overwrite, create_parents }) => {
    try {
      const abs = resolvePath(inputPath);
      assertNotData(abs);
      const existing = await statOrNull(abs);
      if (existing?.isDirectory()) {
        throw new Error(`This is a folder, not a file: ${abs}`);
      }
      if (existing && !overwrite) {
        throw new Error(
          `File already exists: ${abs}. Set overwrite=true to overwrite it.`,
        );
      }

      const backup = existing ? await backupFile(abs) : null;

      if (create_parents) {
        await fs.mkdir(path.dirname(abs), { recursive: true });
      }

      await fs.writeFile(abs, content, "utf8");
      const stat = await fs.stat(abs);

      await recordActivity(
        existing ? "write" : "create",
        `${existing ? "Overwrite" : "Create"} ${shortName(abs)}`,
        backup
          ? { kind: "restore_file", target: abs, backup }
          : { kind: "remove", target: abs },
      );

      return text(
        `${existing ? "File overwritten" : "File created"}: ${abs}\n` +
          `Size: ${formatBytes(stat.size)}` +
          (backup ? "\nBackup saved (undo_last_change)." : ""),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "append_file",
  {
    title: "Append to a file",
    description: "Appends text to the end of a file, creating it if needed.",
    inputSchema: {
      path: z.string().describe("File path"),
      content: z.string().describe("Text to append"),
      create_parents: z
        .boolean()
        .default(true)
        .describe("Create missing parent folders"),
    },
  },
  async ({ path: inputPath, content, create_parents }) => {
    try {
      const abs = resolvePath(inputPath);
      assertNotData(abs);
      const stat = await statOrNull(abs);
      if (stat?.isDirectory()) throw new Error(`This is a folder: ${abs}`);
      if (create_parents) {
        await fs.mkdir(path.dirname(abs), { recursive: true });
      }

      const backup = stat ? await backupFile(abs) : null;
      await fs.appendFile(abs, content, "utf8");

      await recordActivity(
        "append",
        `Append ${shortName(abs)}`,
        backup
          ? { kind: "restore_file", target: abs, backup }
          : { kind: "remove", target: abs },
      );

      return text(`Text appended to file: ${abs}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "edit_file",
  {
    title: "Edit a file",
    description:
      "Replaces an exact occurrence of old_string with new_string and shows a diff. " +
      "If old_string occurs more than once, set replace_all=true explicitly. " +
      "A backup is saved before editing (undo_last_change).",
    inputSchema: {
      path: z.string().describe("File path"),
      old_string: z.string().min(1).describe("Text to find"),
      new_string: z
        .string()
        .describe("Replacement text (may be empty to delete the fragment)"),
      replace_all: z
        .boolean()
        .default(false)
        .describe("Replace all occurrences instead of only the unique one"),
    },
  },
  async ({ path: inputPath, old_string, new_string, replace_all }) => {
    try {
      const abs = resolvePath(inputPath);
      assertNotData(abs);
      const stat = await statOrNull(abs);
      if (!stat) throw new Error(`File not found: ${abs}`);
      if (stat.isDirectory()) throw new Error(`This is a folder: ${abs}`);

      const content = await fs.readFile(abs, "utf8");

      if (old_string === new_string) {
        throw new Error("old_string and new_string are identical — nothing to change.");
      }

      const count = countOccurrences(content, old_string);
      if (count === 0) {
        throw new Error(
          `Fragment not found in ${abs}. Check for an exact match, including indentation.`,
        );
      }
      if (count > 1 && !replace_all) {
        throw new Error(
          `Fragment occurs ${count} time(s). Make old_string more specific ` +
            `or set replace_all=true.`,
        );
      }

      // A callback makes the replacement literal: "$&" and friends in
      // new_string are no longer interpreted as replace patterns, matching
      // the split/join behavior of the replace_all branch.
      const updated = replace_all
        ? content.split(old_string).join(new_string)
        : content.replace(old_string, () => new_string);

      const backup = await backupFile(abs);
      await fs.writeFile(abs, updated, "utf8");

      await recordActivity(
        "edit",
        `Edit ${shortName(abs)}`,
        { kind: "restore_file", target: abs, backup },
      );

      return text(
        `File updated: ${abs}\nOccurrences replaced: ${replace_all ? count : 1}\n\n` +
          summarizeChanges(content, updated),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "multi_edit",
  {
    title: "Multiple edits at once",
    description:
      "Applies several replacements to one file atomically: if any fragment is " +
      "not found, the file is left unchanged. Returns a combined diff. " +
      "A backup is saved before editing.",
    inputSchema: {
      path: z.string().describe("File path"),
      edits: z
        .array(
          z.object({
            old_string: z.string().min(1).describe("What to find"),
            new_string: z.string().describe("What to replace it with"),
            replace_all: z
              .boolean()
              .default(false)
              .describe("Replace all occurrences"),
          }),
        )
        .min(1)
        .describe("List of replacements, applied in order"),
    },
  },
  async ({ path: inputPath, edits }) => {
    try {
      const abs = resolvePath(inputPath);
      assertNotData(abs);
      const stat = await statOrNull(abs);
      if (!stat) throw new Error(`File not found: ${abs}`);
      if (stat.isDirectory()) throw new Error(`This is a folder: ${abs}`);

      const original = await fs.readFile(abs, "utf8");
      let current = original;

      edits.forEach((edit, index) => {
        const number = index + 1;
        if (edit.old_string === edit.new_string) {
          throw new Error(`Edit #${number}: old_string and new_string are identical.`);
        }
        const count = countOccurrences(current, edit.old_string);
        if (count === 0) {
          throw new Error(
            `Edit #${number}: fragment not found. File unchanged.`,
          );
        }
        if (count > 1 && !edit.replace_all) {
          throw new Error(
            `Edit #${number}: fragment occurs ${count} time(s). ` +
              `Make the text more specific or enable replace_all. File unchanged.`,
          );
        }
        current = edit.replace_all
          ? current.split(edit.old_string).join(edit.new_string)
          : current.replace(edit.old_string, () => edit.new_string);
      });

      const backup = await backupFile(abs);
      await fs.writeFile(abs, current, "utf8");

      await recordActivity(
        "multi_edit",
        `Edit ${shortName(abs)} (${edits.length} replacements)`,
        { kind: "restore_file", target: abs, backup },
      );

      return text(
        `File updated: ${abs}\nReplacements: ${edits.length}\n\n` +
          summarizeChanges(original, current),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "create_directory",
  {
    title: "Create a folder",
    description: "Creates a folder (including all missing parents by default).",
    inputSchema: {
      path: z.string().describe("Folder path"),
      recursive: z
        .boolean()
        .default(true)
        .describe("Create all missing parent folders"),
    },
  },
  async ({ path: inputPath, recursive }) => {
    try {
      const abs = resolvePath(inputPath);
      assertNotData(abs);
      const stat = await statOrNull(abs);
      if (stat?.isDirectory()) {
        return text(`Folder already exists: ${abs}`);
      }
      if (stat) throw new Error(`A file already exists at this path: ${abs}`);

      await fs.mkdir(abs, { recursive });
      await recordActivity("mkdir", `Create folder ${shortName(abs)}`, {
        kind: "remove",
        target: abs,
        onlyIfEmpty: true,
      });

      return text(`Folder created: ${abs}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "move_path",
  {
    title: "Move or rename",
    description: "Moves or renames a file or folder.",
    inputSchema: {
      source: z.string().describe("Source"),
      destination: z.string().describe("Destination"),
      overwrite: z
        .boolean()
        .default(false)
        .describe("Allow replacing an existing file/folder"),
    },
  },
  async ({ source, destination, overwrite }) => {
    try {
      const from = resolvePath(source, { allowRoot: false });
      const to = resolvePath(destination, { allowRoot: false });
      assertNotData(from);
      assertNotData(to);

      const fromStat = await statOrNull(from);
      if (!fromStat) throw new Error(`Source not found: ${from}`);

      const toStat = await statOrNull(to);
      if (toStat && !overwrite) {
        throw new Error(
          `Destination already exists: ${to}. Set overwrite=true to replace it.`,
        );
      }
      if (toStat && overwrite) {
        await fs.rm(to, { recursive: true, force: true });
      }

      await fs.mkdir(path.dirname(to), { recursive: true });

      try {
        await fs.rename(from, to);
      } catch (e) {
        // Different drives on Windows: rename is impossible, so copy and delete.
        if (e.code !== "EXDEV") throw e;
        await fs.cp(from, to, { recursive: true, errorOnExist: false });
        await fs.rm(from, { recursive: true, force: true });
      }

      await recordActivity(
        "move",
        `Move ${shortName(from)} → ${shortName(to)}`,
        { kind: "move_back", from: to, to: from },
      );

      return text(`Moved:\n  from: ${from}\n  to:   ${to}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "copy_path",
  {
    title: "Copy a file or folder",
    description: "Copies a file or folder (folders recursively).",
    inputSchema: {
      source: z.string().describe("Source"),
      destination: z.string().describe("Destination"),
      overwrite: z
        .boolean()
        .default(false)
        .describe("Allow replacing an existing destination"),
    },
  },
  async ({ source, destination, overwrite }) => {
    try {
      const from = resolvePath(source);
      const to = resolvePath(destination, { allowRoot: false });
      assertNotData(to);

      const fromStat = await statOrNull(from);
      if (!fromStat) throw new Error(`Source not found: ${from}`);

      const toStat = await statOrNull(to);
      if (toStat && !overwrite) {
        throw new Error(
          `Destination already exists: ${to}. Set overwrite=true to replace it.`,
        );
      }

      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.cp(from, to, {
        recursive: true,
        force: overwrite,
        errorOnExist: !overwrite,
      });

      await recordActivity(
        "copy",
        `Copy ${shortName(from)} → ${shortName(to)}`,
        { kind: "remove", target: to },
      );

      return text(`Copied:\n  from: ${from}\n  to:   ${to}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "zip_path",
  {
    title: "Create a ZIP archive",
    description:
      "Packs files and folders into a ZIP archive. Each source keeps its own " +
      "name at the top level of the archive; subfolders are included " +
      "recursively. Symbolic links are skipped. UTF-8 file names are stored " +
      "correctly. Set overwrite=true to replace an existing archive.",
    inputSchema: {
      sources: z
        .array(z.string())
        .min(1)
        .describe("Files and folders to include, e.g. [\"src\", \"README.md\"]"),
      destination: z.string().describe("Archive path, e.g. `backup.zip`"),
      overwrite: z
        .boolean()
        .default(false)
        .describe("Replace the archive if it already exists"),
    },
  },
  async ({ sources, destination, overwrite }) => {
    try {
      const dest = resolvePath(destination, { allowRoot: false });
      assertNotData(dest);

      const existing = await statOrNull(dest);
      if (existing?.isDirectory()) throw new Error(`Destination is a folder: ${dest}`);
      if (existing && !overwrite) {
        throw new Error(
          `Archive already exists: ${dest}. Set overwrite=true to replace it.`,
        );
      }

      const { entries, totalBytes, skippedLinks } = await collectZipEntries(sources);
      if (!entries.length) {
        throw new Error("Nothing to zip: all sources are empty or symlinks.");
      }

      await fs.mkdir(path.dirname(dest), { recursive: true });
      const { size } = await writeZip(entries, dest);

      await recordActivity(
        "zip",
        `Create ${shortName(dest)} (${entries.length} entries)`,
        existing ? null : { kind: "remove", target: dest },
      );

      return text(
        `Archive created: ${dest}\n` +
          `Entries: ${entries.length} (${formatBytes(totalBytes)} of files)\n` +
          `Archive size: ${formatBytes(size)}` +
          (skippedLinks ? `\nSkipped symlinks: ${skippedLinks}` : ""),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "unzip_path",
  {
    title: "Extract a ZIP archive",
    description:
      "Extracts a ZIP archive into a folder, creating missing parent folders. " +
      "Stored and deflated entries with UTF-8 names are supported (ZIP64 and " +
      "encrypted archives are not). Paths that would escape the destination " +
      "are rejected. By default nothing is overwritten.",
    inputSchema: {
      source: z.string().describe("Archive path"),
      destination: z.string().describe("Folder to extract into"),
      overwrite: z
        .boolean()
        .default(false)
        .describe("Replace files that already exist (no backup is made)"),
    },
  },
  async ({ source, destination, overwrite }) => {
    try {
      const archive = resolvePath(source);
      const dest = resolvePath(destination, { allowRoot: false });
      assertNotData(dest);

      const archiveStat = await statOrNull(archive);
      if (!archiveStat) throw new Error(`Archive not found: ${archive}`);
      if (!archiveStat.isFile()) throw new Error(`Not a file: ${archive}`);

      const existing = await statOrNull(dest);
      if (existing && !existing.isDirectory()) {
        throw new Error(`Destination is not a folder: ${dest}`);
      }

      await fs.mkdir(dest, { recursive: true });
      const result = await extractZip(archive, dest, overwrite);

      await recordActivity(
        "unzip",
        `Extract ${shortName(archive)} → ${shortName(dest)} (${result.files} files)`,
        existing ? null : { kind: "remove", target: dest },
      );

      return text(
        `Extracted: ${shortName(archive)} → ${dest}\n` +
          `Files: ${result.files}, folders: ${result.folders}, ` +
          `uncompressed: ${formatBytes(result.bytes)}` +
          (existing ? "\nThe destination already existed, so this step cannot be undone." : ""),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "delete_path",
  {
    title: "Delete a file or folder",
    description:
      "Deletes a file or folder. By default the item goes to the trash " +
      `(${path.join(ROOT, ".mcp", "trash")}) and can be restored via ` +
      "restore_path or undo_last_change. A non-empty folder can only be deleted " +
      "with recursive=true. The root folder cannot be deleted.",
    inputSchema: {
      path: z.string().describe("File or folder path"),
      recursive: z
        .boolean()
        .default(false)
        .describe("Delete the folder with all its contents"),
      permanent: z
        .boolean()
        .default(false)
        .describe("Delete permanently, without the trash (irreversible)"),
    },
  },
  async ({ path: inputPath, recursive, permanent }) => {
    try {
      const abs = resolvePath(inputPath, { allowRoot: false });
      assertNotData(abs);
      const stat = await statOrNull(abs);
      if (!stat) throw new Error(`Path not found: ${abs}`);

      if (stat.isDirectory() && !recursive) {
        let entries;
        try {
          entries = await fs.readdir(abs);
        } catch (e) {
          throw new Error(`No access to folder ${abs}: ${e.message}`);
        }
        if (entries.length > 0) {
          throw new Error(
            `Folder is not empty: ${abs}. Set recursive=true to delete it with all its contents.`,
          );
        }
      }

      const type = stat.isDirectory() ? "directory" : "file";

      if (permanent) {
        await fs.rm(abs, { recursive: stat.isDirectory(), force: false });
        await recordActivity("delete_permanent", `Permanently deleted ${shortName(abs)}`, null);
        return text(`Permanently deleted: ${abs}`);
      }

      const { id } = await moveToTrash(abs, type);

      await recordActivity("delete", `Moved to trash: ${shortName(abs)}`, {
        kind: "restore_trash",
        trashId: id,
      });

      return text(
        `${type === "directory" ? "Folder" : "File"} moved to trash: ${abs}\n` +
          `id: ${id}\nRestore: restore_path({ id: "${id}" }) or undo_last_change().`,
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "file_info",
  {
    title: "File or folder info",
    description: "Returns the type, size and modification time of an item.",
    inputSchema: {
      path: z.string().describe("File or folder path"),
    },
  },
  async ({ path: inputPath }) => {
    try {
      const abs = resolvePath(inputPath);
      const stat = await statOrNull(abs);
      if (!stat) throw new Error(`Path not found: ${abs}`);

      const type = stat.isDirectory()
        ? "folder"
        : stat.isSymbolicLink()
          ? "symlink"
          : stat.isFile()
            ? "file"
            : "other";

      const lines = [
        `Path: ${abs}`,
        `Relative to root: ${shortName(abs)}`,
        `Type: ${type}`,
        `Size: ${formatBytes(stat.size)}`,
        `Created: ${stat.birthtime.toISOString()}`,
        `Modified: ${stat.mtime.toISOString()}`,
      ];

      if (stat.isSymbolicLink()) {
        try {
          lines.push(`Symlink target: ${await fs.readlink(abs)}`);
        } catch {
          /* ignore */
        }
      }

      return text(lines.join("\n"));
    } catch (e) {
      return fail(e);
    }
  },
);

/* ---------------------------------- search --------------------------------- */

server.registerTool(
  "find_files",
  {
    title: "Find files by name",
    description:
      "Finds files by glob (`*.js`, `src/**/*.ts`, `config*`) or a substring in " +
      "the name. Service folders (node_modules, .git, .mcp) are skipped.",
    inputSchema: {
      pattern: z
        .string()
        .min(1)
        .describe("Glob (`*.md`, `**/*.js`) or part of the name"),
      path: z.string().default(".").describe("Where to search (defaults to root)"),
      include_dirs: z
        .boolean()
        .default(false)
        .describe("Include folders in the results"),
      max_results: z
        .number()
        .int()
        .min(1)
        .max(5000)
        .default(300)
        .describe("Maximum number of results"),
      max_depth: z
        .number()
        .int()
        .min(1)
        .max(40)
        .default(20)
        .describe("Maximum depth"),
      ignore: z
        .array(z.string())
        .default([])
        .describe("Additional names/globs to skip"),
    },
  },
  async ({ pattern, path: inputPath, include_dirs, max_results, max_depth, ignore }) => {
    try {
      const start = resolvePath(inputPath);
      const stat = await statOrNull(start);
      if (!stat?.isDirectory()) throw new Error(`Folder not found: ${start}`);

      const withGlob = hasWildcard(pattern);
      const regex = withGlob ? globToRegExp(pattern) : null;
      const needle = withGlob ? null : pattern.toLowerCase();
      const matchPath = pattern.includes("/") || pattern.includes("\\");

      const results = [];

      function matches(full, name) {
        const rel = normalizeRel(path.relative(start, full));
        if (regex) return matchPath ? regex.test(rel) : regex.test(name);
        const haystack = (matchPath ? rel : name).toLowerCase();
        return haystack.includes(needle);
      }

      await walkTree(start, {
        maxDepth: max_depth,
        extraIgnore: ignore,
        onDir: async (full, entry) => {
          if (results.length >= max_results) return;
          if (include_dirs && path.basename(full) !== ".mcp" && matches(full, entry.name)) {
            results.push({ full, rel: normalizeRel(path.relative(start, full)) + "/", dir: true });
          }
        },
        onFile: async (full, entry) => {
          if (results.length >= max_results) return;
          if (matches(full, entry.name)) {
            results.push({ full, rel: normalizeRel(path.relative(start, full)), dir: false });
          }
        },
      });

      results.sort((a, b) => a.rel.localeCompare(b.rel));

      if (!results.length) {
        return text(`No matches for "${pattern}" in ${start}.`);
      }

      const lines = results.map((item) => (item.dir ? "[DIR] " : "[FILE] ") + item.rel);
      const suffix =
        results.length >= max_results
          ? `\n… reached the limit of ${max_results} results.`
          : "";

      return text(
        `Found ${results.length} (searching in ${start}):\n\n` +
          lines.join("\n") +
          suffix,
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "search_content",
  {
    title: "Search text inside files",
    description:
      "Searches for a string or regular expression inside text files and " +
      "returns `file:line: text`. Binary and large files are skipped.",
    inputSchema: {
      query: z.string().min(1).describe("String or regular expression"),
      path: z.string().default(".").describe("Where to search"),
      is_regex: z.boolean().default(false).describe("Treat query as a regular expression"),
      case_sensitive: z.boolean().default(false).describe("Match case"),
      include: z
        .string()
        .optional()
        .describe("File glob, e.g. `*.js` or `src/**/*.ts`"),
      max_results: z
        .number()
        .int()
        .min(1)
        .max(2000)
        .default(100)
        .describe("Maximum number of matches"),
      max_file_size: z
        .number()
        .int()
        .min(1)
        .default(1_000_000)
        .describe("Skip files larger than this size (bytes)"),
      context_lines: z
        .number()
        .int()
        .min(0)
        .max(10)
        .default(0)
        .describe("Show this many lines before and after each match"),
      files_only: z
        .boolean()
        .default(false)
        .describe("Only list matching files with their match counts"),
      ignore: z
        .array(z.string())
        .default([])
        .describe("Additional names/globs to skip"),
    },
  },
  async ({
    query,
    path: inputPath,
    is_regex,
    case_sensitive,
    include,
    max_results,
    max_file_size,
    context_lines,
    files_only,
    ignore,
  }) => {
    try {
      const start = resolvePath(inputPath);
      const stat = await statOrNull(start);
      if (!stat?.isDirectory()) throw new Error(`Folder not found: ${start}`);

      let matcher;
      try {
        const flags = case_sensitive ? "" : "i";
        matcher = is_regex
          ? new RegExp(query, flags)
          : new RegExp(
              query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
              flags,
            );
      } catch (e) {
        throw new Error(`Invalid regular expression: ${e.message}`);
      }

      const includeRegex = include ? globToRegExp(include) : null;

      const files = new Map();
      let matchCount = 0;
      let filesScanned = 0;
      let filesSkipped = 0;

      await walkTree(start, {
        maxDepth: 30,
        extraIgnore: ignore,
        onFile: async (full, entry) => {
          if (matchCount >= max_results) return;
          const rel = normalizeRel(path.relative(start, full));

          if (includeRegex && !includeRegex.test(rel) && !includeRegex.test(entry.name)) {
            return;
          }

          let fileStat;
          try {
            fileStat = await fs.stat(full);
          } catch {
            return;
          }
          if (fileStat.size > max_file_size) {
            filesSkipped += 1;
            return;
          }

          let buf;
          try {
            buf = await fs.readFile(full);
          } catch {
            filesSkipped += 1;
            return;
          }
          if (isProbablyBinary(buf)) {
            filesSkipped += 1;
            return;
          }

          filesScanned += 1;
          const lines = buf.toString("utf8").split(/\r\n|\n|\r/);
          const matches = [];

          for (let i = 0; i < lines.length; i += 1) {
            if (matchCount >= max_results) break;
            matcher.lastIndex = 0;
            if (matcher.test(lines[i])) {
              matches.push(i);
              matchCount += 1;
            }
          }

          if (matches.length) files.set(rel, { rel, lines, matches });
        },
      });

      if (!matchCount) {
        return text(
          `No matches for (${query}) in ${start}. ` +
            `Files scanned: ${filesScanned}.`,
        );
      }

      const blocks = [];
      for (const file of files.values()) {
        if (files_only) {
          blocks.push(`${file.rel} (${file.matches.length})`);
          continue;
        }

        const matchSet = new Set(file.matches);
        const ranges = [];
        for (const index of file.matches) {
          const from = Math.max(0, index - context_lines);
          const to = Math.min(file.lines.length - 1, index + context_lines);
          const last = ranges[ranges.length - 1];
          if (last && from <= last.to + 1) last.to = Math.max(last.to, to);
          else ranges.push({ from, to });
        }

        const out = [`${file.rel}:`];
        ranges.forEach((range, rangeIndex) => {
          if (rangeIndex > 0) out.push("  --");
          for (let i = range.from; i <= range.to; i += 1) {
            const mark = matchSet.has(i) ? ":" : "-";
            const line = file.lines[i];
            const shown = line.length > 300 ? line.slice(0, 300) + "…" : line;
            out.push(`  ${String(i + 1).padStart(4, " ")}${mark} ${shown.trim()}`);
          }
        });
        blocks.push(out.join("\n"));
      }

      const suffix =
        matchCount >= max_results
          ? `\n… reached the limit of ${max_results} matches.`
          : "";

      let output =
        `Found ${matchCount} matches in ${filesScanned} files:\n\n` +
        blocks.join("\n\n") +
        suffix;

      if (output.length > MAX_OUTPUT_CHARS) {
        output =
          output.slice(0, MAX_OUTPUT_CHARS) +
          `\n… output truncated to ${MAX_OUTPUT_CHARS} characters.`;
      }

      return text(output);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "replace_in_files",
  {
    title: "Replace text in many files",
    description:
      "Replaces every occurrence of a string (or regular expression) across " +
      "text files, with a backup of each changed file and a single undo step. " +
      "Skips binary and very large files, node_modules, .git and .mcp by " +
      "default. Use dry_run=true to preview the changes first.",
    inputSchema: {
      query: z.string().min(1).describe("Text or regular expression to find"),
      replacement: z.string().describe("Replacement text (may be empty)"),
      path: z.string().default(".").describe("Where to search (defaults to root)"),
      include: z
        .string()
        .optional()
        .describe("File glob, e.g. `*.js` or `src/**/*.ts`"),
      is_regex: z.boolean().default(false).describe("Treat query as a regular expression"),
      case_sensitive: z.boolean().default(false).describe("Match case"),
      dry_run: z
        .boolean()
        .default(false)
        .describe("Only report what would change; do not write files"),
      max_files: z
        .number()
        .int()
        .min(1)
        .max(2000)
        .default(200)
        .describe("Stop after changing this many files"),
      max_file_size: z
        .number()
        .int()
        .min(1)
        .default(1_000_000)
        .describe("Skip files larger than this size (bytes)"),
      ignore: z
        .array(z.string())
        .default([])
        .describe("Additional names/globs to skip"),
    },
  },
  async ({
    query,
    replacement,
    path: inputPath,
    include,
    is_regex,
    case_sensitive,
    dry_run,
    max_files,
    max_file_size,
    ignore,
  }) => {
    try {
      const start = resolvePath(inputPath);
      const stat = await statOrNull(start);
      if (!stat?.isDirectory()) throw new Error(`Folder not found: ${start}`);

      let matcher;
      try {
        matcher = new RegExp(
          is_regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
          `${case_sensitive ? "" : "i"}g`,
        );
      } catch (e) {
        throw new Error(`Invalid regular expression: ${e.message}`);
      }

      const includeRegex = include ? globToRegExp(include) : null;
      const candidates = [];
      let filesScanned = 0;
      let filesSkipped = 0;
      let totalMatches = 0;
      let stopped = false;

      await walkTree(start, {
        maxDepth: 30,
        extraIgnore: ignore,
        onFile: async (full, entry) => {
          if (stopped) return;
          const rel = normalizeRel(path.relative(start, full));
          if (includeRegex && !includeRegex.test(rel) && !includeRegex.test(entry.name)) {
            return;
          }

          let fileStat;
          try {
            fileStat = await fs.stat(full);
          } catch {
            return;
          }
          if (fileStat.size > max_file_size) {
            filesSkipped += 1;
            return;
          }

          let buf;
          try {
            buf = await fs.readFile(full);
          } catch {
            filesSkipped += 1;
            return;
          }
          if (isProbablyBinary(buf)) {
            filesSkipped += 1;
            return;
          }

          filesScanned += 1;
          const before = buf.toString("utf8");
          const matches = before.match(matcher);
          if (!matches || !matches.length) return;

          const after = before.replace(matcher, () => replacement);
          if (after === before) return;

          candidates.push({ abs: full, rel, count: matches.length, before, after });
          totalMatches += matches.length;

          if (candidates.length >= max_files) stopped = true;
        },
      });

      if (!candidates.length) {
        return text(
          `No changes: "${query}" was not found in ${filesScanned} scanned file(s) in ${start}.`,
        );
      }

      const lines = [];
      for (const item of candidates) {
        lines.push(`  ${item.rel} (${item.count})`);
        const beforeLines = item.before.split(/\r?\n/);
        const afterLines = item.after.split(/\r?\n/);
        for (let i = 0; i < Math.max(beforeLines.length, afterLines.length); i += 1) {
          if (beforeLines[i] !== afterLines[i]) {
            const clip = (value) =>
              value === undefined
                ? "(end of file)"
                : value.length > 160
                  ? value.slice(0, 160) + "…"
                  : value;
            lines.push(`    line ${i + 1}: - ${clip(beforeLines[i])}`);
            lines.push(`               + ${clip(afterLines[i])}`);
            break;
          }
        }
      }

      const summary =
        `${dry_run ? "Would replace" : "Replaced"} ${totalMatches} occurrence(s) ` +
        `in ${candidates.length} file(s)` +
        (stopped ? ` (stopped at the ${max_files}-file limit)` : "") +
        `:\n\n${lines.join("\n")}`;

      if (dry_run) {
        return text(`${summary}\n\nNo files were changed (dry_run).`);
      }

      const changes = [];
      try {
        for (const item of candidates) {
          const backup = await backupFile(item.abs);
          if (!backup) throw new Error(`Could not back up ${item.abs}`);
          await fs.writeFile(item.abs, item.after, "utf8");
          changes.push({ target: item.abs, backup });
        }
      } finally {
        if (changes.length) {
          await recordActivity(
            "replace_in_files",
            `Replace "${query}" in ${changes.length} file(s)`,
            { kind: "restore_files", items: changes },
          );
        }
      }

      return text(`${summary}\n\nUndo with undo_last_change().`);
    } catch (e) {
      return fail(e);
    }
  },
);

/* ------------------------------- trash/undo ------------------------------- */

server.registerTool(
  "list_trash",
  {
    title: "Show the trash",
    description:
      "Lists deleted files and folders that can be restored.",
    inputSchema: {},
  },
  async () => {
    try {
      const index = await readJson(TRASH_INDEX, { items: [] });
      const items = Array.isArray(index.items) ? index.items : [];

      if (!items.length) return text("Trash is empty.");

      const lines = items
        .slice()
        .reverse()
        .map((item) => {
          const when = new Date(item.deletedAt).toLocaleString("en-US");
          return (
            `id: ${item.id}\n` +
            `  was: ${shortName(item.originalPath)}\n` +
            `  type: ${item.type === "directory" ? "folder" : "file"}, deleted: ${when}`
          );
        });

      return text(`Trash contains ${items.length} item(s):\n\n` + lines.join("\n\n"));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "restore_path",
  {
    title: "Restore from the trash",
    description:
      "Restores a file or folder from the trash to its original location. Get " +
      "the id from list_trash or from the delete_path response.",
    inputSchema: {
      id: z.string().min(1).describe("Trash entry id"),
      overwrite: z
        .boolean()
        .default(false)
        .describe("Replace the item if the original path is occupied"),
    },
  },
  async ({ id, overwrite }) => {
    try {
      const item = await restoreTrashItem(id, overwrite);
      await recordActivity(
        "restore",
        `Restore ${shortName(item.originalPath)}`,
        { kind: "remove", target: item.originalPath },
      );
      return text(`Restored: ${item.originalPath}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "undo_last_change",
  {
    title: "Undo the last change",
    description:
      "Reverts the last change made by the server: restores a file from its " +
      "backup, removes a created file, or brings back a deleted item from the " +
      "trash. Multiple steps can be undone in a row.",
    inputSchema: {
      steps: z
        .number()
        .int()
        .min(1)
        .max(20)
        .default(1)
        .describe("Number of recent changes to undo"),
    },
  },
  async ({ steps }) => {
    try {
      const log = await readJson(ACTIVITY_FILE, { items: [] });
      let items = Array.isArray(log.items) ? log.items : [];
      const done = [];
      const problems = [];

      for (let step = 0; step < steps && items.length; step += 1) {
        const entry = items[items.length - 1];
        if (!entry.undo) break;

        try {
          const undo = entry.undo;

          if (undo.kind === "restore_file") {
            const backupStat = await statOrNull(undo.backup);
            if (!backupStat) throw new Error("backup not found");
            await fs.mkdir(path.dirname(undo.target), { recursive: true });
            await fs.copyFile(undo.backup, undo.target);
            await fs.rm(undo.backup, { force: true });
          } else if (undo.kind === "restore_files") {
            const restoreItems = Array.isArray(undo.items) ? undo.items : [];
            if (!restoreItems.length) throw new Error("nothing to restore");
            for (const item of restoreItems) {
              if (!(await statOrNull(item.backup))) {
                throw new Error(`backup not found for ${shortName(item.target)}`);
              }
            }
            for (const item of restoreItems) {
              await fs.mkdir(path.dirname(item.target), { recursive: true });
              await fs.copyFile(item.backup, item.target);
              await fs.rm(item.backup, { force: true });
            }
          } else if (undo.kind === "remove") {
            const stat = await statOrNull(undo.target);
            if (stat) {
              if (undo.onlyIfEmpty && stat.isDirectory()) {
                const entries = await fs.readdir(undo.target);
                if (entries.length) {
                  throw new Error("folder is no longer empty — not deleting");
                }
              }
              await fs.rm(undo.target, { recursive: true, force: true });
            }
          } else if (undo.kind === "restore_trash") {
            await restoreTrashItem(undo.trashId, false);
          } else if (undo.kind === "move_back") {
            const stat = await statOrNull(undo.from);
            if (!stat) throw new Error("moved item not found");
            await fs.mkdir(path.dirname(undo.to), { recursive: true });
            try {
              await fs.rename(undo.from, undo.to);
            } catch (e) {
              if (e.code !== "EXDEV") throw e;
              await fs.cp(undo.from, undo.to, { recursive: true });
              await fs.rm(undo.from, { recursive: true, force: true });
            }
          } else {
            throw new Error(`unknown undo type "${undo.kind}"`);
          }

          items.pop();
          done.push(entry.description);
        } catch (e) {
          problems.push(`${entry.description}: ${e.message}`);
          break;
        }
      }

      log.items = items;
      await writeJson(ACTIVITY_FILE, log);

      if (!done.length) {
        return text(
          problems.length
            ? `Could not undo: ${problems.join("; ")}`
            : "Nothing to undo: the change history is empty.",
        );
      }

      let message = `Undone (${done.length}):\n` + done.map((d) => "  • " + d).join("\n");
      if (problems.length) message += `\n\nFailed: ${problems.join("; ")}`;
      return text(message);
    } catch (e) {
      return fail(e);
    }
  },
);

/* --------------------------------- terminal -------------------------------- */

if (ALLOW_SHELL) {
  server.registerTool(
    "run_command",
    {
      title: "Run a terminal command",
      description:
        "Runs a shell command and returns stdout, stderr and the exit code. " +
        `Shell: ${SHELL_MODE} ` +
        (process.platform === "win32" && SHELL_MODE === "powershell"
          ? "(Windows PowerShell 5.1; use PowerShell syntax, e.g. `Get-ChildItem` or `dir`). "
          : "(commands are joined with shell operators as usual). ") +
        "The working folder must be inside the allowed root. " +
        "Commands run with the rights of the current user and are not sandboxed, " +
        "so destructive commands really delete things. " +
        "Prefer file tools (read_file, edit_file, write_file) for editing files: " +
        "they create backups and support undo. " +
        `Default timeout is ${SHELL_TIMEOUT_DEFAULT / 1000} s.`,
      inputSchema: {
        command: z
          .string()
          .min(1)
          .describe("Command line, e.g. `npm test` or `git status`"),
        cwd: z
          .string()
          .default(".")
          .describe("Working folder (relative to the root, or absolute inside it)"),
        timeout_ms: z
          .number()
          .int()
          .min(100)
          .max(SHELL_TIMEOUT_MAX)
          .default(SHELL_TIMEOUT_DEFAULT)
          .describe(
            `Kill the command after this many milliseconds (max ${SHELL_TIMEOUT_MAX})`,
          ),
      },
    },
    async ({ command, cwd, timeout_ms }) => {
      try {
        if (!command.trim()) throw new Error("The command is empty.");
        if (command.includes("\u0000")) throw new Error("The command contains a NUL byte.");

        const absCwd = resolvePath(cwd);
        const stat = await statOrNull(absCwd);
        if (!stat) throw new Error(`Folder not found: ${absCwd}`);
        if (!stat.isDirectory()) throw new Error(`Not a folder: ${absCwd}`);

        const result = await runCommand(command, absCwd, timeout_ms);
        await logCommand(result);

        if (result.spawnError) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Error: could not start the command: ${result.spawnError.message}`,
              },
            ],
          };
        }

        return text(formatCommandResult(result));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "start_process",
    {
      title: "Start a background command",
      description:
        "Starts a shell command in the background and returns an id. Use " +
        "read_output to fetch what it prints and stop_process to stop it. " +
        "Good for dev servers, watchers and long builds that must keep running. " +
        "The process keeps running until stopped or until the server exits.",
      inputSchema: {
        command: z.string().min(1).describe("Command line, e.g. `npm run dev`"),
        cwd: z
          .string()
          .default(".")
          .describe("Working folder (relative to the root, or absolute inside it)"),
      },
    },
    async ({ command, cwd }) => {
      try {
        if (!command.trim()) throw new Error("The command is empty.");
        if (command.includes("\u0000")) throw new Error("The command contains a NUL byte.");

        const absCwd = resolvePath(cwd);
        const stat = await statOrNull(absCwd);
        if (!stat) throw new Error(`Folder not found: ${absCwd}`);
        if (!stat.isDirectory()) throw new Error(`Not a folder: ${absCwd}`);

        const record = startBackgroundProcess(command, absCwd);
        return text(
          `Started background process ${record.id} (pid ${record.pid}).\n` +
            `$ ${command}\nshell: ${record.shell} · folder: ${absCwd}\n\n` +
            `Read: read_output({ id: "${record.id}" })\n` +
            `Stop: stop_process({ id: "${record.id}" })`,
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "read_output",
    {
      title: "Read background process output",
      description:
        "Returns what a process started with start_process has printed so far, " +
        "plus its status and exit code. Set wait_ms to wait for the process to " +
        "finish (useful for builds). Set clear=true to drop the buffered output " +
        "after reading it.",
      inputSchema: {
        id: z.string().min(1).describe("Process id from start_process"),
        wait_ms: z
          .number()
          .int()
          .min(0)
          .max(30_000)
          .default(0)
          .describe("Wait up to this many milliseconds for the process to finish"),
        clear: z
          .boolean()
          .default(false)
          .describe("Clear the buffered stdout/stderr after reading"),
      },
    },
    async ({ id, wait_ms, clear }) => {
      try {
        const record = BACKGROUND.get(id);
        if (!record) throw new Error(`No background process with id "${id}".`);

        if (wait_ms > 0) await waitForExit(record, wait_ms);

        const output = formatProcessOutput(record);
        if (clear) {
          record.stdout = "";
          record.stderr = "";
          record.stdoutTruncated = false;
          record.stderrTruncated = false;
        }
        return text(output);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "stop_process",
    {
      title: "Stop a background process",
      description:
        "Stops a process started with start_process, killing its whole process " +
        "tree, and returns the final output.",
      inputSchema: {
        id: z.string().min(1).describe("Process id from start_process"),
      },
    },
    async ({ id }) => {
      try {
        const record = BACKGROUND.get(id);
        if (!record) throw new Error(`No background process with id "${id}".`);

        if (!record.finished) {
          killProcessTree(record.pid);
          await waitForExit(record, 5_000);
        }

        return text(
          (record.finished
            ? "Process stopped."
            : "Stop signal sent, but the process has not exited yet.") +
            `\n\n${formatProcessOutput(record)}`,
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "list_processes",
    {
      title: "List background processes",
      description: "Lists processes started with start_process in this session.",
      inputSchema: {},
    },
    async () => {
      try {
        const records = [...BACKGROUND.values()].sort(
          (a, b) => a.startedAt - b.startedAt,
        );
        if (!records.length) return text("No background processes.");

        const lines = records.map((record) => {
          const endedAt = record.finished ? record.endedAt : Date.now();
          const elapsed = ((endedAt - record.startedAt) / 1000).toFixed(1);
          const state = record.finished
            ? `finished (exit ${record.exitCode ?? "?"})`
            : "running";
          return (
            `${record.id}  ${state}  ${elapsed}s\n` +
            `  $ ${record.command}\n` +
            `  folder: ${shortName(record.cwd)}`
          );
        });

        return text(`${records.length} process(es):\n\n${lines.join("\n\n")}`);
      } catch (e) {
        return fail(e);
      }
    },
  );
}

/* -------------------------------------------------------------------------- */
/*                                   Startup                                 */
/* -------------------------------------------------------------------------- */

async function main() {
  if (!ALLOW_OUTSIDE) {
    for (const root of ROOTS) {
      try {
        await fs.access(root, fsConstants.R_OK | fsConstants.W_OK);
      } catch {
        console.error(
          `[claude-file-manager] Warning: no read/write access to ${root}.`,
        );
      }
    }
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Do not write to stdout — it is the protocol channel.
  console.error(
    `[claude-file-manager] started. Allowed folder(s):\n${ROOTS.map((root) => `  • ${root}`).join("\n")}`,
  );
  console.error(`[claude-file-manager] trash and backups: ${DATA_DIR}`);
  if (ALLOW_OUTSIDE) {
    console.error(
      "[claude-file-manager] MCP_ALLOW_OUTSIDE_ROOT=1 — paths outside the allowed folders are allowed.",
    );
  }
  if (ALLOW_SHELL) {
    console.error(
      `[claude-file-manager] MCP_ALLOW_SHELL=1 — terminal tools are enabled (shell: ${SHELL_MODE}).`,
    );
  }
}

process.on("exit", stopAllProcesses);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopAllProcesses();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error("[claude-file-manager] Startup error:", error);
  process.exit(1);
});
