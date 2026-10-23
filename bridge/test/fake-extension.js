// Emulates the Chrome extension for bridge tests: answers every tool call.
import WebSocket from "ws";
const ws = new WebSocket(process.env.URL || "ws://127.0.0.1:8787/ext");
ws.on("open", () => console.log("fake-ext connected"));
ws.on("message", (raw) => {
  const m = JSON.parse(raw);
  if (m.type !== "call") return;
  let result;
  if (m.tool === "page_screenshot") result = { type: "image", mediaType: "image/jpeg", data: "/9j/ZmFrZQ==" };
  else if (m.tool === "tabs_list") result = [{ id: 1, title: "Example", url: "https://example.com", active: true, target: true }];
  else result = `ok ${m.tool} ${JSON.stringify(m.args)}`;
  ws.send(JSON.stringify({ id: m.id, type: "result", ok: true, result }));
});
