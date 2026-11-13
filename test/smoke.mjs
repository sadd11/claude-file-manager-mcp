"use strict";
/* Cross-platform smoke test: speaks JSON-RPC over stdio with a real server
 * instance on a sandbox root. Run: npm test (needs no dev dependencies). */
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IS_WIN = process.platform === "win32";

const CMD_HELLO = IS_WIN ? "Write-Output 'привет мир'" : "printf 'привет мир\\n'";
const CMD_BIG = IS_WIN
  ? "1..30000 | ForEach-Object { 'line ' + $_ }"
  : "seq 1 30000 | sed 's/^/line /'";
const CMD_BG = IS_WIN
  ? "Write-Output 'фон запущен'; Start-Sleep -Seconds 60"
  : "printf 'фон запущен\\n'; sleep 60";

const results = [];
function check(name, cond, extra = "") {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !extra ? "" : "  >> " + extra}`);
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "cfm-smoke-"));
const root = path.join(sandbox, "root");
const outside = path.join(sandbox, "outside.txt");
await fsp.mkdir(root, { recursive: true });
await fsp.writeFile(outside, "secret", "utf8");

let finished = false;
let elicitMode = "decline"; // how the fake client answers elicitation/create
const elicitLog = [];

const server = spawn(process.execPath, [path.join(REPO, "src", "index.js")], {
  cwd: root,
  env: { ...process.env, MCP_FILE_ROOT: root, MCP_ALLOW_SHELL: "1" },
  stdio: ["pipe", "pipe", "pipe"],
});
let buffer = "";
let stderr = "";
const pending = new Map();
let nextId = 1;
server.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let idx;
  while ((idx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (process.env.SMOKE_TRACE) console.log(`  [trace] <- ${msg.method ?? "response"} id=${msg.id ?? "-"}`);
    if (msg.method === "elicitation/create" && msg.id !== undefined) {
      elicitLog.push(msg.params?.message ?? "");
      const accept = elicitMode === "accept";
      server.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: accept ? { action: "accept", content: { confirm: true } } : { action: "decline" },
        }) + "\n",
      );
      continue;
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});
server.stderr.on("data", (c) => {
  stderr += c.toString();
  if (stderr.length > 8000) stderr = stderr.slice(-8000);
});
server.on("exit", (code) => {
  if (!finished) check("server stays alive", false, `exited with ${code}: ${stderr}`);
});

function request(method, params) {
  const id = nextId++;
  if (process.env.SMOKE_TRACE) console.log(`  [trace] -> ${method} id=${id}`);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout on ${method}`)); }
    }, 30000);
  });
}

async function tool(name, args = {}) {
  const res = await request("tools/call", { name, arguments: args });
  if (res.error) throw new Error(`tool ${name}: ${res.error.message}`);
  const text = (res.result.content || []).map((c) => c.text || "").join("\n");
  return { text, isError: res.result.isError === true };
}
async function ok(name, args) {
  const r = await tool(name, args);
  if (r.isError) throw new Error(`${name} failed: ${r.text}`);
  return r.text;
}
async function err(name, args, needle) {
  const r = await tool(name, args);
  if (!r.isError) throw new Error(`${name} unexpectedly succeeded: ${r.text}`);
  if (needle && !r.text.includes(needle)) throw new Error(`${name}: expected "${needle}" in: ${r.text}`);
  return r.text;
}

