// icit phone harness. Runs in Safari on the phone, talks to:
//   - the bridge on the PC over the Bluetooth hotspot link (WebSocket, tool calls)
//   - the Anthropic API over the phone's own cellular connection
// The PC never sees the API key or the model traffic.

import Anthropic from "@anthropic-ai/sdk";

// ------------------------------------------------------------------ settings

const LS = "icit.settings";
const settings = Object.assign(
  { apiKey: "", model: "claude-opus-5-5", effort: "medium", baseUrl: "", token: "" },
  JSON.parse(localStorage.getItem(LS) || "{}"),
);
function saveSettings() {
  localStorage.setItem(LS, JSON.stringify(settings));
}

const $ = (id) => document.getElementById(id);
const log = $("log");

// ------------------------------------------------------------------ bridge ws

let ws = null;
let tools = []; // Anthropic tool definitions, delivered by the bridge
let extConnected = false;
const pending = new Map();
let seq = 0;

function wsUrl() {
  const u = new URL(location.href);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = "/client";
  u.search = settings.token ? `?token=${encodeURIComponent(settings.token)}` : "";
  return u.toString();
}

function connectBridge() {
  if (ws) {
    try {
      ws.close();
    } catch {}
  }
  ws = new WebSocket(wsUrl());
  ws.onopen = () => setDot("bridgeDot", true);
  ws.onclose = () => {
    setDot("bridgeDot", false);
    setDot("extDot", false);
    for (const [id, p] of pending) {
      p.reject(new Error("bridge disconnected"));
      pending.delete(id);
    }
    setTimeout(connectBridge, 1500);
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "status") {
      extConnected = msg.extensionConnected;
      setDot("extDot", extConnected);
    } else if (msg.type === "tools") {
      tools = msg.tools;
    } else if (msg.type === "result" && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error));
    }
  };
}

function callTool(tool, args) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("bridge is not connected"));
  const id = `t${++seq}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, type: "call", tool, args }));
  });
}

function setDot(id, on) {
  $(id).classList.toggle("on", !!on);
}

// ------------------------------------------------------------------ ui helpers

function addMsg(cls, text) {
  const d = document.createElement("div");
  d.className = `msg ${cls}`;
  d.textContent = text;
  log.appendChild(d);
  scrollToEnd();
  return d;
}

function addTool(name, input) {
  const det = document.createElement("details");
  det.className = "tool pending";
  const sum = document.createElement("summary");
  sum.innerHTML = `<b>${esc(name)}</b> ${esc(shortArgs(input))}`;
  det.appendChild(sum);
  log.appendChild(det);
  scrollToEnd();
  return {
    done(result) {
      det.classList.remove("pending");
      if (result && result.type === "image") {
        const img = document.createElement("img");
        img.src = `data:${result.mediaType};base64,${result.data}`;
        det.appendChild(img);
        det.open = true;
      } else {
        const pre = document.createElement("pre");
        pre.textContent = typeof result === "string" ? result : JSON.stringify(result, null, 2);
        det.appendChild(pre);
      }
      scrollToEnd();
    },
    fail(err) {
      det.classList.remove("pending");
      det.classList.add("failed");
      const pre = document.createElement("pre");
      pre.textContent = String(err);
      det.appendChild(pre);
      det.open = true;
      scrollToEnd();
    },
  };
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
function shortArgs(a) {
  const s = JSON.stringify(a || {});
  return s === "{}" ? "" : s.length > 90 ? s.slice(0, 89) + "…" : s;
}
function scrollToEnd() {
  requestAnimationFrame(() => (log.scrollTop = log.scrollHeight));
}

// ------------------------------------------------------------------ agent loop

const SYSTEM = `You are operating a Chrome tab on the user's PC through tools. The user is on a phone and sees only this chat.

Approach:
- Start with page_snapshot (or tabs_list if unsure which tab) to see the page. Use the [ref] numbers from the latest snapshot for page_click / page_type / page_read; refs change on every snapshot.
- Prefer page_snapshot over page_screenshot: the link to the PC is a slow Bluetooth connection. Take a screenshot only when layout or visuals matter.
- After an action that changes the page, take a fresh snapshot before acting again.
- Be brief in prose: report what you did and what you see. If something needs the user's decision (login, payment, destructive action), stop and ask.`;

let messages = [];
let abort = null;
let client = null;

function makeClient() {
  if (!settings.apiKey) throw new Error("Задай Anthropic API key в настройках (⚙︎)");
  return new Anthropic({
    apiKey: settings.apiKey,
    baseURL: settings.baseUrl || undefined,
    dangerouslyAllowBrowser: true,
    maxRetries: 2,
  });
}

function requestParams() {
  const p = {
    model: settings.model,
    max_tokens: 16000,
    system: SYSTEM,
    tools,
    messages,
    output_config: { effort: settings.effort },
    betas: [],
  };
  // Server-side refusal fallback: not available on Haiku.
  if (!settings.model.startsWith("claude-haiku")) {
    p.betas.push("server-side-fallback-2026-07-01");
    p.fallbacks = "default";
  }
  return p;
}

