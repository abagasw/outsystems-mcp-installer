const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "outsystems-mcp-installer", version: "0.1.0" },
  },
};

/**
 * POST an MCP initialize without client credentials. Reports HTTP reachability,
 * not the client's sign-in state or a completed MCP handshake.
 */
export async function probe(url, { timeout = 6000 } = {}) {
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(INITIALIZE),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (error) {
    const code = error.cause?.code ?? error.name;
    return {
      state: "unreachable",
      detail: code === "ECONNREFUSED" ? "connection refused" : String(code ?? error.message),
    };
  }

  await response.body?.cancel().catch(() => {});
  const detail = `HTTP ${response.status}: endpoint replied; client sign-in not checked`;
  if (response.status === 401 || response.status === 403) return { state: "auth", detail };
  if (response.ok) return { state: "ok", detail };
  return { state: "error", detail: `HTTP ${response.status}` };
}
