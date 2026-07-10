/**
 * PyxCloud Passobuild MCP — Pi Extension
 *
 * OAuth 2.1 + PKCE authentication, automatic local server callback capture,
 * token management, and MCP tool registration for the passobuild board MCP.
 *
 * The local server runs on the USER's machine (same machine as pi and the
 * browser), so the OAuth redirect to localhost:{port}/callback is captured
 * automatically — no manual code copy-paste.
 *
 * Usage:
 *   pi install git:github.com/PyxCloud/pyxcloud-mcp-pi-extension
 *   # or during dev:
 *   pi -e ./pyxcloud-mcp-pi-extension
 *
 * Commands:
 *   /passo-login     - Authenticate with the passobuild MCP
 *   /passo-status    - Show connection status
 *
 * Env vars:
 *   PYXCLOUD_MCP_ENV     "staging" (default) or "prod"
 *   PYXCLOUD_MCP_URL     override full MCP base URL
 *   PYXCLOUD_AUTH_URL    override OIDC auth server URL
 *   PYXCLOUD_CLIENT_ID   override OAuth client ID
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as crypto from "node:crypto";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";

// ── Types ──────────────────────────────────────────────────────────────

interface StoredToken {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch ms
}

// ── Config ─────────────────────────────────────────────────────────────

interface McpConfig {
  env: "staging" | "prod";
  mcpUrl: string;
  authIssuer: string;
  clientId: string;
  tokenPath: string;
}

function getConfig(agentDir?: string): McpConfig {
  const env = (process.env.PYXCLOUD_MCP_ENV || "staging") as "staging" | "prod";
  const isProd = env === "prod";
  const baseDir = agentDir || process.env.HOME || "~";
  return {
    env,
    mcpUrl: process.env.PYXCLOUD_MCP_URL || (isProd
      ? "https://mcp.passo.build/mcp"
      : "https://staging-mcp.passo.build/mcp"),
    authIssuer: process.env.PYXCLOUD_AUTH_URL || (isProd
      ? "https://auth.pyxcloud.io/realms/passobuild"
      : "https://staging-auth.pyxcloud.io/realms/passobuild"),
    clientId: process.env.PYXCLOUD_CLIENT_ID || "passobuild-mcp",
    tokenPath: path.join(baseDir, ".pyxcloud-mcp-token.json"),
  };
}

// ── PKCE ───────────────────────────────────────────────────────────────

function generatePkce() {
  const verifier = crypto.randomBytes(96)
    .toString("base64url")
    .replace(/=+$/, "");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url")
    .replace(/=+$/, "");
  const state = crypto.randomBytes(32).toString("base64url").replace(/=+$/, "");
  return { verifier, challenge, state };
}

// ── Token persistence ──────────────────────────────────────────────────

function loadToken(config: McpConfig): StoredToken | null {
  try {
    if (fs.existsSync(config.tokenPath)) {
      const raw = fs.readFileSync(config.tokenPath, "utf-8");
      return JSON.parse(raw) as StoredToken;
    }
  } catch { /* ignore corrupt files */ }
  return null;
}