try {
  await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: { elicitation: {} },
    clientInfo: { name: "smoke", version: "1.0" },
  });
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  /* 1. tool registry */
  const listed = await request("tools/list", {});
  check("28 tools registered (shell on)", listed.result.tools.length === 28, `got ${listed.result.tools.length}`);

  /* 2. read-before-edit guard */
  await fsp.writeFile(path.join(root, "blind.txt"), "v1", "utf8");
  await err("edit_file", { path: "blind.txt", old_string: "v1", new_string: "v2" }, "not read in this session");
  await ok("read_file", { path: "blind.txt" });
  await ok("edit_file", { path: "blind.txt", old_string: "v1", new_string: "v2" });
  check("read-before-edit guard", true);

  /* 3. freshness guard (external change detected) */
  await ok("read_file", { path: "blind.txt" });
  await fsp.writeFile(path.join(root, "blind.txt"), "external edit", "utf8");
  await err("edit_file", { path: "blind.txt", old_string: "external edit", new_string: "x" }, "changed since the last read");
  await ok("read_file", { path: "blind.txt" });
  await ok("edit_file", { path: "blind.txt", old_string: "external edit", new_string: "fresh" });
  check("freshness guard", true);

  /* 4. write_file overwrite also requires a read */
  await fsp.writeFile(path.join(root, "ow.txt"), "old", "utf8");
  await err("write_file", { path: "ow.txt", content: "new" }, "not read in this session");
  await ok("read_file", { path: "ow.txt" });
  await ok("write_file", { path: "ow.txt", content: "new" });
  check("write_file read guard", true);

  /* 5. search_content: output modes, offset, type filter */
  await ok("write_file", { path: "s1.ts", content: "alpha TARGET\nbeta\n" });
  await ok("write_file", { path: "s2.ts", content: "gamma TARGET\n" });
  await ok("write_file", { path: "s3.js", content: "delta TARGET\n" });
  const countOut = await ok("search_content", { query: "TARGET", output: "count" });
  check("count mode", /s1\.ts: 1/.test(countOut) && /s2\.ts: 1/.test(countOut) && /s3\.js: 1/.test(countOut), countOut);
  const typeOut = await ok("search_content", { query: "TARGET", output: "files", type: "ts" });
  check("type filter", typeOut.includes("s1.ts") && typeOut.includes("s2.ts") && !typeOut.includes("s3.js"), typeOut);
  const offOut = await ok("search_content", { query: "TARGET", output: "files", offset: 1, max_results: 1 });
  check("offset skips files", offOut.includes("s2.ts") && !offOut.includes("s1.ts"), offOut);
  const legacy = await ok("search_content", { query: "TARGET", files_only: true });
  check("files_only still works", legacy.includes("s3.js"), legacy);

  /* 6. find_files sorted by mtime (newest first) */
  await fsp.writeFile(path.join(root, "aaa_old.txt"), "x", "utf8");
  await new Promise((r) => setTimeout(r, 60));
  await fsp.writeFile(path.join(root, "zzz_new.txt"), "x", "utf8");
  const found = await ok("find_files", { pattern: "*.txt", max_results: 5 });
  check("mtime sort (newest first)", found.indexOf("zzz_new.txt") < found.indexOf("aaa_old.txt"), found);

  /* 7. head+tail truncation for run_command */
  const big = await ok("run_command", { command: CMD_BIG, timeout_ms: 120000 });
  check("head kept", /line 1\r?\n/.test(big), "no head");
  check("tail kept", big.includes("line 30000"), big.slice(-200));
  check("truncation marker", big.includes("characters hidden"), "");

  /* 8. PDF text extraction */
  const pdfText = [
    "%PDF-1.4",
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj",
    "4 0 obj << /Length 64 >> stream",
    "BT /F1 12 Tf 72 720 Td (Hello PDF) Tj 0 -20 Td (line two) Tj ET",
    "endstream endobj",
    "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
    "trailer << /Root 1 0 R >>",
    "%%EOF",
  ].join("\n");
  await fsp.writeFile(path.join(root, "doc.pdf"), pdfText, "latin1");
  const pdfOut = await ok("read_file", { path: "doc.pdf" });
  check("pdf text extracted", pdfOut.includes("Hello PDF") && pdfOut.includes("line two") && pdfOut.includes("1 page(s)"), pdfOut);
  await err("read_file", { path: "doc.pdf", page: 5 }, "page 5 does not exist");

  /* 9. notebook render + edit */
  const nb = {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {},
    cells: [
      { cell_type: "code", metadata: {}, source: "print('hi')", outputs: [{ output_type: "stream", text: "hi\n" }] },
      { cell_type: "markdown", metadata: {}, source: "# Title" },
    ],
  };
  await fsp.writeFile(path.join(root, "nb.ipynb"), JSON.stringify(nb, null, 1), "utf8");
  const nbOut = await ok("read_file", { path: "nb.ipynb" });
  check(
    "notebook rendered",
    nbOut.includes("cell 0 [code]") && nbOut.includes("print('hi')") && nbOut.includes("[output: stream]"),
    nbOut,
  );
  await ok("edit_notebook", { path: "nb.ipynb", mode: "replace", cell: 0, source: "print('bye')" });
  const nbOut2 = await ok("read_file", { path: "nb.ipynb" });
  check("notebook cell replaced", nbOut2.includes("print('bye')"));
  await ok("edit_notebook", { path: "nb.ipynb", mode: "insert", cell: 1, source: "x = 1", cell_type: "code" });
  const nbOut3 = await ok("read_file", { path: "nb.ipynb" });
  check("notebook cell inserted", nbOut3.includes("x = 1") && nbOut3.includes("3 cell(s)"), nbOut3);
  await ok("edit_notebook", { path: "nb.ipynb", mode: "insert", cell: 0, source: "# Intro", cell_type: "markdown" });
  const nbRaw = JSON.parse(await fsp.readFile(path.join(root, "nb.ipynb"), "utf8"));
  check(
    "markdown cell has no outputs field",
    nbRaw.cells[0].cell_type === "markdown" && !("outputs" in nbRaw.cells[0]),
    JSON.stringify(nbRaw.cells[0]).slice(0, 120),
  );
  await ok("edit_notebook", { path: "nb.ipynb", mode: "delete", cell: 0 });
  await ok("edit_notebook", { path: "nb.ipynb", mode: "delete", cell: 1 });
  const nbOut4 = await ok("read_file", { path: "nb.ipynb" });
  check("notebook cell deleted", !nbOut4.includes("x = 1") && nbOut4.includes("2 cell(s)"), nbOut4);
  await err("edit_notebook", { path: "nb.ipynb", mode: "replace", cell: 99, source: "y" }, "does not exist");

  /* 10. undo of a notebook edit */
  await ok("undo_last_change", { steps: 1 });
  const nbOut5 = await ok("read_file", { path: "nb.ipynb" });
  check("notebook edit undone", nbOut5.includes("x = 1"), nbOut5);

  /* 11. resources */
  const resList = await request("resources/list", {});
  const uris = (resList.result?.resources || []).map((r) => r.uri);
  check(
    "resources listed",
    ["file-manager://tree", "file-manager://activity", "file-manager://trash", "file-manager://backups", "file-manager://config"]
      .every((u) => uris.includes(u)),
    uris.join(","),
  );
  const cfg = await request("resources/read", { uri: "file-manager://config" });
  const cfgText = cfg.result?.contents?.[0]?.text ?? "";
  check("config resource", cfgText.includes("1.4.2") && cfgText.includes("allowShell"), cfgText.slice(0, 200));
  const treeRes = await request("resources/read", { uri: "file-manager://tree" });
  check("tree resource", (treeRes.result?.contents?.[0]?.text ?? "").includes("Tree:"), "");

  /* 12. elicitation on permanent delete */
  await fsp.writeFile(path.join(root, "gone.txt"), "bye", "utf8");
  await ok("read_file", { path: "gone.txt" });
  elicitMode = "decline";
  const declined = await ok("delete_path", { path: "gone.txt", permanent: true });
  check("decline cancels", declined.includes("Cancelled") && fs.existsSync(path.join(root, "gone.txt")), declined);
  elicitMode = "accept";
  const accepted = await ok("delete_path", { path: "gone.txt", permanent: true });
  check("accept deletes", accepted.includes("Permanently deleted") && !fs.existsSync(path.join(root, "gone.txt")), accepted);
  check("elicitation was requested", elicitLog.length >= 2, elicitLog.join(" | "));
  elicitMode = "decline";

  /* 13. basic regressions: move overwrite / zip / symlink / cyrillic */
  await ok("write_file", { path: "m1.txt", content: "one" });
  await ok("write_file", { path: "m2.txt", content: "two" });
  const moved = await ok("move_path", { source: "m1.txt", destination: "m2.txt", overwrite: true });
  check("move overwrite -> trash", moved.includes("moved to trash"));
  await ok("undo_last_change", { steps: 2 });
  const m2 = await ok("read_file", { path: "m2.txt" });
  check("move undo restored", m2.includes("two"));

  await ok("create_directory", { path: "zf" });
  await ok("write_file", { path: "zf/a.txt", content: "zip me" });
  await ok("zip_path", { sources: ["zf"], destination: "zf/all.zip" });
  const zip2 = await ok("zip_path", { sources: ["zf"], destination: "zf/all.zip", overwrite: true });
  check("zip skips itself", zip2.includes("itself was skipped"), zip2);

  let symlinkOk = true;
  try {
    await fsp.symlink("../outside.txt", path.join(root, "link.txt"), "file");
  } catch {
    symlinkOk = false;
    console.log("SKIP  symlink test (no symlink privilege)");
  }
  if (symlinkOk) {
    await err("read_file", { path: "link.txt" }, "symbolic link");
    check("symlink escape blocked", true);
  }

  const rootVariant = IS_WIN ? root.toUpperCase() : root;
  await err("delete_path", { path: rootVariant }, "root folder cannot be modified");
  check("root guard", true);

  const shell = await ok("run_command", { command: CMD_HELLO });
  check("cyrillic shell output", shell.includes("привет мир"), shell);

  const bg = await ok("start_process", { command: CMD_BG });
  const bgId = /background process (\S+)/.exec(bg)?.[1];
  const out = await ok("read_output", { id: bgId, wait_ms: 3000 });
  check("bg cyrillic output", out.includes("фон запущен"), out);
  await ok("stop_process", { id: bgId });
} catch (e) {
  check("test suite completed", false, e.message);
} finally {
  finished = true;
  server.kill();
  if (process.env.SMOKE_TRACE && stderr.trim()) console.error("SERVER STDERR:\n" + stderr);
  await fsp.rm(sandbox, { recursive: true, force: true }).catch(() => {});
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed (${IS_WIN ? "windows" : process.platform})`);
process.exit(failed.length ? 1 : 0);
