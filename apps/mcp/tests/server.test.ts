import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openTrackerDatabase, saveLimitsSnapshot } from "@token-tracker/api/dist/db.js";
import { dispatch } from "../src/server.js";

function toolText(response: Awaited<ReturnType<typeof dispatch>>): string {
  assert.ok(response);
  assert.ok("result" in response);
  const result = response.result as { content?: Array<{ text?: string }> };
  const text = result.content?.[0]?.text;
  assert.equal(typeof text, "string");
  return text;
}

test("initialize echoes the client's protocol version and lists the usage tools", async () => {
  const directory = mkdtempSync(join(tmpdir(), "token-tracker-mcp-"));
  const tracker = openTrackerDatabase(join(directory, "tracker.sqlite"));
  try {
    const initialized = await dispatch(tracker, {
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {} },
    });
    assert.ok(initialized && "result" in initialized);
    const result = initialized.result as { protocolVersion: string; serverInfo: { name: string } };
    assert.equal(result.protocolVersion, "2025-06-18");
    assert.equal(result.serverInfo.name, "token-tracker");

    assert.equal(await dispatch(tracker, { method: "notifications/initialized" }), null);

    const listed = await dispatch(tracker, { id: 2, method: "tools/list" });
    assert.ok(listed && "result" in listed);
    const names = (listed.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);
    assert.deepEqual(names, ["refresh_usage", "get_usage"]);
  } finally {
    tracker.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("get_usage reports seeded spend for the asked period", async () => {
  const directory = mkdtempSync(join(tmpdir(), "token-tracker-mcp-"));
  const tracker = openTrackerDatabase(join(directory, "tracker.sqlite"));
  const now = Date.now();
  tracker.prepare(`
    INSERT INTO usage_messages (
      session_file, entry_id, folder, model, provider, api, timestamp, duration, ttft,
      stop_reason, error_message, input_tokens, output_tokens, cache_read_tokens,
      cache_write_tokens, total_tokens, premium_requests, cost_input, cost_output,
      cost_cache_read, cost_cache_write, cost_total, agent_type, cost_no_cache_input,
      category, project_path, imported_at
    ) VALUES (
      'cursor://chat-1', 'entry-1', 'demo-app', 'gpt-5', 'cursor', 'cursor', ?, 80, 40,
      'stop', NULL, 1000, 100, 0, 0, 1100, 0, 0.01, 0.02, 0, 0, 1.25, 'main', 0.03,
      'Debugging', '/Users/hebbar/code/demo-app', ?
    )
  `).run(now, now);
  tracker.prepare(`
    INSERT INTO sync_runs (started_at, completed_at, source_path, source_records, new_records, total_records)
    VALUES (?, ?, 'cursor', 1, 1, 1)
  `).run(now, now);
  saveLimitsSnapshot(tracker, {
    capturedAt: now,
    generatedAt: now,
    providers: [{
      provider: "cursor",
      account: "dev@example.com",
      plan: "Pro",
      fetchedAt: now,
      notes: [],
      windows: [{
        id: "included",
        label: "Included usage",
        unit: "usd",
        status: "ok",
        used: 4,
        limit: 20,
        remaining: 16,
        usedFraction: 0.2,
        resetsAt: null,
      }],
    }],
  });

  try {
    const response = await dispatch(tracker, {
      id: 3,
      method: "tools/call",
      params: { name: "get_usage", arguments: { period: "all" } },
    });
    const text = toolText(response);
    assert.match(text, /# Token usage \(all\)/);
    assert.match(text, /Spend: \$1\.25/);
    assert.match(text, /Included usage: \$4\.00 \/ \$20\.00 \(20%\)/);
    assert.match(text, /gpt-5 \(cursor\)/);
    assert.match(text, /demo-app/);
  } finally {
    tracker.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("get_usage rejects an invalid period as a tool error", async () => {
  const directory = mkdtempSync(join(tmpdir(), "token-tracker-mcp-"));
  const tracker = openTrackerDatabase(join(directory, "tracker.sqlite"));
  try {
    const response = await dispatch(tracker, {
      id: 4,
      method: "tools/call",
      params: { name: "get_usage", arguments: { period: "yesterday" } },
    });
    assert.ok(response && "result" in response);
    const result = response.result as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /period must be/);
  } finally {
    tracker.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
