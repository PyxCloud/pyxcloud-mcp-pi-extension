# PyxCloud Passobuild MCP — Pi Extension

A [pi](https://pi.dev) extension for the passobuild board MCP — task orchestration, agent coordination, and delivery tracking for AI-agent workflows on PyxCloud.

## Features

- **OAuth 2.1 + PKCE** — Authenticate with GitHub SSO, no manual code copy-paste
- **Automatic callback capture** — Local server catches the OAuth redirect
- **Tool discovery** — Automatically registers all MCP tools as pi tools
- **Token management** — Auto-refresh, persistence, `offline_access` support
- **Commands** — `/passo-login`, `/passo-status`, `/passo-logout`

## Install

```bash
pi install git:github.com/PyxCloud/pyxcloud-mcp-pi-extension
```

Or for local development:

```bash
pi -e /path/to/pyxcloud-mcp-pi-extension
```

## Usage

### 1. Authenticate

```
/passo-login
```

This opens the passobuild OAuth login page. Log in with GitHub SSO. The browser redirects to a local callback server that captures the code automatically — no manual copying.

To authenticate against production instead of staging:

```
/passo-login {"env": "prod"}
```

### 2. Check Status

```
/passo-status
```

### 3. Use the Tools

Once authenticated, the coding agent can use all passobuild board tools:

- `passobuild_board_task_next` — Get the next task
- `passobuild_board_task_create` — Create a task
- `passobuild_board_status` — Check project status
- `passobuild_board_agent_register` — Register the agent
- See [SKILL.md](skills/SKILL.md) for a full list

### 4. Logout

```
/passo-logout
```

## Environment Variables

| Variable | Default (staging) | Default (prod) |
|----------|-------------------|-----------------|
| `PYXCLOUD_MCP_ENV` | `staging` | `prod` |
| `PYXCLOUD_MCP_URL` | `https://staging-mcp.passo.build/mcp` | `https://mcp.passo.build/mcp` |
| `PYXCLOUD_AUTH_URL` | `https://staging-auth.pyxcloud.io/realms/passobuild` | `https://auth.pyxcloud.io/realms/passobuild` |
| `PYXCLOUD_CLIENT_ID` | `passobuild-mcp` | `passobuild-mcp` |

## Token Storage

Tokens are stored in `~/.pyxcloud-mcp-token.json` with `offline_access` scope for long-lived refresh.

## How It Works

1. `/passo-login` starts a local HTTP server on a random port
2. Generates PKCE challenge + state
3. Opens the OAuth authorize URL with `redirect_uri=http://localhost:{port}/callback`
4. After the user logs in, the OAuth provider redirects the browser to the local server
5. The local server captures the authorization code and exchanges it for tokens
6. Tokens are persisted with `offline_access` for automatic refresh
7. The extension calls MCP `tools/list` to discover available tools
8. Each discovered tool is registered as a pi tool
