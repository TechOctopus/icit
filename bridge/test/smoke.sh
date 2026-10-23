#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=18787
ICIT_PORT=$PORT node src/server.js > /tmp/icit-bridge.log 2>&1 &
BP=$!
sleep 0.6
URL=ws://127.0.0.1:$PORT/ext node test/fake-extension.js > /tmp/icit-fake.log 2>&1 &
FP=$!
trap 'kill $BP $FP 2>/dev/null' EXIT
sleep 0.6
echo "== status";   curl -s localhost:$PORT/api/status
echo; echo "== tools"; curl -s localhost:$PORT/api/tools | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).tools.map(t=>t.name).join(", ")))'
echo "== call";     curl -s -XPOST localhost:$PORT/api/call -d '{"tool":"page_click","args":{"ref":3}}'
echo; echo "== call unknown"; curl -s -XPOST localhost:$PORT/api/call -d '{"tool":"nope"}'
echo; echo "== mcp initialize"; curl -s -XPOST localhost:$PORT/mcp -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}'
echo; echo "== mcp initialized (expect 202)"; curl -s -o /dev/null -w '%{http_code}' -XPOST localhost:$PORT/mcp -H 'content-type: application/json' -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'
echo; echo "== mcp tools/list count"; curl -s -XPOST localhost:$PORT/mcp -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).result.tools.length, Object.keys(JSON.parse(s).result.tools[0])))'
echo "== mcp tools/call text"; curl -s -XPOST localhost:$PORT/mcp -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"page_type","arguments":{"ref":1,"text":"hi"}}}'
echo; echo "== mcp tools/call image"; curl -s -XPOST localhost:$PORT/mcp -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"page_screenshot","arguments":{}}}'
echo; echo "== static"; curl -s -o /dev/null -w 'index %{http_code} ' localhost:$PORT/; curl -s -o /dev/null -w 'app.js %{http_code} ' localhost:$PORT/dist/app.js; curl -s -o /dev/null -w 'traversal %{http_code}\n' "localhost:$PORT/../package.json"
echo "== ws client"; node -e '
import("ws").then(({default:WebSocket})=>{
  const ws=new WebSocket("ws://127.0.0.1:'$PORT'/client");
  ws.on("message",raw=>{const m=JSON.parse(raw);console.log("client got:",m.type, m.type==="result"?m.result:m.type==="tools"?m.tools.length:m.extensionConnected);
    if(m.type==="tools") ws.send(JSON.stringify({id:"x1",type:"call",tool:"page_snapshot",args:{maxChars:10}}));
    if(m.type==="result") ws.close();});
  ws.on("close",()=>process.exit(0));
});'
echo "== bridge log"; cat /tmp/icit-bridge.log
