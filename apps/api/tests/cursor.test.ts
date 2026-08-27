import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  cursorEventId,
  cursorSessionFile,
  indexCursorConversations,
  parseCursorLimits,
  parseCursorTime,
  parseCursorUsageEvent,
} from "../src/cursor.js";
import {
  classifyUserText,
  getDashboard,
  getModels,
  getProjects,
  importFromCursor,
  openTrackerDatabase,
  overlayProviderLimits,
  saveLimitsSnapshot,
} from "../src/db.js";

test("parses Cursor usage events from numbers or strings", () => {
  const event = parseCursorUsageEvent({
    timestamp: "1700000000000",
    model: "composer-2.5",
    kind: "USAGE_EVENT_KIND_INCLUDED_IN_PRO",
    conversationId: "abc-123",
    isHeadless: false,
    requestsCosts: 0.9,
    chargedCents: 12.5,
    tokenUsage: {
      inputTokens: "10",
      outputTokens: 20,
      cacheReadTokens: "100",
      cacheWriteTokens: 0,
      totalCents: 12.5,
    },
  });
  assert.ok(event);
  assert.equal(event.timestamp, 1_700_000_000_000);
  assert.equal(event.model, "composer-2.5");
  assert.equal(event.conversationId, "abc-123");
  assert.equal(event.inputTokens, 10);
  assert.equal(event.outputTokens, 20);
  assert.equal(event.cacheReadTokens, 100);
  assert.equal(event.chargedCents, 12.5);
  assert.equal(cursorSessionFile(event), "cursor://abc-123");
  assert.equal(cursorEventId(event), "abc-123:1700000000000:composer-2.5:10:20:100:0");
});

test("drops Cursor events that have no model or timestamp", () => {
  assert.equal(parseCursorUsageEvent({ model: "composer-2.5" }), null);
  assert.equal(parseCursorUsageEvent({ timestamp: 1 }), null);
});

test("parses Cursor billing timestamps as millis or ISO dates", () => {
  assert.equal(parseCursorTime("1700000000000"), 1_700_000_000_000);
  assert.equal(parseCursorTime(1_700_000_000_000), 1_700_000_000_000);
  assert.equal(parseCursorTime("2026-01-15T00:00:00.000Z"), Date.parse("2026-01-15T00:00:00.000Z"));
  assert.equal(parseCursorTime("nope"), null);
});

test("parses Cursor plan usage into the limits snapshot shape", () => {
  const report = parseCursorLimits(
    {
      billingCycleEnd: "1700310000000",
      displayMessage: "You've used 40% of your included usage",
      planUsage: { totalSpend: 2800, limit: 7000, remaining: 4200, totalPercentUsed: 40 },
      spendLimitUsage: { pooledLimit: 5000, pooledUsed: 1000, pooledRemaining: 4000 },
    },
    { planInfo: { planName: "Pro+", includedAmountCents: 7000 } },
    "dev@example.com",
    1_700_300_300_000,
  );
  assert.ok(report);
  assert.equal(report.provider, "cursor");
  assert.equal(report.account, "dev@example.com");
  assert.equal(report.plan, "Pro+");
  assert.equal(report.windows[0]?.id, "cursor:included");
  assert.equal(report.windows[0]?.used, 28);
  assert.equal(report.windows[0]?.limit, 70);
  assert.equal(report.windows[0]?.remaining, 42);
  assert.equal(report.windows[0]?.usedFraction, 0.4);
  assert.equal(report.windows[0]?.resetsAt, 1_700_310_000_000);
  assert.equal(report.windows[1]?.id, "cursor:spend-limit");
  assert.equal(report.windows[1]?.used, 10);
  assert.equal(report.windows[1]?.limit, 50);
});

test("treats Cursor percent-used values at or below 1 as fractions", () => {
  const report = parseCursorLimits(
    { planUsage: { totalSpend: 100, limit: 200, totalPercentUsed: 0.5 } },
    {},
    null,
    1,
  );
  assert.equal(report?.windows[0]?.usedFraction, 0.5);
});

test("classifies Cursor user queries after stripping chat wrappers", () => {
  const text = "<timestamp>Thursday</timestamp>\n<user_query>\nFix the database migration bug that is failing.\n</user_query>";
  assert.equal(classifyUserText(text), "Debugging");
});

