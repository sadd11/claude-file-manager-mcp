#!/usr/bin/env node
/**
 * Desktop automation: screenshots, mouse, keyboard, opening files/programs.
 * Cross-platform, using only Node.js built-ins + platform tools (no native npm deps).
 *
 * Windows:   PowerShell + WScript.Shell + P/Invoke
 * macOS:     screencapture / osascript (System Events)
 * Linux:     scrot / gnome-screenshot / import / xdotool / xdg-open
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const PLATFORM = process.platform;
const IS_WIN = PLATFORM === "win32";
const IS_MAC = PLATFORM === "darwin";

function randomId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}

function runSync(file, args, options = {}) {
  try {
    const result = spawnSync(file, args, {
      windowsHide: true,
      encoding: "utf8",
      ...options,
    });
    return {
      code: result.status ?? -1,
      stdout: result.stdout ? result.stdout.toString() : "",
      stderr: result.stderr ? result.stderr.toString() : "",
      error: result.error ? String(result.error) : null,
    };
  } catch (e) {
    return { code: -1, stdout: "", stderr: String(e), error: String(e) };
  }
}

/* ---------------------------------- screenshots ----------------------------- */

async function captureScreen({ outputPath, quality = 90 }) {
  if (IS_WIN) return captureScreenWin(outputPath, quality);
  if (IS_MAC) return captureScreenMac(outputPath);
  return captureScreenLinux(outputPath);
}

function captureScreenWin(outputPath, quality) {
  const ps = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$screen = [System.Windows.Forms.Screen]::PrimaryScreen
$bounds = $screen.Bounds
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bounds.Size)
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.FormatID -eq [System.Drawing.Imaging.ImageFormat]::Png.Guid }
$params = New-Object System.Drawing.Imaging.EncoderParameters 1
$params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality, [long]${quality})
$bitmap.Save("${outputPath.replace(/\\/g, "\\\\")}", $codec, $params)
$graphics.Dispose()
$bitmap.Dispose()
`;
  return runSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps]);
}

function captureScreenMac(outputPath) {
  return runSync("screencapture", ["-x", "-t", "png", outputPath]);
}

function captureScreenLinux(outputPath) {
  const tools = [
    ["scrot", [outputPath]],
    ["gnome-screenshot", ["-f", outputPath]],
    ["import", ["-window", "root", outputPath]],
  ];
  for (const [file, args] of tools) {
    const result = runSync(file, args);
    try {
      if (result.code === 0 && fs.existsSync(outputPath)) return result;
    } catch {
      /* ignore */
    }
  }
  return { code: -1, stdout: "", stderr: "No screenshot tool found (install scrot, gnome-screenshot, or ImageMagick)." };
}

async function captureWindow({ identifier, outputPath, quality = 90 }) {
  if (IS_WIN) return captureWindowWin(identifier, outputPath, quality);
  if (IS_MAC) return captureWindowMac(identifier, outputPath);
  return captureWindowLinux(identifier, outputPath);
}

function captureWindowWin(identifier, outputPath, quality) {
  const safeTitle = identifier.replace(/'/g, "''");
  const ps = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
$win = [Win]::FindWindow($null, "${safeTitle}")
if ($win -eq [IntPtr]::Zero) { Write-Error "Window not found: ${identifier}"; exit 1 }
[Win]::GetWindowRect($win, [ref]$rect)
$w = $rect.Right - $rect.Left
$h = $rect.Bottom - $rect.Top
if ($w -le 0 -or $h -le 0) { Write-Error "Window has zero size"; exit 1 }
$bitmap = New-Object System.Drawing.Bitmap $w $h
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$dc = $graphics.GetHdc()
[Win]::PrintWindow($win, $dc, 0)
$graphics.ReleaseHdc($dc)
$graphics.Dispose()
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.FormatID -eq [System.Drawing.Imaging.ImageFormat]::Png.Guid }
$params = New-Object System.Drawing.Imaging.EncoderParameters 1
$params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality, [long]${quality})
$bitmap.Save("${outputPath.replace(/\\/g, "\\\\")}", $codec, $params)
$bitmap.Dispose()
`;
  return runSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps]);
}

