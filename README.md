# Token Tracker

Local dashboard for importing Oh My Pi usage, storing it in SQLite, and showing
what each model actually costs alongside the remaining quota on every
authenticated provider account.

## Run locally

Requires Node.js 22.5+ and pnpm.

```bash
pnpm install
pnpm dev
```

Open `http://localhost:3000`, then click **Fetch Oh My Pi data**. That button does
three things and nothing happens without it — there is no polling or background
sync:

1. Runs `omp stats --json`, which tails `~/.omp/agent/sessions/` into
   `~/.omp/stats.db`. Nothing else advances that database, so skipping this step
   would re-import whatever snapshot the last `omp stats` run left behind.
2. Imports the refreshed database into this app's own SQLite file.
3. Runs `omp usage --json`, then fills the Ollama Cloud report from
   `https://ollama.com/api/usage`, and stores the resulting account limits.

If either `omp` call fails the import still completes — with the existing stats
snapshot, and with the previously stored limits — and the dashboard shows a
warning instead of pretending the data is current.

The API reads `~/.omp/stats.db` by default and writes its own database to
`apps/api/data/token-tracker.sqlite`.

Account limits come from each provider rather than estimates based on local
token counts. Oh My Pi supplies the supported providers; Ollama Cloud's session
and weekly percentages come from its account usage endpoint. Token Tracker uses
`OLLAMA_API_KEY` when set, otherwise the enabled `ollama-cloud` credential in Oh
My Pi's agent database. Ollama does not currently return reset timestamps.

MiniMax-M3 rows are estimated using [MiniMax standard pay-as-you-go
pricing](https://platform.minimax.io/docs/guides/pricing-paygo): $0.30 input,
$1.20 output, and $0.06 cache-read per million tokens up to 512k input tokens.
Those rates double for longer inputs; passive cache writes have no added fee.

Model spend is shown as a deck of cards rather than a table: each ring is that
model's share of total spend, the number inside it is the blended price actually
paid per million tokens, and the bar underneath compares that price against the
priciest model in use.

The **Projects** tab is a page of its own at `http://localhost:3000/projects`. A
project is the working directory Oh My Pi recorded for each session, so the page
needs no extra bookkeeping. Every project is one card carrying its total spend,
its share of the period's spend as a ring, the tokens and sessions behind that
number, and the split across the models that did the work. The whole breakdown
arrives in a single request, so no card has to be opened to read it.

The API serves `GET /api/dashboard?period=today|month|all` for the dashboard and
`GET /api/projects?period=today|month|all` for the projects page, and
`POST /api/import` for the fetch button. All three default to the whole history
when no period is given.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OMP_STATS_DB` | `~/.omp/stats.db` | Oh My Pi source database |
| `DATA_DIR` | `apps/api/data` | Token Tracker SQLite directory |
| `OMP_BIN` | `omp` | Oh My Pi binary used for the session sync and usage limits |
| `OMP_AGENT_DB` | `~/.omp/agent/agent.db` | Oh My Pi credential database used for Ollama Cloud |
| `OLLAMA_API_KEY` | Oh My Pi credential | Optional Ollama Cloud API-key override |
| `PORT` | `4000` | API port |
| `HOST` | `127.0.0.1` | API bind address |
| `API_URL` | `http://127.0.0.1:4000` | Backend origin used by Next.js |

## Commands

```bash
pnpm test
pnpm build
```
