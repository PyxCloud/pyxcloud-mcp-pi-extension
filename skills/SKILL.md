# PyxCloud Passobuild MCP

This skill enables the coding agent to interact with the passobuild board MCP — the task orchestration and delivery board for managing AI-agent work on projects.

## Prerequisites

The user must authenticate first via `/passo-login` (OAuth 2.1 + PKCE with GitHub SSO).

## Available Tools

Once authenticated, the following MCP tools are registered as pi tools:

### Board Task Operations
- `passobuild_board_task_next` — Claim the next available task for a project
- `passobuild_board_task_create` — Create a new task on the board
- `passobuild_board_task_claim` — Claim a specific task (returns fenceToken)
- `passobuild_board_task_heartbeat` — Keep a task lease alive
- `passobuild_board_task_checkpoint` — Record progress on a task
- `passobuild_board_task_complete` — Mark task done with evidence
- `passobuild_board_task_brief` — Get the full task brief with context
- `passobuild_board_task_plan_set` — Set or update a task's plan
- `passobuild_board_task_verify` — Record a verification PASS/FAIL for a task

### Agent Operations
- `passobuild_board_agent_register` — Register this agent with the board
- `passobuild_board_agent_capacity` — Report AI capacity/budget
- `passobuild_board_epic_create` — Create a delivery epic (top-level task group)

### Board Status
- `passobuild_board_status` — Get project status and metrics
- `passobuild_board_snapshot` — Get full board snapshot
- `passobuild_board_projects_list` — List all projects
- `passobuild_board_budget_status` — Get current token budget status

### Context & Policy
- `passobuild_board_session` — Get the grants panel for the current session
- `passobuild_board_tool_plan` — Get the tool plan (allowed/avoided tools)
- `passobuild_board_lean_policy` — Get the lean execution policy

### Generic Tool
- `passobuild_mcp_call` — Call any MCP tool by name (generic fallback)

## Workflow

1. Agent registers via `passobuild_board_agent_register`
2. Agent calls `passobuild_board_task_next` to get work
3. Agent claims the task with `passobuild_board_task_claim`
4. Agent works the task and heartbeats periodically
5. Agent completes with `passobuild_board_task_complete` + evidence
6. Repeat until the board returns `{status:"empty"}`

## Token Budget

The MCP enforces token budgets. Check `passobuild_board_budget_status` to see current usage. When over 85%, checkpoint and yield.
