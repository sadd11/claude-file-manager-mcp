// Windows AppContainer sandbox helpers for run_command.
//
// MCP_SANDBOX=1 (Windows only) routes commands through src/win-sandbox.ps1:
// the command runs in a dedicated AppContainer profile that can write only
// inside the working folder and has no network access. When the sandbox
// infrastructure itself fails (profile, ACLs, launch), the user is asked via
// a custom dialog whether to run the command outside the sandbox.

import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SANDBOX_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(SANDBOX_DIR, "win-sandbox.ps1");
const DIALOG = path.join(SANDBOX_DIR, "win-dialog.ps1");

export const SANDBOX_ENABLED = /^(1|true|yes)$/i.test(process.env.MCP_SANDBOX || "");

const TRACE = process.env.CFM_SANDBOX_TRACE === "1";
function trace(...args) {
  if (TRACE) console.error("[sandbox]", ...args);
}

function runPowerShell(file, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const exe = process.env.SystemRoot
      ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
      : "powershell.exe";
    trace("spawn", path.basename(file), "args:", args.map((a) => (String(a).length > 60 ? String(a).slice(0, 60) + "…" : a)).join(" "));
    const child = spawn(exe,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file, ...args],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`PowerShell helper timed out after ${timeoutMs} ms`));
    }, timeoutMs);

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      trace("error:", error.message);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      trace("closed code=", code, "stdout:", stdout.length, "chars");
      resolve({ code, stdout, stderr });
    });
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
  });
}

/**
 * Runs the command inside the AppContainer. Resolves with a result object
 * compatible with runCommand(), or rejects with a plain Error describing the
 * infrastructure failure (profile, ACLs, launch) — the caller decides
 * whether to ask the user about running outside the sandbox.
 */
export async function runInAppContainer({ command, cwd, timeoutMs }) {
  // The wrapper does setup (profile, ACLs) before the timeout clock starts,
  // so give it generous headroom on top of the command's own timeout.
  const wrapperTimeout = timeoutMs + 180_000;

  const { stdout } = await runPowerShell(RUNNER, [
    "-UserCommand", command,
    "-WorkingDir", cwd,
    "-TimeoutMs", String(timeoutMs),
  ], wrapperTimeout);

  const lines = stdout.split(/\r?\n/).filter((line) => line.startsWith("{"));
  if (!lines.length) {
    throw new Error("the sandbox runner returned no result");
  }
  let payload;
  try {
    payload = JSON.parse(lines[lines.length - 1]);
  } catch {
    throw new Error("the sandbox runner returned an unreadable result");
  }
  if (!payload.ok) {
    throw new Error(`${payload.stage}: ${payload.error}`);
  }

  const [stdoutText, stderrText] = await Promise.all([
    fsReadIfExists(payload.outPath),
    fsReadIfExists(payload.errPath),
  ]);

  return {
    command,
    cwd,
    shell: "powershell (appcontainer)",
    code: payload.exitCode,
    signal: null,
    timedOut: Boolean(payload.timedOut),
    durationMs: payload.durationMs,
    stdout: stdoutText ?? "",
    stderr: stderrText ?? "",
    sandbox: "appcontainer",
    spawnError: null,
  };
}

async function fsReadIfExists(file) {
  try {
    // PS 5.1 "utf8" writes a BOM — strip it so output stays clean.
    return (await readFile(file, "utf8")).replace(/^\uFEFF/, "");
  } catch {
    return "";
  }
}

/**
 * Shows the custom Yes/No dialog (not an OS message box). The command is
 * displayed in a black frame above the message text. Resolves "yes" or "no".
 */
export async function showSandboxDialog({ command, message, detail }) {
  try {
    const { stdout } = await runPowerShell(DIALOG, [
      "-Message", message,
      "-Command", command,
      "-Detail", detail ?? "",
    ], 330_000);
    return stdout.trim().toLowerCase() === "yes" ? "yes" : "no";
  } catch {
    return "no";
  }
}