function captureWindowMac(identifier, outputPath) {
  const script = `
tell application "System Events"
  set procs to (every process whose name contains "${identifier}")
  if (count of procs) = 0 then error "no process"
  set targetWindow to first window of first item of procs
  set winId to id of targetWindow
end tell
return winId
`;
  const idResult = runSync("osascript", ["-e", script]);
  if (idResult.code !== 0) return idResult;
  const winId = idResult.stdout.trim();
  if (!winId) return { code: -1, stdout: "", stderr: `Window not found: ${identifier}` };
  return runSync("screencapture", ["-l", winId, "-t", "png", outputPath]);
}

function captureWindowLinux(identifier, outputPath) {
  const idResult = runSync("xwininfo", ["-name", identifier]);
  if (idResult.code !== 0) return idResult;
  const m = idResult.stdout.match(/Window id: (0x[0-9a-f]+)/i) || idResult.stdout.match(/window id: (0x[0-9a-f]+)/i);
  if (!m) return { code: -1, stdout: "", stderr: `Window not found: ${identifier}` };
  return runSync("import", ["-window", m[1], outputPath]);
}

/* ---------------------------------- open file / program --------------------- */

function openPath({ target }) {
  if (IS_WIN) {
    // `start "" "target"` — empty title to avoid interpreting path as window title
    return runSync("cmd.exe", ["/c", "start", "", "", target]);
  }
  if (IS_MAC) {
    return runSync("open", [target]);
  }
  return runSync("xdg-open", [target]);
}

/* ---------------------------------- mouse ----------------------------------- */

function mouseMove({ x, y }) {
  if (IS_WIN) {
    const ps = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class M {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
}
"@
[M]::SetCursorPos(${x}, ${y})
`;
    return runSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps]);
  }
  if (IS_MAC) {
    const script = `tell application "System Events" to set position of mouse to {${x}, ${y}}`;
    return runSync("osascript", ["-e", script]);
  }
  return runSync("xdotool", ["mousemove", String(x), String(y)]);
}

function mouseClick({ x, y, button = "left", count = 1 }) {
  const n = Math.max(1, Math.min(count, 10));
  if (IS_WIN) {
    const down = button === "right" ? 0x0008 : 0x0002; // MOUSEEVENTF_RIGHTDOWN / LEFTDOWN
    const up = button === "right" ? 0x0010 : 0x0004;   // MOUSEEVENTF_RIGHTUP / LEFTUP
    const ps = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class M {
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, uint dwExtraInfo);
}
"@
for ($i = 0; $i -lt ${n}; $i++) {
  [M]::mouse_event(${down}, ${x}, ${y}, 0, 0)
  [M]::mouse_event(${up}, ${x}, ${y}, 0, 0)
}
`;
    return runSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps]);
  }
  if (IS_MAC) {
    const btn = button === "right" ? "right" : "left";
    const script = `tell application "System Events" to click at {${x}, ${y}}`;
    return runSync("osascript", ["-e", script]);
  }
  return runSync("xdotool", ["click", "--repeat", String(n), button === "right" ? "3" : "1"]);
}

