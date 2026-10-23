// Single source of truth for the browser-control tools.
// The extension implements them, the phone harness sends them to Claude,
// and the MCP endpoint exposes them to any MCP client (Codex, Claude Code, ...).

export const TOOLS = [
  {
    name: "tabs_list",
    description:
      "List open browser tabs on the PC (id, title, url, active flag, and which one is the current target).",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "tab_select",
    description: "Choose which tab all page_* tools operate on. Also brings it to the front.",
    input_schema: {
      type: "object",
      properties: { tabId: { type: "integer", description: "Tab id from tabs_list" } },
      required: ["tabId"],
      additionalProperties: false,
    },
  },
  {
    name: "tab_open",
    description: "Open a new tab with the given URL and make it the target tab.",
    input_schema: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "page_navigate",
    description: "Navigate the target tab to a URL and wait for the page to load.",
    input_schema: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "page_back",
    description: "Go back in the target tab's history.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "page_snapshot",
    description:
      "Compact text snapshot of the target tab: url, title, numbered interactive elements ([ref] kind \"label\" ...) and visible text. Use the [ref] numbers with page_click / page_type / page_read. Refs are renewed on every snapshot.",
    input_schema: {
      type: "object",
      properties: {
        maxChars: {
          type: "integer",
          description: "Max characters of visible text to include (default 6000).",
        },
        viewportOnly: {
          type: "boolean",
          description: "Only include elements currently inside the viewport (default false).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "page_click",
    description: "Click an element by its [ref] from the latest page_snapshot.",
    input_schema: {
      type: "object",
      properties: { ref: { type: "integer" } },
      required: ["ref"],
      additionalProperties: false,
    },
  },
  {
    name: "page_type",
    description:
      "Type text into an input / textarea / contenteditable element by [ref]. Replaces the existing value unless append=true. submit=true presses Enter afterwards.",
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "integer" },
        text: { type: "string" },
        append: { type: "boolean" },
        submit: { type: "boolean" },
      },
      required: ["ref", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "page_press",
    description:
      "Press a keyboard key on the focused element (e.g. Enter, Escape, Tab, ArrowDown, Backspace).",
    input_schema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    name: "page_scroll",
    description: "Scroll the page. direction: up | down | top | bottom. amount in pixels (default one viewport).",
    input_schema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down", "top", "bottom"] },
        amount: { type: "integer" },
      },
      required: ["direction"],
      additionalProperties: false,
    },
  },
  {
    name: "page_read",
    description:
      "Read the visible text of an element by [ref], or of the whole page when ref is omitted. Longer than the snapshot excerpt (default 20000 chars).",
    input_schema: {
      type: "object",
      properties: { ref: { type: "integer" }, maxChars: { type: "integer" } },
      additionalProperties: false,
    },
  },
  {
    name: "page_screenshot",
    description:
      "JPEG screenshot of the visible part of the target tab. Returned as an image. Costly over Bluetooth, prefer page_snapshot when text is enough.",
    input_schema: {
      type: "object",
      properties: {
        quality: { type: "integer", description: "JPEG quality 10-90 (default 50)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "page_eval",
    description:
      "Run JavaScript in the page's main world and return the JSON-serialised result. May be blocked by the page's Content-Security-Policy.",
    input_schema: {
      type: "object",
      properties: { code: { type: "string" } },
      required: ["code"],
      additionalProperties: false,
    },
  },
];

export const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

// MCP wants `inputSchema`, Anthropic wants `input_schema`.
export function toolsForMcp() {
  return TOOLS.map(({ name, description, input_schema }) => ({
    name,
    description,
    inputSchema: input_schema,
  }));
}
