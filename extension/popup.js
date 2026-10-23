const send = (msg) => chrome.runtime.sendMessage({ icitPopup: true, ...msg });

async function refresh() {
  const s = await send({ cmd: "status" });
  document.getElementById("dot").className = "dot" + (s.connected ? " on" : "");
  document.getElementById("state").textContent = s.connected ? "connected to bridge" : "not connected";
  document.getElementById("url").value = s.bridge || "";
  document.getElementById("err").textContent = s.lastError || "";
  if (s.targetTabId != null) {
    try {
      const t = await chrome.tabs.get(s.targetTabId);
      document.getElementById("target").textContent = `target tab: ${t.title}`;
    } catch {
      document.getElementById("target").textContent = "target tab: (closed)";
    }
  } else {
    document.getElementById("target").textContent = "target tab: active tab (none pinned)";
  }
}

document.getElementById("save").onclick = async () => {
  await send({ cmd: "setBridge", url: document.getElementById("url").value.trim() });
  setTimeout(refresh, 500);
};
document.getElementById("useTab").onclick = async () => {
  await send({ cmd: "useCurrentTab" });
  refresh();
};
document.getElementById("reconnect").onclick = async () => {
  await send({ cmd: "reconnect" });
  setTimeout(refresh, 700);
};

refresh();
setInterval(refresh, 2000);
