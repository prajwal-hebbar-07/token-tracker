# Token Tracker

Local dashboard for importing Oh My Pi usage, storing it in SQLite, and showing
what each model actually costs alongside the remaining quota on every
authenticated provider account. Shipped as a single-file installer that starts
its own local API and serves the dashboard from inside the binary.

## Install the desktop app

Download the latest `.dmg` from the [Releases](../../releases) page, open it, and
drag **Token Tracker** to Applications. It is a universal build, so it runs on
both Apple Silicon and Intel Macs, and it needs neither Node nor a running
server.

The app is not signed with an Apple Developer certificate, so macOS quarantines
it after download and reports it as damaged. Clear the flag once, after copying
the app to Applications:

```bash
xattr -dr com.apple.quarantine "/Applications/Token Tracker.app"
```

Opening it after that needs no terminal.

### Build it yourself instead

Building locally requires a Rust toolchain (`rustup`), Node.js 22.5+ and pnpm.

```bash
pnpm install
pnpm bundle
```

The finished installer is written to
`apps/desktop/src-tauri/target/release/bundle/`. On macOS this is a `.dmg`
containing `Token Tracker.app`. `pnpm dev` runs the same app from a debug build
for development.

## Install the VS Code extension

The same dashboard also runs as an editor panel. Download
`Token-Tracker-<version>.vsix` from the same
[Releases](../../releases) page and install it:

```bash
code --install-extension Token-Tracker-<version>.vsix
```

Run **Token Tracker: Open Dashboard** from the Command Palette. The extension
starts its own loopback server inside the extension host, serves the dashboard
and `/api` from that one origin, and imports once when the panel opens. Its
database lives in the extension's global storage directory, so it is separate
from the desktop app's.

The extension host has to provide `node:sqlite`; VS Code 1.134 does. Older
builds may ship a Node without it, and the extension then fails to activate
rather than opening an empty panel.

Building the extension locally needs no Rust toolchain:

```bash
pnpm install
pnpm build
pnpm --filter ./apps/vscode run package
```

That writes `apps/vscode/token-tracker.vsix`, which installs the same way.

## How it works

The desktop app is a single binary. On launch it binds a loopback HTTP server
to `127.0.0.1` on an ephemeral port, serves the dashboard bundle that is
embedded in the binary, answers `/api/*` from the same origin so the interface
needs no separate backend, and then opens a native window on that address.

Opening the app imports once on its own, so the dashboard shows what Oh My Pi
has recorded without anything having to be pressed. That is the only automatic
run: there is no polling and no background sync, and every later refresh is the
**Fetch Oh My Pi data** button.

The VS Code extension is the same arrangement one layer up: the extension host
binds the loopback server itself — reusing the TypeScript API in `apps/api`
rather than the Rust port — and the panel is a webview holding an iframe on that
port. The bundle keeps its own origin that way, so its relative `fetch("/api/…")`
calls reach the extension's server unchanged.

## Using the dashboard

Opening the installed app runs one import by itself, and **Fetch Oh My Pi data**
runs the same three steps again on demand:

1. Runs `omp stats --json`, which tails `~/.omp/agent/sessions/` into
   `~/.omp/stats.db`. Nothing else advances that database, so skipping this step
   would re-import whatever snapshot the last `omp stats` run left behind.
2. Imports the refreshed database into this app's own SQLite file.
3. Runs `omp usage --json`, then fills the Ollama Cloud report from
   `https://ollama.com/api/usage`, and stores the resulting account limits.

If either `omp` call fails the import still completes — with the existing stats
snapshot, and with the previously stored limits — and the dashboard shows a
warning instead of pretending the data is current.

