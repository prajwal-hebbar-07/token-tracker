---
name: token-tracker
description: >-
  Answers questions about local Oh My Pi and Cursor token usage, spend, model
  mix, projects, and remaining account quota via the token-tracker MCP tools.
  Use when the user asks about tokens, usage, spend, cost, billing, quota,
  limits, how much they have used Cursor, or what a project or model cost, or
  wants to see the dashboard in the Agents window Browser pane.
---

# Token Tracker

Use the **token-tracker** MCP server. Do not open the desktop app, a system
browser, or the editor command-palette dashboard.

## Visual dashboard (Agents window)

Cursor cannot add a fifth native item next to Changes / Browser / Terminal /
Files. The real dashboard is the **Browser** item in that list.

When the user wants to see metrics, the dashboard, charts, or that sidebar:

1. Call `open_dashboard`.
2. Open the returned `http://127.0.0.1:…` URL in Cursor's **Browser** pane
   (`browser_navigate` / the Browser tab). Never use an external browser.
3. Call `refresh_usage` first if they want current numbers.

## Numbers in chat

1. Call `refresh_usage` when numbers may be stale.
2. Call `get_usage` with `period`: `today`, `month` (default), `all`, or a
   `YYYY-MM-DD` date.
3. Answer from the tool text. Do not invent spend or quota figures.
4. Never print access tokens, API keys, or raw Cursor auth material.
