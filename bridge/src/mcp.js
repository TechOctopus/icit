// Minimal MCP server over Streamable HTTP (stateless, JSON responses).
// Enough for Codex CLI / Claude Code / any client that speaks tools/list + tools/call.
//
//   codex mcp add icit --url http://127.0.0.1:8787/mcp
//   claude mcp add --transport http icit http://127.0.0.1:8787/mcp

import { toolsForMcp, TOOL_NAMES } from "./tools.js";

const PROTOCOL_VERSION = "2025-03-26";

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

// Convert a raw extension result into MCP content blocks.
function toMcpContent(result) {
  if (result && typeof result === "object" && result.type === "image" && result.data) {
    return [{ type: "image", data: result.data, mimeType: result.mediaType || "image/jpeg" }];
  }
  if (typeof result === "string") return [{ type: "text", text: result }];
  return [{ type: "text", text: JSON.stringify(result, null, 2) }];
}

async function dispatch(msg, callTool) {
  const { id, method, params = {} } = msg;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: params.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "icit-bridge", version: "0.1.0" },
        instructions:
          "Tools control a Chrome tab on the user's PC via the icit extension. Start with tabs_list / page_snapshot, then act with page_click / page_type using [ref] numbers from the snapshot.",
      });
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: toolsForMcp() });
    case "tools/call": {
      const name = params.name;
      if (!TOOL_NAMES.has(name)) return rpcError(id, -32602, `unknown tool: ${name}`);
      try {
        const result = await callTool(name, params.arguments || {});
        return rpcResult(id, { content: toMcpContent(result), isError: false });
      } catch (e) {
        return rpcResult(id, {
          content: [{ type: "text", text: `error: ${e.message || e}` }],
          isError: true,
        });
      }
    }
    default:
      if (isNotification) return null; // notifications/initialized, notifications/cancelled ...
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

export async function handleMcp(req, res, { callTool, readBody, json }) {
  if (req.method === "GET") {
    // We do not keep a server->client SSE stream; stateless mode.
    return json(res, 405, { error: "SSE stream not supported; use POST" });
  }
  if (req.method === "DELETE") return json(res, 200, {});
  if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });

  let body;
  try {
    body = JSON.parse((await readBody(req)) || "null");
  } catch {
    return json(res, 400, rpcError(null, -32700, "parse error"));
  }
  const batch = Array.isArray(body) ? body : [body];
  const responses = [];
  for (const msg of batch) {
    if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      responses.push(rpcError(msg?.id, -32600, "invalid request"));
      continue;
    }
    const r = await dispatch(msg, callTool);
    if (r) responses.push(r);
  }
  if (responses.length === 0) {
    res.writeHead(202, { "access-control-allow-origin": "*" });
    return res.end();
  }
  return json(res, 200, Array.isArray(body) ? responses : responses[0]);
}