async function runTurn(userText) {
  client = client || makeClient();
  messages.push({ role: "user", content: userText });
  abort = new AbortController();
  $("btnSend").hidden = true;
  $("btnStop").hidden = false;
  $("input").disabled = true;

  try {
    for (let step = 0; step < 60; step++) {
      const thinking = addMsg("system", "думаю…");
      let response;
      try {
        response = await client.beta.messages
          .stream(requestParams(), { signal: abort.signal })
          .finalMessage();
      } finally {
        thinking.remove();
      }

      // Append the full assistant content (thinking blocks included) so history stays valid.
      messages.push({ role: "assistant", content: response.content });

      for (const block of response.content) {
        if (block.type === "text" && block.text.trim()) addMsg("assistant", block.text);
      }
      if (response.usage) {
        const u = response.usage;
        const d = document.createElement("div");
        d.className = "usage";
        d.textContent = `in ${u.input_tokens}${u.cache_read_input_tokens ? ` (+${u.cache_read_input_tokens} cached)` : ""} · out ${u.output_tokens}`;
        log.appendChild(d);
      }

      if (response.stop_reason === "refusal") {
        addMsg("error", `Модель отказалась: ${response.stop_details?.category || ""} ${response.stop_details?.explanation || ""}`.trim());
        break;
      }
      if (response.stop_reason === "max_tokens") {
        addMsg("error", "Ответ обрезан по max_tokens.");
        break;
      }
      if (response.stop_reason === "pause_turn") continue;

      const toolUses = response.content.filter((b) => b.type === "tool_use");
      if (toolUses.length === 0) break; // end_turn

      // Execute all tool calls, return all results in ONE user message.
      const results = await Promise.all(
        toolUses.map(async (tu) => {
          const view = addTool(tu.name, tu.input);
          try {
            const result = await callTool(tu.name, tu.input);
            view.done(result);
            return { type: "tool_result", tool_use_id: tu.id, content: toToolContent(result) };
          } catch (e) {
            view.fail(e.message || e);
            return { type: "tool_result", tool_use_id: tu.id, is_error: true, content: String(e.message || e) };
          }
        }),
      );
      messages.push({ role: "user", content: results });
      if (abort.signal.aborted) break;
    }
  } catch (e) {
    if (e?.name === "AbortError" || abort?.signal.aborted) {
      addMsg("system", "остановлено");
      // Keep history consistent: drop a dangling user turn without an assistant reply.
      if (messages.at(-1)?.role === "user") messages.pop();
    } else {
      addMsg("error", describeError(e));
      if (messages.at(-1)?.role === "user") messages.pop();
    }
  } finally {
    abort = null;
    $("btnSend").hidden = false;
    $("btnStop").hidden = true;
    $("input").disabled = false;
  }
}

function toToolContent(result) {
  if (result && typeof result === "object" && result.type === "image") {
    return [{ type: "image", source: { type: "base64", media_type: result.mediaType || "image/jpeg", data: result.data } }];
  }
  return typeof result === "string" ? result : JSON.stringify(result, null, 2);
}

function describeError(e) {
  if (e instanceof Anthropic.AuthenticationError) return "API key не принят (401).";
  if (e instanceof Anthropic.RateLimitError) return "Rate limit (429), попробуй позже.";
  if (e instanceof Anthropic.APIConnectionError) return "Нет связи с API с телефона: " + (e.message || "");
  if (e instanceof Anthropic.APIError) return `API ${e.status}: ${e.message}`;
  return String(e?.message || e);
}

// ------------------------------------------------------------------ wiring

$("btnSend").onclick = () => {
  const text = $("input").value.trim();
  if (!text || abort) return;
  $("input").value = "";
  autosize();
  addMsg("user", text);
  runTurn(text);
};
$("btnStop").onclick = () => abort?.abort();
$("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $("btnSend").click();
  }
});
$("input").addEventListener("input", autosize);
function autosize() {
  const t = $("input");
  t.style.height = "auto";
  t.style.height = Math.min(t.scrollHeight, innerHeight * 0.3) + "px";
}

$("btnReset").onclick = () => {
  if (abort) abort.abort();
  messages = [];
  log.innerHTML = "";
  addMsg("system", "новый диалог");
};

// Manual helpers: see the page without spending tokens.
$("btnSnapshot").onclick = async () => {
  const v = addTool("page_snapshot", {});
  try {
    v.done(await callTool("page_snapshot", {}));
  } catch (e) {
    v.fail(e.message);
  }
};
$("btnShot").onclick = async () => {
  const v = addTool("page_screenshot", {});
  try {
    v.done(await callTool("page_screenshot", {}));
  } catch (e) {
    v.fail(e.message);
  }
};

$("btnSettings").onclick = () => {
  $("apiKey").value = settings.apiKey;
  $("model").value = settings.model;
  $("effort").value = settings.effort;
  $("baseUrl").value = settings.baseUrl;
  $("token").value = settings.token;
  $("settings").showModal();
};
$("settings").addEventListener("close", () => {
  if ($("settings").returnValue !== "save") return;
  const tokenChanged = $("token").value.trim() !== settings.token;
  settings.apiKey = $("apiKey").value.trim();
  settings.model = $("model").value;
  settings.effort = $("effort").value;
  settings.baseUrl = $("baseUrl").value.trim();
  settings.token = $("token").value.trim();
  saveSettings();
  client = null;
  if (tokenChanged) connectBridge();
});

connectBridge();
if (!settings.apiKey) addMsg("system", "Нажми ⚙︎ и вставь Anthropic API key. Зелёные точки сверху: мост и расширение на связи.");
