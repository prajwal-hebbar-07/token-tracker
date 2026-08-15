import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { getDashboard, importFromOmp, openTrackerDatabase } from "../src/db.js";

function writeSession(filePath: string, userText: string, entryIds: string[]): void {
  const records: Array<Record<string, unknown>> = [
    {
      type: "message",
      id: "user-request",
      parentId: null,
      message: { role: "user", content: [{ type: "text", text: userText }] },
    },
  ];
  let parentId = "user-request";
  for (const entryId of entryIds) {
    records.push({
      type: "message",
      id: entryId,
      parentId,
      message: { role: "assistant", content: [] },
    });
    parentId = entryId;
  }

  let jsonl = "";
  for (const record of records) jsonl += `${JSON.stringify(record)}\n`;
  writeFileSync(filePath, jsonl);
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
    const design = firstDashboard.categories.find((category) => category.category === "Design");
    const debugging = firstDashboard.categories.find((category) => category.category === "Debugging");
    assert.ok(design);
    assert.ok(debugging);
    assertClose(design.cost, 0.056);
    assertClose(debugging.cost, 0.0015);
    assert.equal(firstDashboard.workspaces.length, 2);
    assert.equal(firstDashboard.agents.length, 2);

    const claude = firstDashboard.models.find((model) => model.model === "claude-opus-5");
    assert.ok(claude);
    assert.ok(Math.abs((claude.inputPricePerMillion ?? Number.NaN) - 5) < 1e-12);
    assert.ok(Math.abs((claude.outputPricePerMillion ?? Number.NaN) - 25) < 1e-12);
    assert.ok(Math.abs((claude.cacheReadPricePerMillion ?? Number.NaN) - 0.5) < 1e-12);
    assert.ok(Math.abs((claude.cacheWritePricePerMillion ?? Number.NaN) - 10) < 1e-12);

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
    const categorizedDashboard = getDashboard(tracker);
    assertClose(categorizedDashboard.summary.cost, 0.42400012);
    const research = categorizedDashboard.categories.find((category) => category.category === "Research");
    const logic = categorizedDashboard.categories.find((category) => category.category === "Logic & planning");
    assert.ok(research);
    assert.ok(logic);
    assertClose(research.cost, 0.054);
    assertClose(logic.cost, 0.31200012);
  } finally {
    source.close();
    tracker.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