function mouseDrag({ x1, y1, x2, y2 }) {
  if (IS_WIN) {
    const ps = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class M {
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, uint dwExtraInfo);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
}
"@
[M]::SetCursorPos(${x1}, ${y1})
[M]::mouse_event(0x0002, 0, 0, 0, 0)
Start-Sleep -Milliseconds 50
[M]::SetCursorPos(${x2}, ${y2})
[M]::mouse_event(0x0004, 0, 0, 0, 0)
`;
    return runSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps]);
  }
  if (IS_MAC) {
    // macOS System Events does not support drag at arbitrary screen
    // coordinates directly. Best-effort: move to start, press, move to end,
    // release. The press/release use left mouse button down/up via a small
    // AppleScript helper that posts events through the accessibility API.
    const script = `
tell application "System Events"
  set position of mouse to {${x1}, ${y1}}
  key down mouse
  set position of mouse to {${x2}, ${y2}}
  key up mouse
end tell
`;
    // The above "key down mouse" is not valid AppleScript; fall back to just
    // moving the cursor so the action does not crash. A real drag requires
    // third-party tools (e.g. cliclick) which we intentionally do not depend on.
    const move = runSync("osascript", [
      "-e",
      `tell application "System Events" to set position of mouse to {${x2}, ${y2}}`,
    ]);
    return move.code === 0
      ? { code: 0, stdout: "moved (drag not natively supported on macOS without cliclick)", stderr: "" }
      : move;
  }
  return runSync("xdotool", ["mousedown", "1", "mousemove", String(x2), String(y2), "mouseup", "1"]);
}

function mouseScroll({ x, y, deltaX = 0, deltaY = 0 }) {
  if (IS_WIN) {
    const clicks = deltaY > 0 ? Math.abs(deltaY) : -Math.abs(deltaY);
    const ps = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class M {
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, uint dwExtraInfo);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
}
"@
[M]::SetCursorPos(${x}, ${y})
[M]::mouse_event(0x0800, 0, 0, ${clicks * 120}, 0)
`;
    return runSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps]);
  }
  if (IS_MAC) {
    // macOS System Events scroll requires a scrollable UI element, not raw
    // screen coordinates. Best-effort: move the cursor to (x, y) so the user
    // sees where the scroll would target; the actual scroll is a no-op here
    // without third-party tools. This keeps the call from crashing.
    const move = runSync("osascript", [
      "-e",
      `tell application "System Events" to set position of mouse to {${x}, ${y}}`,
    ]);
    if (move.code !== 0) return move;
    return {
      code: 0,
      stdout: `moved to (${x}, ${y}) (scroll at raw coordinates not natively supported on macOS)`,
      stderr: "",
    };
  }
  return runSync("xdotool", ["mousemove", String(x), String(y), "click", deltaY > 0 ? "5" : "4"]);
}

/* ---------------------------------- keyboard -------------------------------- */

function keyboardType({ text }) {
  if (IS_WIN) {
    // SendKeys special chars: + ^ % ~ ( ) [ ] { }
    const escaped = text
      .replace(/\{/g, "{{}")
      .replace(/\}/g, "{}}")
      .replace(/\[/g, "{[}")
      .replace(/\]/g, "{]}")
      /*.replace(/\(/g, "{(}").replace(/\)/g, "{)}")*/
      .replace(/\+/g, "{+}")
      .replace(/\^/g, "{^}")
      .replace(/%/g, "{%}")
      .replace(/~/g, "{~}");
    const ps = `
$wshell = New-Object -ComObject WScript.Shell
$wshell.SendKeys("${escaped}")
`;
    return runSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps]);
  }
  if (IS_MAC) {
    // Escape backslashes and quotes for AppleScript
    const safe = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
    const script = `tell application "System Events" to keystroke "${safe}"`;
    return runSync("osascript", ["-e", script]);
  }
  return runSync("xdotool", ["type", "--", text]);
}

