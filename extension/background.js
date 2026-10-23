// icit bridge extension - MV3 service worker.
// Keeps a WebSocket to the local bridge and executes tool calls against a target tab.

const DEFAULT_BRIDGE = "ws://127.0.0.1:8787/ext";
const PING_MS = 20_000; // keeps the service worker alive while connected (Chrome >= 116)

let ws = null;
let reconnectTimer = null;
let backoff = 1000;
let status = { connected: false, bridge: DEFAULT_BRIDGE, lastError: "" };

// ---------------------------------------------------------------- state

async function getBridgeUrl() {
  const { bridgeUrl } = await chrome.storage.local.get("bridgeUrl");
  return bridgeUrl || DEFAULT_BRIDGE;
}

async function getTargetTabId() {
  const { targetTabId } = await chrome.storage.session.get("targetTabId");
  return targetTabId ?? null;
}
async function setTargetTabId(id) {
  await chrome.storage.session.set({ targetTabId: id });
}

// Resolve the tab page_* tools act on: stored target, else the active tab.
async function resolveTab() {
  const stored = await getTargetTabId();
  if (stored != null) {
    try {
      return await chrome.tabs.get(stored);
    } catch {
      await setTargetTabId(null);
    }
  }
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!active) throw new Error("no target tab; call tabs_list and tab_select first");
  await setTargetTabId(active.id);
  return active;
}

// ---------------------------------------------------------------- connection

function connect() {
  clearTimeout(reconnectTimer);
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  getBridgeUrl().then((url) => {
    status.bridge = url;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      status.lastError = String(e);
      scheduleReconnect();
      return;
    }
    ws.onopen = () => {
      backoff = 1000;
      status.connected = true;
      status.lastError = "";
      chrome.action.setBadgeText({ text: "on" });
      chrome.action.setBadgeBackgroundColor({ color: "#2e7d32" });
      pingLoop();
    };
    ws.onmessage = (ev) => onMessage(ev.data);
    ws.onerror = () => {
      status.lastError = "websocket error (is the bridge running?)";
    };
    ws.onclose = () => {
      status.connected = false;
      chrome.action.setBadgeText({ text: "off" });
      chrome.action.setBadgeBackgroundColor({ color: "#9e9e9e" });
      ws = null;
      scheduleReconnect();
    };
  });
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, backoff);
  backoff = Math.min(backoff * 2, 15_000);
}

function pingLoop() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "ping" }));
  setTimeout(pingLoop, PING_MS);
}

async function onMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (msg.type !== "call") return;
  let reply;
  try {
    const result = await runTool(msg.tool, msg.args || {});
    reply = { id: msg.id, type: "result", ok: true, result };
  } catch (e) {
    reply = { id: msg.id, type: "result", ok: false, error: String(e?.message || e) };
  }
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(reply));
}

// ---------------------------------------------------------------- tools

async function runTool(tool, args) {
  switch (tool) {
    case "tabs_list": {
      const tabs = await chrome.tabs.query({});
      const target = await getTargetTabId();
      return tabs.map((t) => ({
        id: t.id,
        title: t.title,
        url: t.url,
        active: t.active,
        windowId: t.windowId,
        target: t.id === target,
      }));
    }
    case "tab_select": {
      const tab = await chrome.tabs.get(args.tabId);
      await setTargetTabId(tab.id);
      await chrome.tabs.update(tab.id, { active: true });
      return { ok: true, id: tab.id, title: tab.title, url: tab.url };
    }
    case "tab_open": {
      const tab = await chrome.tabs.create({ url: normalizeUrl(args.url), active: true });
      await setTargetTabId(tab.id);
      await waitForLoad(tab.id);
      const t = await chrome.tabs.get(tab.id);
      return { ok: true, id: t.id, title: t.title, url: t.url };
    }
    case "page_navigate": {
      const tab = await resolveTab();
      await chrome.tabs.update(tab.id, { url: normalizeUrl(args.url) });
      await waitForLoad(tab.id);
      const t = await chrome.tabs.get(tab.id);
      return { ok: true, title: t.title, url: t.url };
    }
    case "page_back": {
      const tab = await resolveTab();
      await chrome.tabs.goBack(tab.id);
      await waitForLoad(tab.id);
      const t = await chrome.tabs.get(tab.id);
      return { ok: true, title: t.title, url: t.url };
    }
    case "page_screenshot": {
      const tab = await resolveTab();
      await chrome.tabs.update(tab.id, { active: true });
      await sleep(150);
      const quality = clamp(args.quality ?? 50, 10, 90);
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality });
      return { type: "image", mediaType: "image/jpeg", data: dataUrl.split(",")[1] };
    }
    case "page_eval": {
      const tab = await resolveTab();
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: (code) => {
          try {
            const v = (0, eval)(code);
            let out;
            try {
              out = JSON.stringify(v);
            } catch {
              out = String(v);
            }
            return { ok: true, value: out === undefined ? "undefined" : out };
          } catch (e) {
            return { ok: false, error: String(e) };
          }
        },
        args: [String(args.code ?? "")],
      });
      if (!res?.result?.ok) throw new Error(res?.result?.error || "eval failed (page CSP may block eval)");
      return res.result.value;
    }
    case "page_snapshot":
    case "page_click":
    case "page_type":
    case "page_press":
    case "page_scroll":
    case "page_read": {
      const tab = await resolveTab();
      await ensureContentScript(tab.id);
      const res = await chrome.tabs.sendMessage(tab.id, { icit: true, tool, args });
      if (!res) throw new Error("no response from content script");
      if (res.error) throw new Error(res.error);
      return res.result;
    }
    default:
      throw new Error(`unknown tool ${tool}`);
  }
}

async function ensureContentScript(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { icit: true, tool: "__ping" });
    if (pong?.result === "pong") return;
  } catch {
    /* not injected yet */
  }
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
}

function waitForLoad(tabId, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      // give SPAs a moment to render
      setTimeout(resolve, 400);
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.get(tabId).then((t) => {
      if (t.status === "complete") setTimeout(() => finish(), 800);
    });
  });
}

function normalizeUrl(u) {
  u = String(u || "").trim();
  if (!/^[a-z]+:\/\//i.test(u)) u = "https://" + u;
  return u;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Number(n) || lo));

// ---------------------------------------------------------------- popup messaging

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.icitPopup) return;
  (async () => {
    switch (msg.cmd) {
      case "status":
        return sendResponse({ ...status, targetTabId: await getTargetTabId() });
      case "setBridge":
        await chrome.storage.local.set({ bridgeUrl: msg.url });
        if (ws) ws.close();
        else connect();
        return sendResponse({ ok: true });
      case "useCurrentTab": {
        const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (t) await setTargetTabId(t.id);
        return sendResponse({ ok: true, tab: t && { id: t.id, title: t.title } });
      }
      case "reconnect":
        if (ws) ws.close();
        else connect();
        return sendResponse({ ok: true });
    }
    sendResponse({ error: "unknown cmd" });
  })();
  return true;
});

// ---------------------------------------------------------------- lifecycle

chrome.runtime.onInstalled.addListener(() => chrome.alarms.create("icit-keepalive", { periodInMinutes: 0.5 }));
chrome.runtime.onStartup.addListener(() => chrome.alarms.create("icit-keepalive", { periodInMinutes: 0.5 }));
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "icit-keepalive") connect();
});
connect();
