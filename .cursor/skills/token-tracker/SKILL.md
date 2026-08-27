---
name: token-tracker
description: >-
  Answers questions about local Oh My Pi and Cursor token usage, spend, model
  mix, projects, and remaining account quota via the token-tracker MCP tools.
  Use when the user asks about tokens, usage, spend, cost, billing, quota,
  limits, how much they have used Cursor, or what a project or model cost.
---

# Token Tracker

Use the **token-tracker** MCP server. Do not open the desktop app or the editor dashboard panel.

1. Call `refresh_usage` when the user wants current numbers, the last import looks stale, or they just finished a session.
2. Call `get_usage` with `period`: `today`, `month` (default), `all`, or a `YYYY-MM-DD` date.
3. Answer from the tool text. Do not invent spend or quota figures.
4. Never print access tokens, API keys, or raw Cursor auth material.
