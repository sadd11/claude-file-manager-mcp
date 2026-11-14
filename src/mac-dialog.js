// macOS sandbox dialog: a native NSAlert with the command shown in a
// black-framed monospace box above the message text — the counterpart of
// the Windows WinForms dialog. Built through osascript -l JavaScript
// (JXA), so no extra dependencies are needed.

import { spawn } from "node:child_process";

function buildJxa({ command, message, detail }) {
  // JSON.stringify produces safe JS string literals for embedding.
  const cmd = JSON.stringify(command);
  const msg = JSON.stringify(message);
  const det = JSON.stringify(detail ?? "");
  return `
ObjC.import('Cocoa');
const command = ${cmd};
const message = ${msg};
const detail = ${det};

const alert = $.NSAlert.alloc.init;
alert.messageText = message;
alert.informativeText = detail;
alert.addButtonWithTitle('Yes');
alert.addButtonWithTitle('No');
alert.alertStyle = $.NSAlertStyleWarning;

// The command itself: monospace text on black, inside a black frame.
const box = $.NSTextView.alloc.initWithFrame($.NSMakeRect(0, 0, 460, 76));
box.string = command;
box.editable = false;
box.drawsBackground = true;
box.backgroundColor = $.NSColor.blackColor;
box.textColor = $.NSColor.whiteColor;
box.font = $.NSFont.userFixedPitchFontOfSize(12);
box.autoresizingMask = $.NSViewWidthSizable;

const scroll = $.NSScrollView.alloc.initWithFrame($.NSMakeRect(0, 0, 460, 76));
scroll.documentView = box;
scroll.hasVerticalScroller = true;
scroll.wantsLayer = true;
scroll.layer.borderColor = $.NSColor.blackColor.CGColor;
scroll.layer.borderWidth = 2;

alert.accessoryView = scroll;
const res = alert.runModal;
res === $.NSAlertFirstButtonReturn ? 'yes' : 'no';
`;
}

/**
 * Shows the native Yes/No dialog. Resolves "yes" or "no". Honors
 * CFM_DIALOG_AUTO=yes|no (tests); without a GUI session (SSH, CI) osascript
 * fails and the answer is "no".
 */
export async function showSandboxDialog({ command, message, detail }) {
  const auto = (process.env.CFM_DIALOG_AUTO || "").trim().toLowerCase();
  if (auto === "yes") return "yes";
  if (auto === "no") return "no";

  const script = buildJxa({ command, message, detail });
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const finish = (answer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(answer);
    };
    const timer = setTimeout(() => {
      // Nobody answered in 5 minutes — treat as "No".
      child.kill("SIGKILL");
      finish("no");
    }, 330_000);
    const child = spawn("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.on("error", () => finish("no"));
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("close", () => finish(out.trim().toLowerCase() === "yes" ? "yes" : "no"));
  });
}