Rows from models Ollama Cloud bills as free are estimated from the provider's
published pay-as-you-go rates, so the spend they would have cost is still
visible. [MiniMax-M3](https://platform.minimax.io/docs/guides/pricing-paygo):
$0.30 input, $1.20 output, and $0.06 cache-read per million tokens up to 512k
input tokens, with those rates doubling for longer inputs.
[Kimi K2.6](https://platform.kimi.ai/docs/pricing/chat-k26): $0.95 input, $4.00
output, and $0.16 cache-read per million tokens, flat at every prompt length.
[Kimi K3](https://platform.kimi.ai/docs/pricing/chat-k3): $3.00 input, $15.00
output, and $0.30 cache-read per million tokens, likewise flat.
[Kimi K2.7 Code](https://platform.kimi.ai/docs/pricing/chat-k27-code): $0.95
input, $4.00 output, and $0.19 cache-read per million tokens, flat.
[GLM-5.2](https://docs.z.ai/guides/overview/pricing): $1.40 input, $4.40
output, and $0.26 cache-read per million tokens, flat.
[DeepSeek V4 Pro](https://api-docs.deepseek.com/quick_start/pricing): $0.66
input, $1.98 output, and $0.022 cache-read per million tokens at the off-peak
rate, flat; DeepSeek doubles every rate during peak hours.
Passive cache writes have no added fee under any of them.

Model spend is shown as a deck of cards rather than a table: each ring is that
model's share of total spend, the number inside it is the blended price actually
paid per million tokens, and the bar underneath compares that price against the
priciest model in use.

Every figure is scoped by the period control beside the navigation: today, the
current month, all time, or one specific day. The fourth tab is that day: it
opens a calendar drawn by the app itself rather than the browser's own date
input, so it matches the dashboard and needs one click per choice. Clicking that
tab only opens the calendar — the report changes when a day is picked in it, and
anything clicked outside closes it again. Days that have not happened cannot be
picked, and neither can the months after this one.
A picked day is read back from this app's own database as its local
midnight-to-midnight window, so any day since the first import can be reviewed
without re-running `omp`. The **Account limits** panel disappears while a day is
selected: quotas are a single live reading from each provider, so they would say
nothing about a day that has already passed.

The **Projects** tab is a page of its own reached from the top navigation. A
project is the working directory Oh My Pi recorded for each session, so the page
needs no extra bookkeeping. Every project is one card carrying its total spend,
its share of the period's spend as a ring, the tokens and sessions behind that
number, and the split across the models that did the work. The whole breakdown
arrives in a single request, so no card has to be opened to read it.

The **Account limits** panel has a *Visible limits* control in its header for
choosing which quotas to display. Each quota is addressed by provider, account
and window, because the same provider can appear twice under two different
accounts and still report identically named windows. Hiding every window of a
provider removes its card from the panel. The choice is stored in the app's
own SQLite database through `/api/preferences`, so it is per install and it
survives quitting the app. The window cannot keep it itself: the local
server binds an ephemeral port, so every launch is a new origin with an
empty `localStorage`.

## Where the data lives

The desktop app reads Oh My Pi's own database at `~/.omp/stats.db` and writes
its own SQLite database into the per-user application-data directory, which on
macOS is `~/Library/Application Support/com.tokentracker.desktop/token-tracker.sqlite`.
Setting `DATA_DIR` overrides that directory.

The extension keeps its database in VS Code's global storage directory instead,
which on macOS is
`~/Library/Application Support/Code/User/globalStorage/prajwal-hebbar-07.token-tracker/token-tracker.sqlite`,
so installing both leaves each with its own copy.

Account limits come from each provider rather than from estimates based on
local token counts. Oh My Pi supplies the supported providers; Ollama Cloud's
session and weekly percentages come from its account usage endpoint. Token
Tracker uses `OLLAMA_API_KEY` when set, otherwise the enabled `ollama-cloud`
credential in Oh My Pi's agent database. Ollama does not currently return reset
timestamps.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OMP_STATS_DB` | `~/.omp/stats.db` | Oh My Pi source database |
| `DATA_DIR` | app data directory | Token Tracker SQLite directory |
| `OMP_BIN` | `omp` | Oh My Pi binary used for the session sync and usage limits |
| `OMP_AGENT_DB` | `~/.omp/agent/agent.db` | Oh My Pi credential database used for Ollama Cloud |
| `OLLAMA_API_KEY` | Oh My Pi credential | Optional Ollama Cloud API-key override |
| `TOKEN_TRACKER_PORT` | ephemeral | Desktop app loopback port; `0` picks any free port |

## Commands

```bash
pnpm dev
pnpm bundle
pnpm test
pnpm build
```

`pnpm dev` runs the desktop app from a debug build, `pnpm bundle` produces the
installer, `pnpm test` runs the reference API test suite, and `pnpm build`
compiles the dashboard bundle that gets embedded into the binary.

There is no development web server. The dashboard is a static bundle compiled
into the app, so `apps/web` is built rather than served, and nothing listens on
a fixed port.

The desktop backend is a Rust port of the API in `apps/api`, which is still the
reference implementation and is what the VS Code extension runs directly.
`cargo test` inside `apps/desktop/src-tauri` imports one fixture with both and
compares the resulting dashboard and projects reports field by field, so the two
cannot disagree about a number without failing:

```bash
cd apps/desktop/src-tauri && cargo test
```

## Releasing

Releases are cut from the Actions tab, not from a local tag. Open **Actions**,
select the **Release** workflow, press **Run workflow**, choose whether to bump
the `patch`, `minor` or `major` version, and run it. The workflow owns the
version number, so nothing needs editing by hand beforehand.

It writes the new version into `apps/desktop/src-tauri/tauri.conf.json`,
`apps/desktop/src-tauri/Cargo.toml`, `apps/desktop/package.json`,
`apps/vscode/package.json` and `apps/desktop/src-tauri/Cargo.lock` together, runs
both test suites, builds the universal macOS bundle and the extension, and only
then commits the bump, tags it `v<version>`, pushes the commit and the tag, and
publishes the release with `Token-Tracker-<version>-universal.dmg` and
`Token-Tracker-<version>.vsix` attached.

The order matters: a failed test or a failed build pushes nothing at all, so the
repository is never left claiming a version that was never released. Pull
afterwards to pick up the bump, which is what keeps the local checkout and
GitHub on the same version:

```bash
git pull
```

Tick **dry run** to bump, test and build without committing, tagging or
publishing anything. The installer is uploaded as a workflow artifact instead,
which is the way to exercise the workflow without cutting a release.
