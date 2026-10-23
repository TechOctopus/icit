// icit bridge: local server on the PC.
//
//   Chrome extension  --ws /ext-->  bridge  <--ws /client--  phone web harness (Safari)
//                                   bridge  <--POST /mcp---  any MCP client (Codex, Claude Code)
//                                   bridge  <--POST /api/call-- plain HTTP
//
// The bridge itself talks to no AI service. It only routes tool calls to the
// extension and serves the static phone UI from ./web.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { TOOLS, TOOL_NAMES } from "./tools.js";
import { handleMcp } from "./mcp.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, "..", "web");

const PORT = Number(process.env.ICIT_PORT || 8787);
const HOST = process.env.ICIT_HOST || "0.0.0.0";
const TOKEN = process.env.ICIT_TOKEN || ""; // optional shared secret for /client, /api, /mcp
const CALL_TIMEOUT_MS = Number(process.env.ICIT_CALL_TIMEOUT_MS || 90_000);

// ---------------------------------------------------------------- extension

let ext = null; // the single connected extension socket
const pending = new Map(); // callId -> {resolve, reject, timer}
let callSeq = 0;
const clients = new Set(); // phone/browser ws clients

export function extensionConnected() {
  return !!ext && ext.readyState === ext.OPEN;
}

export function callTool(tool, args = {}) {
  if (!TOOL_NAMES.has(tool)) return Promise.reject(new Error(`unknown tool: ${tool}`));
  if (!extensionConnected()) {
    return Promise.reject(new Error("extension is not connected to the bridge (open Chrome, check the extension popup)"));
  }
  const id = `c${++callSeq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`tool ${tool} timed out after ${CALL_TIMEOUT_MS}ms`));
    }, CALL_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    ext.send(JSON.stringify({ id, type: "call", tool, args }));
  });
}

function onExtMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (msg.type === "result" && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error || "tool failed"));
  } else if (msg.type === "event") {
    broadcast({ type: "event", event: msg.event, data: msg.data });
  }
}

function broadcast(obj) {
  const s = JSON.stringify(obj);
  for (const c of clients) if (c.readyState === c.OPEN) c.send(s);
}

function statusPayload() {
  return { type: "status", extensionConnected: extensionConnected(), clients: clients.size };
}

// ---------------------------------------------------------------- http

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

function authorized(req, url) {
  if (!TOKEN) return true;
  const h = req.headers.authorization || "";
  if (h === `Bearer ${TOKEN}`) return true;
  if (url.searchParams.get("token") === TOKEN) return true;
  return false;
}

function json(res, status, body) {
  const s = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, authorization, mcp-session-id, mcp-protocol-version",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  });
  res.end(s);
}

function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function serveStatic(req, res, pathname) {
  let rel = pathname === "/" ? "/index.html" : pathname;
  rel = path.normalize(rel).replace(/^(\.\.[/\\])+/, "");
  const file = path.join(WEB_DIR, rel);
  if (!file.startsWith(WEB_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }
  res.writeHead(200, {
    "content-type": MIME[path.extname(file)] || "application/octet-stream",
    "cache-control": "no-cache",
  });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const p = url.pathname;

  if (req.method === "OPTIONS") return json(res, 204, {});

  if (p === "/api/status") {
    return json(res, 200, { ok: true, ...statusPayload(), tools: TOOLS.length, version: "0.1.0" });
  }
  if (p === "/api/tools") return json(res, 200, { tools: TOOLS });

  if (p === "/api/call" && req.method === "POST") {
    if (!authorized(req, url)) return json(res, 401, { error: "unauthorized" });
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      const result = await callTool(body.tool, body.args || {});
      return json(res, 200, { ok: true, result });
    } catch (e) {
      return json(res, 200, { ok: false, error: String(e.message || e) });
    }
  }

  if (p === "/mcp") {
    if (!authorized(req, url)) return json(res, 401, { error: "unauthorized" });
    return handleMcp(req, res, { callTool, readBody, json });
  }

  if (req.method === "GET" || req.method === "HEAD") return serveStatic(req, res, p);
  json(res, 405, { error: "method not allowed" });
});

// ---------------------------------------------------------------- websockets

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/ext") {
    // Extension connections only from the local machine.
    const remote = req.socket.remoteAddress || "";
    const local = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    if (!local && !process.env.ICIT_ALLOW_REMOTE_EXT) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (ext && ext !== ws) {
        try {
          ext.close(4000, "replaced");
        } catch {}
      }
      ext = ws;
      log("extension connected");
      broadcast(statusPayload());
      ws.on("message", onExtMessage);
      ws.on("close", () => {
        if (ext === ws) {
          ext = null;
          log("extension disconnected");
          for (const [id, p] of pending) {
            clearTimeout(p.timer);
            p.reject(new Error("extension disconnected"));
            pending.delete(id);
          }
          broadcast(statusPayload());
        }
      });
      ws.on("error", () => {});
    });
    return;
  }
  if (url.pathname === "/client") {
    if (!authorized(req, url)) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws);
      log(`client connected (${req.socket.remoteAddress})`);
      ws.send(JSON.stringify(statusPayload()));
      ws.send(JSON.stringify({ type: "tools", tools: TOOLS }));
      ws.on("message", async (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw);
        } catch {
          return;
        }
        if (msg.type === "call") {
          try {
            const result = await callTool(msg.tool, msg.args || {});
            ws.send(JSON.stringify({ id: msg.id, type: "result", ok: true, result }));
          } catch (e) {
            ws.send(JSON.stringify({ id: msg.id, type: "result", ok: false, error: String(e.message || e) }));
          }
        } else if (msg.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
        }
      });
      ws.on("close", () => {
        clients.delete(ws);
        broadcast(statusPayload());
      });
      ws.on("error", () => {});
    });
    return;
  }
  socket.destroy();
});

// ---------------------------------------------------------------- start

function log(...a) {
  console.log(new Date().toISOString().slice(11, 19), ...a);
}

function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === "IPv4" && !a.internal) out.push({ name, address: a.address });
    }
  }
  return out;
}

server.listen(PORT, HOST, () => {
  log(`icit bridge listening on http://${HOST}:${PORT}`);
  log(`extension endpoint: ws://127.0.0.1:${PORT}/ext`);
  log(`MCP endpoint:       http://127.0.0.1:${PORT}/mcp`);
  const addrs = lanAddresses();
  if (addrs.length) {
    log("open on the phone (over the Bluetooth hotspot link, usually the 172.20.10.x one):");
    for (const a of addrs) log(`   http://${a.address}:${PORT}/${TOKEN ? `?token=${TOKEN}` : ""}   [${a.name}]`);
  }
});
