import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { getDashboard, importFromOmp, openTrackerDatabase, saveLimitsSnapshot } from "../src/db.js";

function writeSession(filePath: string, userText: string, entryIds: string[]): void {
  const lines: string[] = [];
  lines.push(JSON.stringify({ id: "user-request", message: { role: "user", content: userText } }));
  for (const entryId of entryIds) {
    lines.push(JSON.stringify({ id: entryId, parentId: "user-request" }));
  }
  writeFileSync(filePath, lines.join("\n") + "\n");
}

function createSourceDatabase(filePath: string): DatabaseSync {
  const source = new DatabaseSync(filePath);
  const directory = dirname(filePath);
  const session1 = join(directory, "session-1.jsonl");
  const session2 = join(directory, "session-2.jsonl");
  writeSession(session1, "Design a responsive settings page with clear visual hierarchy.", ["entry-1", "entry-2"]);
  writeSession(session2, "Fix the database migration bug that is failing.", ["entry-3"]);
  writeSession(join(directory, "session-3.jsonl"), "Investigate competing model capabilities on their website.", ["entry-4"]);
  writeSession(join(directory, "session-4.jsonl"), "Reason about the best architecture and tradeoffs.", ["entry-5"]);
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
  insert.run(1, session1, "entry-1", "workspace-alpha", "claude-opus-5", "anthropic", "messages", 1_700_000_000_000, 100, 50, "stop", null, 1_000, 100, 5_000, 2_000, 8_100, 0, 0.005, 0.0025, 0.0025, 0.02, 0.03, "main", 0.0405);
  insert.run(2, session1, "entry-2", "workspace-alpha", "claude-opus-5", "anthropic", "messages", 1_700_000_001_000, 120, 55, "stop", null, 2_000, 200, 2_000, 1_000, 5_200, 0, 0.01, 0.005, 0.001, 0.01, 0.026, "scout", 0.026);
  insert.run(3, session2, "entry-3", "workspace-beta", "gpt-test", "openai", "responses", 1_700_086_400_000, 80, 40, "stop", null, 500, 50, 0, 0, 550, 0, 0.001, 0.0005, 0, 0, 0.0015, "main", 0.0015);
  return source;
}

function assertClose(actual: unknown, expected: number): void {
  assert.equal(typeof actual, "number");
  assert.ok(Math.abs(actual - expected) < 1e-12);
}

