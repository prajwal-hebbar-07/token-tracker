// Reference output generator for the desktop port's parity test.
//
// Builds a fixture Oh My Pi stats database plus its session transcripts, imports
// it with this package's implementation, and prints the dashboard and projects
// reports as JSON. The Rust port reads the same fixture and its output is
// compared against this one, so the two implementations cannot drift silently.
//
// Not a test itself: the filename deliberately falls outside the `*.test.ts`
// glob that `pnpm test` runs.

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type DashboardPeriod,
  type DayPeriod,
  getDashboard,
  getProjects,
  importFromOmp,
  openTrackerDatabase,
  saveLimitsSnapshot,
} from "../src/db.js";
import type { LimitsSnapshot } from "../src/omp-cli.js";

const directory = process.argv[2];
const now = Number(process.argv[3]);
if (!directory || !Number.isFinite(now)) {
  throw new Error("usage: parity-dump.ts <fixture-directory> <now-millis>");
}

function writeSession(filePath: string, userText: string, entryIds: string[], cwd?: string): void {
  const lines: string[] = [];
  if (cwd !== undefined) lines.push(JSON.stringify({ type: "session", cwd }));
  lines.push(JSON.stringify({ id: "user-request", message: { role: "user", content: userText } }));
  for (const entryId of entryIds) {
    lines.push(JSON.stringify({ id: entryId, parentId: "user-request" }));
  }
  writeFileSync(filePath, lines.join("\n") + "\n");
}

mkdirSync(directory, { recursive: true });
const sourcePath = join(directory, "omp.sqlite");
const alphaWorkspace = join(homedir(), "code", "demo-app");
const scratchWorkspace = join(tmpdir(), "probe-run");

const session1 = join(directory, "session-1.jsonl");
const session2 = join(directory, "session-2.jsonl");
const session3 = join(directory, "session-3.jsonl");
const session4 = join(directory, "session-4.jsonl");
const session5 = join(directory, "session-5.jsonl");
const session6 = join(directory, "session-6.jsonl");
const session7 = join(directory, "session-7.jsonl");

// One transcript per category rule that matters, so the classifier is exercised
// rather than assumed: Design, Debugging, Research, and the default.
writeSession(session1, "Design a responsive settings page with clear visual hierarchy.", ["entry-1", "entry-2", "entry-9"], alphaWorkspace);
writeSession(session2, "Fix the database migration bug that is failing.", ["entry-3", "entry-10"]);
writeSession(session3, "Investigate competing model capabilities on their website.", ["entry-4"]);
writeSession(session4, "Reason about the best architecture and tradeoffs.", ["entry-5"]);
writeSession(session5, "Add a smoke probe command.", ["entry-6"], scratchWorkspace);
writeSession(session6, "Update the release pipeline.", ["entry-7"]);
writeSession(session7, "Explain how does the cache read pricing work.", ["entry-8", "entry-11"]);

const source = new DatabaseSync(sourcePath);
source.exec(`
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    session_file TEXT NOT NULL,
    entry_id TEXT NOT NULL,
    folder TEXT NOT NULL,
    model TEXT NOT NULL,
    provider TEXT NOT NULL,
    api TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    duration REAL,
    ttft REAL,
    stop_reason TEXT NOT NULL,
    error_message TEXT,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cache_read_tokens INTEGER NOT NULL,
    cache_write_tokens INTEGER NOT NULL,
    total_tokens INTEGER NOT NULL,
    premium_requests REAL NOT NULL,
    cost_input REAL NOT NULL,
    cost_output REAL NOT NULL,
    cost_cache_read REAL NOT NULL,
    cost_cache_write REAL NOT NULL,
    cost_total REAL NOT NULL,
    agent_type TEXT NOT NULL,
    cost_no_cache_input REAL,
    UNIQUE(session_file, entry_id)
  );
`);

const insert = source.prepare(`
  INSERT INTO messages VALUES (
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
  )
`);

