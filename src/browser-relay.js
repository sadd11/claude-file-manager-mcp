#!/usr/bin/env node
/**
 * HTTP-based relay for browser extensions (Chrome + Firefox).
 *
 * No external dependencies — pure node:http.
 *
 * Endpoints:
 *   POST /hello              — extension registers (body: { browser, version, tabId })
 *   GET  /command?id=<key>   — long-poll: extension waits for a command
 *   POST /result             — extension posts command result (body: { commandId, ok, data/error })
 *   GET  /browsers           — list connected browsers
 *   GET  /info               — relay connection info (for MCP clients)
 *
 * MCP-side API (in-process):
 *   relay.sendCommand({ browserId, action, target, value, timeoutMs }) -> Promise<result>
 */

import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";

const DEFAULT_PORT = 4318;

function randomId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        req.destroy();
        reject(new Error("Request too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

class BrowserRelay {
  constructor({ port = DEFAULT_PORT } = {}) {
    this.port = port;
    this.server = null;
    // key (browser:tabId) -> { ws-like info: { browser, version, tabId, connectedAt, lastPing } }
    this.browsers = new Map();
    // key -> { resolve, reject, timer } waiting for a command from MCP
    this.commandWaiters = new Map();
    // key -> pending command object to deliver on next /command poll
    this.pendingCommands = new Map();
    // commandId -> { resolve, reject, timer }
    this.pendingResults = new Map();
    this.commandCounter = 0;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        try {
          this.handleRequest(req, res).catch((err) => {
            sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
          });
        } catch (err) {
          sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
      });
      this.server.listen(this.port, () => resolve(this.port));
      this.server.on("error", reject);
    });
  }

  stop() {
    for (const record of this.pendingResults.values()) {
      clearTimeout(record.timer);
      record.reject(new Error("Relay stopped"));
    }
    this.pendingResults.clear();
    for (const record of this.commandWaiters.values()) {
      clearTimeout(record.timer);
      record.resolve(null); // signal no command
    }
    this.commandWaiters.clear();
    if (this.server) this.server.close();
  }

  async handleRequest(req, res) {
    const url = new URL(req.url || "/", `http://127.0.0.1`);
    const pathname = url.pathname;
    const method = req.method;

    if (pathname === "/hello" && method === "POST") {
      const body = await readBody(req);
      const browser = String(body.browser || "unknown");
      const version = String(body.version || "?");
      const tabId = String(body.tabId || "0");
      const key = `${browser}:${tabId}`;
      this.browsers.set(key, {
        browser,
        version,
        tabId,
        connectedAt: Date.now(),
        lastPing: Date.now(),
      });
      return sendJson(res, 200, { ok: true, key });
    }

    if (pathname === "/browsers" && method === "GET") {
      return sendJson(res, 200, {
        browsers: [...this.browsers.entries()].map(([key, info]) => ({
          key,
          ...info,
        })),
      });
    }

    if (pathname === "/info" && method === "GET") {
      return sendJson(res, 200, {
        port: this.port,
        url: `ws://127.0.0.1:${this.port}`,
        browsers: this.browsers.size,
      });
    }

    if (pathname === "/command" && method === "GET") {
      const key = url.searchParams.get("id");
      if (!key || !this.browsers.has(key)) {
        return sendJson(res, 400, { error: "Unknown browser id" });
      }
      // Update ping
      const info = this.browsers.get(key);
      info.lastPing = Date.now();

      // Deliver a buffered command immediately if one exists
      const buffered = this.pendingCommands.get(key);
      if (buffered) {
        this.pendingCommands.delete(key);
        return sendJson(res, 200, { command: buffered });
      }

      // Long-poll: wait up to 25s for a command
      const waitMs = Number(url.searchParams.get("wait")) || 25_000;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          this.commandWaiters.delete(key);
          resolve(sendJson(res, 200, { command: null }));
        }, waitMs);
        this.commandWaiters.set(key, { resolve, timer, res });
      });
    }

    if (pathname === "/result" && method === "POST") {
      const body = await readBody(req);
      const commandId = body.commandId;
      const record = this.pendingResults.get(commandId);
      if (record) {
        clearTimeout(record.timer);
        this.pendingResults.delete(commandId);
        if (body.ok === false) record.reject(new Error(body.error || "command failed"));
        else record.resolve(body.data);
      }
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 404, { error: "Not found" });
  }

  /** MCP-side: list connected browsers. */
  listBrowsers() {
    return [...this.browsers.entries()].map(([key, info]) => ({
      key,
      browser: info.browser,
      version: info.version,
      tabId: info.tabId,
    }));
  }

  resolveBrowser(browserId) {
    if (!browserId || browserId === "any") {
      const first = this.browsers.keys().next();
      return first.value || null;
    }
    if (browserId === "last") {
      const keys = [...this.browsers.keys()];
      return keys[keys.length - 1] || null;
    }
    if (this.browsers.has(browserId)) return browserId;
    for (const key of this.browsers.keys()) {
      if (key.startsWith(`${browserId}:`)) return key;
    }
    return null;
  }

  /** MCP-side: deliver a command to a browser via its long-poll /command endpoint. */
  notifyBrowser(key, command) {
    const waiter = this.commandWaiters.get(key);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.commandWaiters.delete(key);
      waiter.resolve(sendJson(waiter.res, 200, { command }));
      return true;
    }
    // No waiter: buffer the command for next poll
    this.pendingCommands.set(key, command);
    return false;
  }

  /** MCP-side: send a command and wait for the browser's result. */
  async sendCommand({ browserId = "any", action, target, value, timeoutMs = 10_000 }) {
    const key = this.resolveBrowser(browserId);
    if (!key) {
      throw new Error(
        `No browser connected. Open Chrome/Firefox with the extension installed at ws://127.0.0.1:${this.port}`,
      );
    }
    const info = this.browsers.get(key);

    // Mark that we have a command for this browser (in case it polls before the notify reaches)
    const commandId = randomId();
    const command = { type: "command", commandId, action, target, value };
    this.notifyBrowser(key, command);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingResults.delete(commandId);
        reject(new Error(`Browser command "${action}" timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pendingResults.set(commandId, { resolve, reject, timer });
    });
  }
}

const relay = new BrowserRelay();

export { BrowserRelay, relay, DEFAULT_PORT };