function keyboardPress({ keys }) {
  const list = Array.isArray(keys) ? keys : [keys];
  if (IS_WIN) {
    // SendKeys modifier codes: ^ ctrl, + shift, % alt
    const mods = { ctrl: "^", shift: "+", alt: "%" };
    const sequence = list.map((k) => {
      const key = String(k).toLowerCase();
      if (mods[key]) return `{${mods[key]}}`;
      return `{${key}}`;
    }).join("");
    const ps = `
$wshell = New-Object -ComObject WScript.Shell
$wshell.SendKeys("${sequence}")
`;
    return runSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps]);
  }
  if (IS_MAC) {
    const map = { ctrl: "control", shift: "shift", alt: "option", cmd: "command", command: "command" };
    const mods = [];
    const normal = [];
    for (const k of list) {
      const key = String(k).toLowerCase();
      if (map[key]) mods.push(`key down ${map[key]}`);
      else normal.push(`keystroke "${key}"`);
    }
    const script = `tell application "System Events"\n${mods.join("\n")}\n${normal.join("\n")}\n${mods.reverse().map((m) => m.replace("down", "up")).join("\n")}\nend tell`;
    return runSync("osascript", ["-e", script]);
  }
  // xdotool: key down modifiers, press key, key up modifiers
  const args = [];
  for (const k of list) {
    const key = String(k).toLowerCase();
    if (key === "ctrl" || key === "shift" || key === "alt" || key === "super" || key === "cmd") {
      args.push("keydown", key);
    } else {
      args.push("key", key);
    }
  }
  for (let i = list.length - 1; i >= 0; i--) {
    const key = String(list[i]).toLowerCase();
    if (key === "ctrl" || key === "shift" || key === "alt" || key === "super" || key === "cmd") {
      args.push("keyup", key);
    }
  }
  return runSync("xdotool", args);
}

/* ---------------------------------- clipboard ------------------------------- */

function clipboardRead() {
  if (IS_WIN) {
    const ps = `$wshell = New-Object -ComObject WScript.Shell; $wshell.SendKeys("^{v}");`;
    // Simpler: use Get-Clipboard if available
    const ps2 = "Get-Clipboard -Raw 2>$null";
    return runSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps2]);
  }
  if (IS_MAC) {
    return runSync("pbpaste", []);
  }
  return runSync("xsel", ["--clipboard", "--output"]);
}

function clipboardWrite({ text }) {
  if (IS_WIN) {
    const safe = text.replace(/"/g, '`"');
    const ps = `Set-Clipboard -Value "${safe}"`;
    return runSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps]);
  }
  if (IS_MAC) {
    return runSync("pbcopy", [], { input: text });
  }
  return runSync("xsel", ["--clipboard", "--input"], { input: text });
}

/* ---------------------------------- control overlay -------------------------- */

/**
 * Shows a local on-screen permission dialog "AI wants to control your computer"
 * with Allow / Deny buttons. Returns "yes" / "no" / null (if dialog could not
 * be shown). Used as a fallback when the MCP client cannot show an elicitation.
 */