const day = 86_400_000;
// Recorded provider prices.
insert.run(1, session1, "entry-1", "workspace-alpha", "claude-opus-5", "anthropic", "messages", 1_700_000_000_000, 100, 50, "stop", null, 1_000, 100, 5_000, 2_000, 8_100, 0, 0.005, 0.0025, 0.0025, 0.02, 0.03, "main", 0.0405);
insert.run(2, session1, "entry-2", "workspace-alpha", "claude-opus-5", "anthropic", "messages", 1_700_000_001_000, 120, 55, "stop", null, 2_000, 200, 2_000, 1_000, 5_200, 0, 0.01, 0.005, 0.001, 0.01, 0.026, "scout", 0.026);
insert.run(3, session2, "entry-3", "workspace-beta", "gpt-test", "openai", "responses", 1_700_086_400_000, 80, 40, "stop", null, 500, 50, 0, 0, 550, 0, 0.001, 0.0005, 0, 0, 0.0015, "main", 0.0015);
// MiniMax below the context tier boundary: prompt tokens 300_000.
insert.run(4, session3, "entry-4", "workspace-gamma", "minimax-m3", "ollama-cloud", "ollama", 1_700_172_800_000, 90, 45, "stop", null, 100_000, 10_000, 200_000, 0, 310_000, 0, 0, 0, 0, 0, 0, "task", 0);
// MiniMax one token above it: prompt tokens 600_001, so every rate doubles.
insert.run(5, session4, "entry-5", "workspace-gamma", "minimax-m3", "ollama-cloud", "ollama", 1_700_259_200_000, 95, 47, "stop", null, 400_000, 20_000, 200_001, 0, 620_001, 0, 0, 0, 0, 0, 0, "task", 0);
// Scratch directories must stay out of the project rollup.
insert.run(6, session5, "entry-6", "-tmp-probe-run", "gpt-test", "openai", "responses", 1_700_300_000_000, 70, 35, "stop", null, 300, 30, 0, 0, 330, 0, 0.0005, 0.0002, 0, 0, 0.0007, "main", 0.0007);
insert.run(7, session6, "entry-7", "tmp", "gpt-test", "openai", "responses", 1_700_300_100_000, 60, 30, "stop", null, 200, 20, 0, 0, 220, 0, 0.0004, 0.0001, 0, 0, 0.0005, "main", 0.0005);
// Zero tokens has no blended rate, so the price must be null rather than 0.
insert.run(8, session7, "entry-8", "workspace-delta", "zero-model", "openai", "responses", 1_700_300_200_000, 10, 5, "stop", "quota exceeded", 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, "main", null);
// Anchored to the caller's clock so the today and month windows are non-empty.
insert.run(9, session1, "entry-9", "workspace-alpha", "claude-opus-5", "anthropic", "messages", now - 1_000, 110, 52, "stop", null, 1_500, 150, 1_000, 500, 3_150, 0, 0.007, 0.003, 0.0005, 0.005, 0.0155, "main", 0.0155);
insert.run(10, session2, "entry-10", "workspace-beta", "gpt-test", "openai", "responses", now - 40 * day, 75, 38, "stop", null, 400, 40, 0, 0, 440, 0, 0.0008, 0.0004, 0, 0, 0.0012, "main", 0.0012);
// Kimi K2.6 with a prompt past MiniMax's tier boundary: the flat Moonshot rates
// must apply unchanged, in both implementations.
insert.run(11, session7, "entry-11", "workspace-delta", "kimi-k2.6", "ollama-cloud", "ollama", 1_700_300_250_000, 92, 46, "stop", null, 600_000, 10_000, 50_000, 0, 660_000, 0, 0, 0, 0, 0, 0, "task", 0);
source.close();

const tracker = openTrackerDatabase(join(directory, "tracker-ts.sqlite"));
importFromOmp(tracker, sourcePath);

// A stored snapshot also proves the JSON round-trip and the camelCase field
// names the dashboard reads.
const snapshot: LimitsSnapshot = {
  capturedAt: 1_700_300_300_000,
  generatedAt: 1_700_300_299_000,
  providers: [
    {
      provider: "ollama-cloud",
      account: null,
      plan: null,
      fetchedAt: 1_700_300_298_000,
      windows: [
        {
          id: "ollama-cloud:session",
          label: "Session",
          unit: "percent",
          status: "ok",
          used: 42.5,
          limit: 100,
          remaining: 57.5,
          usedFraction: 0.425,
          resetsAt: null,
        },
      ],
      notes: ["Ollama's usage endpoint does not expose reset times."],
    },
    {
      provider: "anthropic",
      account: "dev@example.com",
      plan: "max",
      fetchedAt: 1_700_300_297_000,
      windows: [
        {
          id: "anthropic:five-hour",
          label: "5 hour",
          unit: "count",
          status: "ok",
          used: 120,
          limit: 900,
          remaining: 780,
          usedFraction: 0.1333,
          resetsAt: 1_700_310_000_000,
        },
      ],
      notes: [],
    },
  ],
};
saveLimitsSnapshot(tracker, snapshot);

// The two day periods are derived from the caller's clock rather than hardcoded,
// so both sides pick the same local calendar dates in every time zone: one day
// holding the anchored row, and one holding the row 40 days behind it.
function localDay(millis: number): DayPeriod {
  const date = new Date(millis);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${String(date.getDate()).padStart(2, "0")}` as DayPeriod;
}

const periods: Array<[string, DashboardPeriod]> = [
  ["today", "today"],
  ["month", "month"],
  ["all", "all"],
  ["day", localDay(now)],
  ["pastDay", localDay(now - 40 * day)],
];
const output = {
  dashboard: Object.fromEntries(periods.map(([name, period]) => [name, getDashboard(tracker, period, now)])),
  projects: Object.fromEntries(periods.map(([name, period]) => [name, getProjects(tracker, period, now)])),
};
tracker.close();

process.stdout.write(JSON.stringify(output));
