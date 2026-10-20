import { writeFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

if (process.env.TEST_PID_FILE) await writeFile(process.env.TEST_PID_FILE, String(process.pid));
const server = new McpServer({ name: "test-server", version: "1.0.0" });
server.registerTool("echo", { description: "Echo a message", inputSchema: z.object({ text: z.string() }) }, async ({ text }) => ({
  content: [{ type: "text", text: `${process.env.TEST_MCP_VALUE ?? ""}:${text}:${process.pid}` }],
}));
server.registerTool("wait", { inputSchema: z.object({}) }, () => new Promise(() => {}));
await server.connect(new StdioServerTransport());
