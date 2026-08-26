# Token Tracker for VS Code

Opens the Token Tracker dashboard in an editor panel: what each Oh My Pi model
actually cost, the spend per project, and the remaining quota on every
authenticated provider account.

Run **Token Tracker: Open Dashboard** from the Command Palette. The extension
starts its own loopback server, serves the dashboard bundle and `/api` from that
one origin, and imports once on open — the same three steps the desktop app
runs: `omp stats --json`, an import into this extension's own SQLite database,
then `omp usage --json` plus the Ollama Cloud report. Every later refresh is the
**Fetch Oh My Pi data** button.

The database lives in the extension's global storage directory, so it is per
install and survives updates. `omp` must be on `PATH`, or `OMP_BIN` must name
it.

The extension host has to provide `node:sqlite`, which VS Code 1.134 does.
Older builds may ship a Node without it, and the extension then fails to
activate rather than showing an empty panel.