function saveToken(config: McpConfig, token: StoredToken) {
  try {
    const dir = path.dirname(config.tokenPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(config.tokenPath, JSON.stringify(token, null, 2), {
      mode: 0o600,
    });
  } catch (e) {
    console.error(`[pyxcloud-mcp] Failed to save token: ${e}`);
  }
}

function clearToken(config: McpConfig) {
  try {
    if (fs.existsSync(config.tokenPath)) fs.unlinkSync(config.tokenPath);
  } catch { /* ignore */ }
}

// ── Token refresh ──────────────────────────────────────────────────────

async function refreshAccessToken(config: McpConfig, token: StoredToken): Promise<StoredToken> {
  if (!token.refresh_token) throw new Error("No refresh token");
  const res = await fetch(`${config.authIssuer}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: config.clientId,
      refresh_token: token.refresh_token,
    }),
  });
  if (!res.ok) throw new Error(`Refresh failed (${res.status})`);
  const t = await res.json();
  return {
    access_token: t.access_token,
    refresh_token: t.refresh_token || token.refresh_token,
    expires_at: Date.now() + (t.expires_in || 1800) * 1000,
  };
}

// ── MCP client ─────────────────────────────────────────────────────────

async function callMcp(
  config: McpConfig,
  accessToken: string,
  body: unknown,
): Promise<any> {
  const res = await fetch(config.mcpUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`MCP error (${res.status}): ${text}`);
  }
  return res.json();
}

// ── Token manager (auto-refresh, persistence) ──────────────────────────

function createTokenManager(config: McpConfig) {
  let token: StoredToken | null = loadToken(config);

  return {
    isAuthenticated(): boolean {
      return token !== null;
    },

    getStatus(): string {
      if (!token) return "Not authenticated";
      const remaining = Math.round((token.expires_at - Date.now()) / 1000);
      if (remaining <= 0) return "Token expired";
      return `Token valid (${remaining}s remaining)`;
    },

    async getValidToken(): Promise<string> {
      if (!token) throw new Error("Not authenticated — run /passo-login");
      if (Date.now() >= token.expires_at - 60_000) {
        try {
          token = await refreshAccessToken(config, token);
          saveToken(config, token);
        } catch {
          clearToken(config);
          token = null;
          throw new Error("Token expired and refresh failed — run /passo-login");
        }
      }
      return token.access_token;
    },

    setToken(t: StoredToken) {
      token = t;
      saveToken(config, t);
    },

    clear() {
      token = null;
      clearToken(config);
    },
  };
}

// ── Local callback server ──────────────────────────────────────────────
// Starts listening immediately and returns { port, promise } so the caller
// can build and show the auth URL BEFORE awaiting the callback promise.
async function startCallbackServer(): Promise<{ port: number; promise: Promise<string>; close: () => void }> {
  let resolveCode: (code: string) => void = () => {};
  let rejectCode: (err: Error) => void = () => {};
  const promise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url || "/", `http://localhost`);
      if (url.pathname === "/callback" && url.searchParams.has("code")) {
        const code = url.searchParams.get("code")!;
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<!DOCTYPE html>\n<html><body style="font-family: sans-serif; text-align: center; margin-top: 80px;">\n<h1>✅ MCP Authenticated</h1>\n<p>You can close this tab and return to pi.</p>\n</body></html>`);
        server.close(() => resolveCode(code));
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    } catch { res.writeHead(500); res.end("Error"); }
  });

  server.on("error", (err) => { rejectCode(err); });

  // Start listening and wait for the port to be assigned
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as any)?.port || 0;

  // Timeout after 5 minutes
  const timeout = setTimeout(() => {
    server.close();
    rejectCode(new Error("Login timed out after 5 minutes"));
  }, 300_000);

  return {
    port,
    promise: promise.finally(() => { clearTimeout(timeout); }),
    close: () => server.close(),
  };
}

// ── Tool registration ──────────────────────────────────────────────────

function registerMcpTool(
  pi: ExtensionAPI,
  config: McpConfig,
  tm: ReturnType<typeof createTokenManager>,
  mcpToolName: string,
  description: string,
  paramsSchema: Record<string, any>,
) {
  pi.registerTool({
    name: mcpToolName,
    label: mcpToolName.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    description,
    parameters: Type.Object(paramsSchema),
    execute: async (_toolCallId, params) => {
      const token = await tm.getValidToken();
      const result = await callMcp(config, token, {
        jsonrpc: "2.0",
        id: `${mcpToolName}-${Date.now()}`,
        method: "tools/call",
        params: { name: mcpToolName, arguments: params },
      });
      const text = JSON.stringify(result, null, 2);
      return { content: [{ type: "text", text }], details: {} };
    },
  });
}

// ── Tool discovery from MCP server ─────────────────────────────────────

async function discoverAndRegisterTools(
  pi: ExtensionAPI,
  config: McpConfig,
  tm: ReturnType<typeof createTokenManager>,
) {
  const token = await tm.getValidToken();

  // Initialize MCP session
  const initResult = await callMcp(config, token, {
    jsonrpc: "2.0",
    id: "pi-init",
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "pyxcloud-mcp-pi", version: "0.1.0" },
    },
  });

  console.log(`[pyxcloud-mcp] Connected to ${initResult?.result?.serverInfo?.name || "passobuild"}`);

  // List available tools
  const listResult = await callMcp(config, token, {
    jsonrpc: "2.0",
    id: "pi-list-tools",
    method: "tools/list",
    params: {},
  });

  const tools: Array<{ name: string; description?: string; inputSchema?: any }> =
    listResult?.result?.tools || [];

  if (tools.length === 0) {
    console.log("[pyxcloud-mcp] No tools discovered — registering generic tool fallback");
    registerGenericMcpTool(pi, config, tm);
    return;
  }

  console.log(`[pyxcloud-mcp] Registering ${tools.length} tools from MCP...`);

  for (const tool of tools) {
    const schema = tool.inputSchema || {};
    const tbSchema: Record<string, any> = {};
    if (schema.properties) {
      const required = new Set<string>(schema.required || []);
      for (const [key, prop] of Object.entries(schema.properties as Record<string, any>)) {
        tbSchema[key] = convertJsonSchemaProp(prop, !required.has(key));
      }
    }
    registerMcpTool(pi, config, tm, tool.name, tool.description || "", tbSchema);
  }

  // Also register the generic tool for flexibility
  registerGenericMcpTool(pi, config, tm);
}

function registerGenericMcpTool(
  pi: ExtensionAPI,
  config: McpConfig,
  tm: ReturnType<typeof createTokenManager>,
) {
  const toolName = "passobuild_mcp_call";
  // Avoid duplicate registration if tools/list already exposed it
  // (pi handles duplicate registrations gracefully)
  pi.registerTool({
    name: toolName,
    label: "Passobuild MCP Call",
    description: "Call any passobuild board MCP tool by name. Generic fallback for tools not individually registered.",
    parameters: Type.Object({
      tool: Type.String({ description: "MCP tool name (e.g., passobuild_board_task_next)" }),
      arguments: Type.Optional(Type.Record(Type.String(), Type.Any())),
    }),
    execute: async (_toolCallId, params) => {
      const token = await tm.getValidToken();
      const result = await callMcp(config, token, {
        jsonrpc: "2.0",
        id: `${params.tool}-${Date.now()}`,
        method: "tools/call",
        params: { name: params.tool, arguments: params.arguments || {} },
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: {} };
    },
  });
}

// ── JSON Schema → TypeBox ──────────────────────────────────────────────

function convertJsonSchemaProp(schema: any, optional: boolean): any {
  const T = Type;
  switch (schema.type) {
    case "string":
      return optional ? T.Optional(T.String()) : T.String();
    case "number":
    case "integer":
      return optional ? T.Optional(T.Number()) : T.Number();
    case "boolean":
      return optional ? T.Optional(T.Boolean()) : T.Boolean();
    case "array": {
      const items = schema.items ? convertJsonSchemaProp(schema.items, false) : T.Any();
      return optional ? T.Optional(T.Array(items)) : T.Array(items);
    }
    case "object": {
      if (!schema.properties) return optional ? T.Optional(T.Record(T.String(), T.Any())) : T.Record(T.String(), T.Any());
      const props: Record<string, any> = {};
      const req = new Set<string>(schema.required || []);
      for (const [k, v] of Object.entries(schema.properties as Record<string, any>)) {
        props[k] = convertJsonSchemaProp(v, !req.has(k));
      }
      return optional ? T.Optional(T.Object(props)) : T.Object(props);
    }
    default:
      return optional ? T.Optional(T.Any()) : T.Any();
  }
}

// ── Extension entry point ──────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Resolve agent dir from pi context (fallback: HOME)
  const agentDir = process.env.HOME || "~";
  const config = getConfig(agentDir);
  const tm = createTokenManager(config);

  // ── /passo-login command ────────────────────────────────────────────

  pi.registerCommand("passo-login", {
    description: "Login to the PyxCloud Passobuild MCP (OAuth 2.1 + PKCE). Optional arg: 'staging' (default) or 'prod'",
    getArgumentCompletions: (_prefix) => {
      return [{ value: "prod", label: "Production" }, { value: "staging", label: "Staging" }];
    },
    handler: async (args, ctx) => {
      // Parse args: "prod" or "staging" (default)
      const envArg = (args || "").trim().toLowerCase();
      const targetEnv = envArg === "prod" ? "prod" : "staging";
      let activeConfig = getConfig(agentDir);
      if (targetEnv === "prod") {
        activeConfig = {
          ...activeConfig,
          env: "prod",
          mcpUrl: "https://mcp.passo.build/mcp",
          authIssuer: "https://auth.pyxcloud.io/realms/passobuild",
        };
      }

      ctx.ui.notify(`Starting MCP login (${activeConfig.env})...`, "info");

      // Generate PKCE
      const { verifier, challenge, state } = generatePkce();
      const scopes = "openid email profile offline_access";

      try {
        // Start local callback server on the user's machine
        const cb = await startCallbackServer();
        const port = cb.port;
        const redirectUri = `http://localhost:${port}/callback`;

        // Build auth URL (MUST be before awaiting the callback!)
        const authUrl = `${activeConfig.authIssuer}/protocol/openid-connect/auth`
          + `?client_id=${encodeURIComponent(activeConfig.clientId)}`
          + `&response_type=code`
          + `&scope=${encodeURIComponent(scopes)}`
          + `&redirect_uri=${encodeURIComponent(redirectUri)}`
          + `&code_challenge=${encodeURIComponent(challenge)}`
          + `&code_challenge_method=S256`
          + `&state=${encodeURIComponent(state)}`;

        // Show the URL to the user BEFORE waiting
        ctx.ui.notify(`Open browser to authenticate (port ${port})`, "info");
        console.log(`\n[pyxcloud-mcp] Open this URL in your browser:\n${authUrl}\n`);

        // NOW wait for the callback
        const code = await cb.promise;

        // Exchange code for tokens
        const tokenRes = await fetch(`${activeConfig.authIssuer}/protocol/openid-connect/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: activeConfig.clientId,
            code,
            redirect_uri: redirectUri,
            code_verifier: verifier,
          }),
        });

        if (!tokenRes.ok) {
          const errBody = await tokenRes.text();
          throw new Error(`Token exchange failed (${tokenRes.status}): ${errBody}`);
        }

        const tokens = await tokenRes.json();
        tm.setToken({
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token || "",
          expires_at: Date.now() + (tokens.expires_in || 1800) * 1000,
        });

        ctx.ui.notify("✅ MCP authenticated successfully!", "success");

        // Discover and register tools
        try {
          await discoverAndRegisterTools(pi, activeConfig, tm);
          ctx.ui.notify(`MCP tools discovered and registered ✅`, "success");
        } catch (e: any) {
          ctx.ui.notify(`Tools registered (generic mode): ${e.message}`, "warning");
          registerGenericMcpTool(pi, activeConfig, tm);
        }

      } catch (e: any) {
        ctx.ui.notify(`❌ MCP login failed: ${e.message}`, "error");
      }
    },
  });

  // ── /passo-status command ──────────────────────────────────────────

  pi.registerCommand("passo-status", {
    description: "Show MCP connection status",
    handler: async (_args, ctx) => {
      const status = tm.getStatus();
      ctx.ui.notify(`MCP (${config.env}): ${status}`, "info");
    },
  });

  // ── /passo-logout command ──────────────────────────────────────────

  pi.registerCommand("passo-logout", {
    description: "Clear MCP authentication and disconnect",
    handler: async (_args, ctx) => {
      tm.clear();
      ctx.ui.notify("MCP disconnected and token cleared", "info");
    },
  });

}
