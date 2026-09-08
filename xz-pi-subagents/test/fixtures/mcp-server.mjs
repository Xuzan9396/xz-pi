import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
const input = createInterface({ input: process.stdin });
for await (const line of input) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  let result;
  if (request.method === "initialize") result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "xz-test", version: "1.0.0" } };
  else if (request.method === "tools/list") result = { tools: [{ name: "echo", description: "Echo a fixture value", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } }] };
  else if (request.method === "tools/call") {
    if (process.argv[2]) writeFileSync(process.argv[2], "called");
    result = { content: [{ type: "text", text: `MCP_ECHO ${request.params.arguments.value}` }] };
  } else result = {};
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
}
