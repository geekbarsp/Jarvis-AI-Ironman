import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

const server = new McpServer({ name: "jarvis-test", version: "1.0.0" });
server.registerTool("echo", {
  description: "Echo text for integration testing",
  inputSchema: { text: z.string() },
}, async ({ text }) => ({ content: [{ type: "text", text: `echo:${text}` }] }));

await server.connect(new StdioServerTransport());