test("indexes Cursor conversations from local transcripts and workspace paths", () => {
  const directory = mkdtempSync(join(tmpdir(), "cursor-index-"));
  const projects = join(directory, "projects");
  const storage = join(directory, "workspaceStorage", "hash");
  const conversationId = "conv-1";
  const transcriptDir = join(projects, "Users-demo-app", "agent-transcripts", conversationId);
  mkdirSync(transcriptDir, { recursive: true });
  mkdirSync(storage, { recursive: true });
  writeFileSync(
    join(storage, "workspace.json"),
    JSON.stringify({ folder: "file:///Users/demo/app" }),
  );
  writeFileSync(
    join(transcriptDir, `${conversationId}.jsonl`),
    `${JSON.stringify({
      role: "user",
      message: { content: [{ type: "text", text: "<user_query>Design a responsive settings page.</user_query>" }] },
    })}\n`,
  );

  const conversations = indexCursorConversations(projects, join(directory, "workspaceStorage"));
  const found = conversations.get(conversationId);
  assert.ok(found);
  assert.equal(found.folder, "Users-demo-app");
  assert.equal(found.path, "/Users/demo/app");
  assert.match(found.userText ?? "", /Design a responsive settings page/);
  rmSync(directory, { force: true, recursive: true });
});

test("imports Cursor events into the dashboard and keeps them on a second pass", () => {
  const directory = mkdtempSync(join(tmpdir(), "cursor-import-"));
  const tracker = openTrackerDatabase(join(directory, "tracker.sqlite"));
  const events = [
    {
      timestamp: 1_700_000_000_000,
      model: "composer-2.5",
      kind: "USAGE_EVENT_KIND_INCLUDED_IN_PRO",
      conversationId: "conv-1",
      isHeadless: false,
      requestsCosts: 0.9,
      chargedCents: 12.5,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 20,
      cacheWriteTokens: 0,
    },
    {
      timestamp: 1_700_000_001_000,
      model: "claude-4.6-sonnet",
      kind: "USAGE_EVENT_KIND_USAGE_BASED",
      conversationId: null,
      isHeadless: true,
      requestsCosts: 0,
      chargedCents: 80,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  ];
  const conversations = new Map([
    [
      "conv-1",
      {
        folder: "Users-demo-app",
        path: join(homedir(), "code", "demo-app"),
        userText: "Fix the database migration bug that is failing.",
      },
    ],
  ]);

  const first = importFromCursor(tracker, events, conversations);
  assert.equal(first.sourceRecords, 2);
  assert.equal(first.newRecords, 2);
  const second = importFromCursor(tracker, events, conversations);
  assert.equal(second.newRecords, 0);

  const dashboard = getDashboard(tracker, "all", 1_800_000_000_000);
  assert.equal(dashboard.summary.messageCount, 2);
  assert.equal(dashboard.summary.sessionCount, 2);
  assert.equal(dashboard.summary.inputTokens, 110);
  assert.equal(dashboard.summary.outputTokens, 55);
  assert.equal(dashboard.summary.cacheReadTokens, 20);
  assert.equal(dashboard.summary.totalTokens, 185);
  assert.equal(dashboard.summary.cost, 0.925);

  const models = getModels(tracker, "all", 1_800_000_000_000);
  assert.deepEqual(
    models.models.map((entry) => entry.provider),
    ["cursor", "cursor"],
  );

  const projects = getProjects(tracker, "all", 1_800_000_000_000);
  const app = projects.projects.find((project) => project.folder === "Users-demo-app");
  assert.ok(app);
  assert.equal(app.cost, 0.125);
  const debugging = dashboard.categories.find((entry) => entry.category === "Debugging");
  assert.ok(debugging);
  assert.equal(debugging.messageCount, 1);

  tracker.close();
  rmSync(directory, { force: true, recursive: true });
});

test("overlays Cursor limits onto an existing snapshot without dropping other providers", () => {
  const directory = mkdtempSync(join(tmpdir(), "cursor-limits-"));
  const tracker = openTrackerDatabase(join(directory, "tracker.sqlite"));
  saveLimitsSnapshot(tracker, {
    capturedAt: 1,
    generatedAt: 2,
    providers: [
      {
        provider: "anthropic",
        account: "dev@example.com",
        plan: "max",
        fetchedAt: 1,
        windows: [],
        notes: [],
      },
    ],
  });
  const snapshot = overlayProviderLimits(tracker, null, {
    provider: "cursor",
    account: "me@example.com",
    plan: "Pro",
    fetchedAt: 3,
    windows: [
      {
        id: "cursor:included",
        label: "Included usage",
        unit: "usd",
        status: "ok",
        used: 10,
        limit: 20,
        remaining: 10,
        usedFraction: 0.5,
        resetsAt: null,
      },
    ],
    notes: [],
  });
  assert.deepEqual(
    snapshot.providers.map((provider) => provider.provider),
    ["anthropic", "cursor"],
  );
  assert.equal(snapshot.generatedAt, 2);
  tracker.close();
  rmSync(directory, { force: true, recursive: true });
});