function showPermissionDialog({ message, detail }) {
  if (IS_WIN) {
    const safeMsg = message.replace(/'/g, "''").replace(/"/g, '\\"');
    const safeDet = detail ? detail.replace(/'/g, "''").replace(/"/g, '\\"') : "";
    const ps = `
Add-Type -AssemblyName System.Windows.Forms
$form = New-Object System.Windows.Forms.Form
$form.Size = New-Object System.Drawing.Size(520, 220)
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.Text = "Claude File Manager — Разрешение на управление"

$msg = New-Object System.Windows.Forms.Label
$msg.Text = "${safeMsg}"
$msg.Font = New-Object System.Drawing.Font("Segoe UI", 11, [System.Drawing.FontStyle]::Bold)
$msg.Location = New-Object System.Drawing.Point(20, 20)
$msg.Size = New-Object System.Drawing.Size(480, 40)
$form.Controls.Add($msg)

$det = New-Object System.Windows.Forms.Label
$det.Text = "${safeDet}"
$det.Font = New-Object System.Drawing.Font("Segoe UI", 9)
$det.ForeColor = [System.Drawing.Color]::Gray
$det.Location = New-Object System.Drawing.Point(20, 60)
$det.Size = New-Object System.Drawing.Size(480, 50)
$form.Controls.Add($det)

$btnYes = New-Object System.Windows.Forms.Button
$btnYes.Text = "Разрешить"
$btnYes.DialogResult = [System.Windows.Forms.DialogResult]::Yes
$btnYes.Location = New-Object System.Drawing.Point(140, 140)
$btnYes.Size = New-Object System.Drawing.Size(110, 32)
$btnYes.BackColor = [System.Drawing.Color]::Green
$btnYes.ForeColor = [System.Drawing.Color]::White
$form.Controls.Add($btnYes)

$btnNo = New-Object System.Windows.Forms.Button
$btnNo.Text = "Запретить"
$btnNo.DialogResult = [System.Windows.Forms.DialogResult]::No
$btnNo.Location = New-Object System.Drawing.Point(270, 140)
$btnNo.Size = New-Object System.Drawing.Size(110, 32)
$btnNo.BackColor = [System.Drawing.Color]::Red
$btnNo.ForeColor = [System.Drawing.Color]::White
$form.Controls.Add($btnNo)

$form.AcceptButton = $btnYes
$form.CancelButton = $btnNo
$result = $form.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::Yes) { [Console]::Out.WriteLine("yes") }
elseif ($result -eq [System.Windows.Forms.DialogResult]::No) { [Console]::Out.WriteLine("no") }
else { [Console]::Out.WriteLine("cancel") }
`;
    const res = runSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps]);
    const out = res.stdout.trim().toLowerCase();
    if (out === "yes") return "yes";
    if (out === "no") return "no";
    return null;
  }
  if (IS_MAC) {
    const safeMsg = message.replace(/"/g, '\\"');
    const safeDet = detail ? detail.replace(/"/g, '\\"') : "";
    const script = `button returned of (display dialog "${safeMsg}" & "\\n\\n${safeDet}" buttons {"Запретить", "Разрешить"} default button "Разрешить" cancel button "Запретить" with title "Claude File Manager — Разрешение на управление" with icon caution)`;
    const res = runSync("osascript", ["-e", script]);
    const out = res.stdout.trim().toLowerCase();
    if (out.includes("разрешить")) return "yes";
    if (out.includes("запретить")) return "no";
    return null;
  }
  // Linux: zenity question dialog
  const safeMsg = message.replace(/"/g, '\\"');
  const safeDet = detail ? detail.replace(/"/g, '\\"') : "";
  const text = safeDet ? `${safeMsg}\\n\\n${safeDet}` : safeMsg;
  const res = runSync("zenity", [
    "--question",
    "--title=Claude File Manager — Разрешение на управление",
    `--text=${text}`,
    "--ok-label=Разрешить",
    "--cancel-label=Запретить",
    "--timeout=30",
  ]);
  if (res.code === 0) return "yes";
  if (res.code === 1) return "no";
  return null;
}

/**
 * Shows a prominent on-screen notification "AI is controlling your computer"
 * so the user is visually aware that automation is active. Best-effort: if the
 * platform tool is missing, it silently returns success.
 */
function showControlOverlay() {
  if (IS_WIN) {
    const ps = `
Add-Type -AssemblyName System.Windows.Forms
$form = New-Object System.Windows.Forms.Form
$form.Size = New-Object System.Drawing.Size(500, 140)
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true
$form.FormBorderStyle = 'FixedSingle'
$form.MaximizeBox = $false
$form.BackColor = [System.Drawing.Color]::FromArgb(255, 240, 240)
$label = New-Object System.Windows.Forms.Label
$label.Text = "AI is controlling your computer"
$label.ForeColor = [System.Drawing.Color]::DarkRed
$label.Font = New-Object System.Drawing.Font("Arial", 16, [System.Drawing.FontStyle]::Bold)
$label.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter
$label.Dock = [System.Windows.Forms.DockStyle]::Fill
$form.Controls.Add($label)
$form.Show()
Start-Sleep -Milliseconds 2500
$form.Close()
`;
    return runSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", ps]);
  }
  if (IS_MAC) {
    const script = `display notification "AI is controlling your computer" with title "Claude File Manager" sound name "Basso"`;
    return runSync("osascript", ["-e", script]);
  }
  return runSync("zenity", ["--warning", "--text=AI is controlling your computer", "--timeout=3", "--no-wrap"]);
}

export {
  captureScreen,
  captureWindow,
  openPath,
  mouseMove,
  mouseClick,
  mouseDrag,
  mouseScroll,
  keyboardType,
  keyboardPress,
  clipboardRead,
  clipboardWrite,
  showControlOverlay,
  showPermissionDialog,
};
