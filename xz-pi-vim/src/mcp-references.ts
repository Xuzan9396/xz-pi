// Public pi-mcp-adapter v1 status channel. No dependency on its private runtime,
// config files, credentials, or connection APIs is needed for autocomplete.
export const MCP_STATUS_EVENT = "pi-mcp-adapter/status/v1";

export type McpReferenceServer = {
  name: string;
  status: string;
  toolCount: number;
  disabled: boolean;
};

export function parseMcpReferenceSnapshot(value: unknown): McpReferenceServer[] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const snapshot = value as { version?: unknown; servers?: unknown };
  if (snapshot.version !== 1 || !Array.isArray(snapshot.servers)) return undefined;
  const servers = new Map<string, McpReferenceServer>();
  for (const raw of snapshot.servers) {
    if (!raw || typeof raw !== "object") return undefined;
    const server = raw as Record<string, unknown>;
    if (typeof server.name !== "string" || !server.name.trim() ||
        typeof server.status !== "string" || typeof server.disabled !== "boolean" ||
        typeof server.toolCount !== "number" || !Number.isFinite(server.toolCount) || server.toolCount < 0) {
      return undefined;
    }
    servers.set(server.name, {
      name: server.name,
      status: server.status,
      toolCount: Math.floor(server.toolCount),
      disabled: server.disabled || server.status === "disabled" || server.status === "blocked",
    });
  }
  return [...servers.values()];
}
