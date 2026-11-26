// Content script for the Claude File Manager browser extension.
// Registers with the local HTTP relay, polls for commands, and executes them
// in the page context (DOM click/type/navigate/evaluate).
//
// Screenshots are delegated to the background script (chrome.tabs.captureVisibleTab).

const RELAY_URL = "http://127.0.0.1:4318";

let browserKey = null;
let polling = false;

async function post(path, body) {
  const res = await fetch(`${RELAY_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function register() {
  const isFirefox = navigator.userAgent.toLowerCase().includes("firefox");
  const data = await post("/hello", {
    browser: isFirefox ? "firefox" : "chrome",
    version: navigator.userAgent,
    tabId: 0,
  });
  browserKey = data.key;
  console.log("[CFM browser extension] registered as", browserKey);
}

async function pollCommands() {
  if (!browserKey || polling) return;
  polling = true;
  try {
    const res = await fetch(
      `${RELAY_URL}/command?id=${encodeURIComponent(browserKey)}&wait=25000`,
    );
    const data = await res.json();
    polling = false;
    if (data && data.command) {
      try {
        const result = await executeCommand(data.command);
        await post("/result", {
          commandId: data.command.commandId,
          ok: true,
          data: result,
        });
      } catch (e) {
        await post("/result", {
          commandId: data.command.commandId,
          ok: false,
          error: e.message,
        });
      }
    }
  } catch (e) {
    polling = false;
    console.error("[CFM browser extension] poll error", e);
  }
  setTimeout(pollCommands, 500);
}

async function executeCommand(command) {
  const { action, target, value } = command;
  switch (action) {
    case "navigate":
      window.location.href = target;
      return { navigated: target };
    case "click":
      return doClick(target);
    case "type":
      return doType(target, value);
    case "evaluate":
      return doEvaluate(value);
    case "get-title":
      return { title: document.title };
    case "get-url":
      return { url: window.location.href };
    case "screenshot":
      return await doScreenshot();
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

function doClick(selector) {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`Element not found: ${selector}`);
  el.click();
  return { clicked: selector };
}

function doType(selector, text) {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`Element not found: ${selector}`);
  el.focus();
  el.value = text;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { typed: selector, length: String(text).length };
}

function doEvaluate(script) {
  try {
    const fn = new Function("return (" + script + ")");
    const result = fn();
    return JSON.stringify(result);
  } catch (e) {
    // Try as a statement
    const fn2 = new Function(script);
    fn2();
    return { evaluated: true };
  }
}

async function doScreenshot() {
  try {
    const resp = await chrome.runtime.sendMessage({ action: "captureVisibleTab" });
    if (resp.ok) {
      return { screenshot: resp.data }; // data URL (base64 PNG)
    }
    throw new Error(resp.error || "screenshot failed");
  } catch (e) {
    throw new Error(`Screenshot unavailable: ${e.message}`);
  }
}

// Start
register().catch((e) => {
  console.error("[CFM browser extension] register failed", e);
  setTimeout(register, 3000);
});
