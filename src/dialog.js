// Platform dispatcher for the sandbox Yes/No dialog. The command is shown
// in a black frame above the message text on every platform.

import { showSandboxDialog as showWindowsDialog } from "./win-sandbox.js";
import { showSandboxDialog as showMacDialog } from "./mac-dialog.js";

export async function showDialog({ command, message, detail }) {
  if (process.platform === "win32") {
    return showWindowsDialog({ command, message, detail });
  }
  if (process.platform === "darwin") {
    return showMacDialog({ command, message, detail });
  }
  // No dialog mechanism on other platforms — safe default.
  return "no";
}
