import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function flattenContent(content) {
  if (!Array.isArray(content)) return String(content || "");
  return content.map((item) => {
    if (item?.type === "text") return item.text || "";
    if (item?.type === "image") return `[Image: ${item.mimeType || "unknown"}, ${String(item.data || "").length} base64 characters]`;
    if (item?.type === "resource") return item.resource?.text || `[Resource: ${item.resource?.uri || "unknown"}]`;
    return JSON.stringify(item);
  }).filter(Boolean).join("\n");
}

export class MCPManager {
  constructor(getConfig) {
    this.getConfig = getConfig;
    this.connections = new Map();
    this.catalogue = new Map();
  }

  async connectServer(name, definition) {
    if (this.connections.has(name)) return this.connections.get(name);
    if (!definition?.command || definition.enabled === false) return null;
    const client = new Client({ name: "jervis-assistant", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: definition.command,
      args: Array.isArray(definition.args) ? definition.args : [],
      cwd: definition.cwd || undefined,
      env: { ...getDefaultEnvironment(), ...(definition.env || {}) },
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk) => console.error(`[mcp:${name}] ${String(chunk).trim()}`));
    await client.connect(transport);
    const connection = { client, transport };
    this.connections.set(name, connection);
    return connection;
  }

  async refresh() {
    for (const { transport } of this.connections.values()) await transport.close().catch(() => null);
    this.connections.clear();
    this.catalogue.clear();
    const errors = {};
    const servers = this.getConfig()?.mcpServers || {};
    for (const [serverName, definition] of Object.entries(servers)) {
      try {
        const connection = await this.connectServer(serverName, definition);
        if (!connection) continue;
        const listed = await connection.client.listTools();
        for (const tool of listed.tools || []) {
          const name = `mcp__${serverName}__${tool.name}`;
          this.catalogue.set(name, {
            name,
            serverName,
            remoteName: tool.name,
            description: tool.description || `Tool ${tool.name} from ${serverName}`,
            inputSchema: tool.inputSchema || { type: "object", properties: {} },
          });
        }
      } catch (error) {
        errors[serverName] = error?.message || String(error);
      }
    }
    return { tools: [...this.catalogue.values()], errors };
  }

  async listTools() {
    if (!this.catalogue.size) await this.refresh();
    return [...this.catalogue.values()];
  }

  async call(name, args) {
    let specification = this.catalogue.get(name);
    if (!specification) {
      await this.refresh();
      specification = this.catalogue.get(name);
    }
    if (!specification) throw new Error(`Unknown MCP tool: ${name}`);
    const connection = await this.connectServer(specification.serverName, this.getConfig().mcpServers[specification.serverName]);
    const result = await connection.client.callTool({ name: specification.remoteName, arguments: args || {} });
    return {
      text: flattenContent(result.content),
      structuredContent: result.structuredContent || null,
      isError: Boolean(result.isError),
    };
  }

  async close() {
    for (const { transport } of this.connections.values()) await transport.close().catch(() => null);
    this.connections.clear();
    this.catalogue.clear();
  }
}
