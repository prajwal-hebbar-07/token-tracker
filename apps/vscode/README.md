# Token Tracker for VS Code

Opens the Token Tracker dashboard in an editor panel: what each Oh My Pi model
actually cost, the spend per project, and the remaining quota on every
authenticated provider account.

Run **Token Tracker: Open Dashboard** from the Command Palette. The extension
starts its own loopback server, serves the dashboard bundle and `/api` from that
one origin, and imports once on open — Oh My Pi sessions, Oh My Pi usage, Cursor
usage from the signed-in account, then provider limits. Every later refresh is
the **Fetch usage** button.

The database lives in the extension's global storage directory, so it is per
install and survives updates. `omp` must be on `PATH`, or `OMP_BIN` must name
it.

The extension host has to provide `node:sqlite`, which VS Code 1.134 does.
Older builds may ship a Node without it, and the extension then fails to
activate rather than showing an empty panel.

Cursor usage is imported from the signed-in Cursor account on this machine. If
Cursor is installed and logged in, no extra key is required. `CURSOR_API_KEY`
overrides that session when set.

To ask the same questions from Agent chat without opening this panel, use the
MCP server in `apps/mcp` (see the root README).
