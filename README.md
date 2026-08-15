# Token Tracker

Local dashboard for importing Oh My Pi usage, storing it in SQLite, and
breaking token spend down by model, workspace, day, and agent process.

## Run locally

Requires Node.js 22.5+ and pnpm.

```bash
pnpm install
pnpm dev
```

Open `http://localhost:3000`, then click **Fetch Oh My Pi data**. That button runs
`omp stats --json` first, which is what tails `~/.omp/agent/sessions/` into
`~/.omp/stats.db`, and then imports the refreshed database. Nothing else advances
`~/.omp/stats.db`, so without that step an import re-reads whatever snapshot the
last `omp stats` run left behind. There is still no polling or background sync;
everything happens on that click. If `omp` cannot be run the import falls back to
the existing snapshot and the dashboard shows a warning instead of pretending the
data is current.

The API reads `~/.omp/stats.db` by default and writes its own database to
`apps/api/data/token-tracker.sqlite`.

MiniMax-M3 rows are estimated using [MiniMax standard pay-as-you-go
pricing](https://platform.minimax.io/docs/guides/pricing-paygo): $0.30 input,
$1.20 output, and $0.06 cache-read per million tokens up to 512k input tokens.
Those rates double for longer inputs; passive cache writes have no added fee.

Work categories are heuristic estimates from the nearest user request in each
Oh My Pi session. The dashboard groups spend into design, development,
debugging, data and analytics, DevOps, documentation, research, review and
security, and logic and planning. Missing session text falls back to logic and
planning.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OMP_STATS_DB` | `~/.omp/stats.db` | Oh My Pi source database |
| `DATA_DIR` | `apps/api/data` | Token Tracker SQLite directory |
| `OMP_BIN` | `omp` | Oh My Pi binary used for the session sync |
| `PORT` | `4000` | API port |
| `HOST` | `127.0.0.1` | API bind address |
| `API_URL` | `http://127.0.0.1:4000` | Backend origin used by Next.js |

## Commands

```bash
pnpm test
pnpm build
```