test("imports OMP rows idempotently and applies recorded and MiniMax prices", () => {
  const directory = mkdtempSync(join(tmpdir(), "token-tracker-"));
  const sourcePath = join(directory, "omp.sqlite");
  const trackerPath = join(directory, "tracker.sqlite");
  const source = createSourceDatabase(sourcePath);
  const tracker = openTrackerDatabase(trackerPath);

  try {
    const firstImport = importFromOmp(tracker, sourcePath);
    assert.deepEqual(
      { sourceRecords: firstImport.sourceRecords, newRecords: firstImport.newRecords, totalRecords: firstImport.totalRecords },
      { sourceRecords: 3, newRecords: 3, totalRecords: 3 },
    );

    const firstDashboard = getDashboard(tracker);
    assert.ok(Math.abs(firstDashboard.summary.cost - 0.0575) < 1e-12);
    assert.equal(firstDashboard.summary.totalTokens, 13_850);
    assert.equal(firstDashboard.summary.sessionCount, 2);
    const firstDesign = firstDashboard.categories.find((entry) => entry.category === "Design");
    assert.ok(firstDesign);
    assert.equal(firstDesign.totalTokens, 13_300);
    const firstDebugging = firstDashboard.categories.find((entry) => entry.category === "Debugging");
    assert.ok(firstDebugging);
    assert.equal(firstDebugging.totalTokens, 550);

    const claude = firstDashboard.models.find((model) => model.model === "claude-opus-5");
    assert.ok(claude);
    assertClose(claude.cost, 0.056);
    assertClose(claude.effectivePricePerMillion, (0.056 / 13_300) * 1_000_000);

    const secondImport = importFromOmp(tracker, sourcePath);
    assert.equal(secondImport.newRecords, 0);
    assert.equal(secondImport.totalRecords, 3);

    source.prepare(`
      UPDATE messages
      SET cost_output = 0.001, cost_total = 0.002
      WHERE entry_id = 'entry-3'
    `).run();
    importFromOmp(tracker, sourcePath);
    assert.ok(Math.abs(getDashboard(tracker).summary.cost - 0.058) < 1e-12);

    const insertMinimax = source.prepare(`
      INSERT INTO messages VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `);
    insertMinimax.run(4, join(directory, "session-3.jsonl"), "entry-4", "workspace-gamma", "minimax-m3", "ollama-cloud", "ollama", 1_700_172_800_000, 90, 45, "stop", null, 100_000, 10_000, 200_000, 0, 310_000, 0, 0, 0, 0, 0, 0, "task", 0);
    insertMinimax.run(5, join(directory, "session-4.jsonl"), "entry-5", "workspace-gamma", "minimax-m3", "ollama-cloud", "ollama", 1_700_259_200_000, 95, 47, "stop", null, 400_000, 20_000, 200_001, 0, 620_001, 0, 0, 0, 0, 0, 0, "task", 0);
    const minimaxImport = importFromOmp(tracker, sourcePath);
    assert.equal(minimaxImport.newRecords, 2);
    assert.equal(minimaxImport.totalRecords, 5);

    const shortContext = tracker.prepare(`
      SELECT cost_input, cost_output, cost_cache_read, cost_cache_write,
             cost_total, cost_no_cache_input
      FROM usage_messages
      WHERE entry_id = 'entry-4'
    `).get();
    assert.ok(shortContext);
    assertClose(shortContext.cost_input, 0.03);
    assertClose(shortContext.cost_output, 0.012);
    assertClose(shortContext.cost_cache_read, 0.012);
    assertClose(shortContext.cost_cache_write, 0);
    assertClose(shortContext.cost_total, 0.054);
    assertClose(shortContext.cost_no_cache_input, 0.09);

    const longContext = tracker.prepare(`
      SELECT cost_input, cost_output, cost_cache_read, cost_cache_write,
             cost_total, cost_no_cache_input
      FROM usage_messages
      WHERE entry_id = 'entry-5'
    `).get();
    assert.ok(longContext);
    assertClose(longContext.cost_input, 0.24);
    assertClose(longContext.cost_output, 0.048);
    assertClose(longContext.cost_cache_read, 0.02400012);
    assertClose(longContext.cost_cache_write, 0);
    assertClose(longContext.cost_total, 0.31200012);
    assertClose(longContext.cost_no_cache_input, 0.3600006);

    const finalDashboard = getDashboard(tracker);
    assertClose(finalDashboard.summary.cost, 0.42400012);
    const minimax = finalDashboard.models.find((model) => model.model === "minimax-m3");
    assert.ok(minimax);
    assertClose(minimax.cost, 0.36600012);
    assertClose(minimax.effectivePricePerMillion, (0.36600012 / 930_001) * 1_000_000);
    const finalResearch = finalDashboard.categories.find((entry) => entry.category === "Research");
    assert.ok(finalResearch);
    assert.equal(finalResearch.totalTokens, 310_000);
    const finalLogic = finalDashboard.categories.find((entry) => entry.category === "Logic & planning");
    assert.ok(finalLogic);
    assert.equal(finalLogic.totalTokens, 620_001);
  } finally {
    source.close();
    tracker.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("keeps only the newest limits snapshot and serves it to the dashboard", () => {
  const directory = mkdtempSync(join(tmpdir(), "token-tracker-limits-"));
  const tracker = openTrackerDatabase(join(directory, "tracker.sqlite"));

  try {
    assert.equal(getDashboard(tracker).limits, null);

    saveLimitsSnapshot(tracker, {
      capturedAt: 1_700_000_000_000,
      generatedAt: 1_699_999_999_000,
      providers: [
        {
          provider: "anthropic",
          account: "someone@example.com",
          plan: null,
          fetchedAt: 1_699_999_998_000,
          windows: [
            {
              id: "anthropic:5h",
              label: "Claude 5 Hour",
              unit: "percent",
              status: "ok",
              used: 47,
              limit: 100,
              remaining: 53,
              usedFraction: 0.47,
              resetsAt: 1_700_003_600_000,
            },
          ],
          notes: [],
        },
      ],
    });
    saveLimitsSnapshot(tracker, {
      capturedAt: 1_700_000_060_000,
      generatedAt: null,
      providers: [{ provider: "ollama-cloud", account: null, plan: null, fetchedAt: null, windows: [], notes: ["No quota API."] }],
    });

    const rows = tracker.prepare("SELECT COUNT(*) AS count FROM limit_snapshots").get();
    assert.equal(rows?.count, 1);

    const limits = getDashboard(tracker).limits;
    assert.ok(limits);
    assert.equal(limits.capturedAt, 1_700_000_060_000);
    assert.deepEqual(limits.providers.map((provider) => provider.provider), ["ollama-cloud"]);
    assert.deepEqual(limits.providers[0]?.notes, ["No quota API."]);
  } finally {
    tracker.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("preserves the work-category column from earlier builds", () => {
  const directory = mkdtempSync(join(tmpdir(), "token-tracker-migrate-"));
  const trackerPath = join(directory, "tracker.sqlite");
  const legacy = new DatabaseSync(trackerPath);
  legacy.exec(`
    CREATE TABLE usage_messages (
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
      category TEXT NOT NULL,
      imported_at INTEGER NOT NULL,
      PRIMARY KEY (session_file, entry_id)
    ) WITHOUT ROWID;
    CREATE INDEX usage_category_idx ON usage_messages(category);
    INSERT INTO usage_messages VALUES (
      'session-1.jsonl', 'entry-1', 'workspace', 'claude-opus-5', 'anthropic', 'messages',
      1700000000000, 100, 50, 'stop', NULL, 1000, 100, 0, 0, 1100, 0,
      0.01, 0.01, 0, 0, 0.02, 'main', 0.02, 'Design', 1700000000000
    );
  `);
  legacy.close();

  const tracker = openTrackerDatabase(trackerPath);
  try {
    const columns = tracker.prepare("PRAGMA table_info(usage_messages)").all();
    assert.ok(columns.some((column) => column.name === "category"));

    // Existing rows survive the migration and still aggregate.
    const dashboard = getDashboard(tracker);
    assert.equal(dashboard.summary.messageCount, 1);
    assertClose(dashboard.models[0]?.cost, 0.02);
    const design = dashboard.categories.find((entry) => entry.category === "Design");
    assert.ok(design);
    assert.equal(design.totalTokens, 1_100);

    // Reopening a migrated database is a no-op rather than an error.
    openTrackerDatabase(trackerPath).close();
  } finally {
    tracker.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
