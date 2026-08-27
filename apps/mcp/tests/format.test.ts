import assert from "node:assert/strict";
import test from "node:test";
import type { Dashboard, ModelsReport, ProjectsReport } from "@token-tracker/api/dist/db.js";
import { formatImport, formatUsage } from "../src/format.js";

const emptyDashboard: Dashboard = {
  generatedAt: 0,
  lastSync: null,
  summary: {
    messageCount: 0,
    sessionCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    cost: 0,
    firstMessageAt: null,
    lastMessageAt: null,
  },
  categories: [],
  limits: null,
};

const emptyModels: ModelsReport = { generatedAt: 0, models: [] };
const emptyProjects: ProjectsReport = {
  generatedAt: 0,
  period: "month",
  totals: { cost: 0, totalTokens: 0, messageCount: 0, sessionCount: 0, projectCount: 0 },
  models: [],
  projects: [],
};

test("formatUsage asks for a refresh when nothing has been imported", () => {
  const text = formatUsage("month", emptyDashboard, emptyModels, emptyProjects);
  assert.match(text, /Spend: \$0\.00/);
  assert.match(text, /Last imported: never/);
  assert.match(text, /refresh_usage/);
});

test("formatUsage includes spend, limits, models and projects", () => {
  const dashboard: Dashboard = {
    ...emptyDashboard,
    lastSync: { completedAt: Date.UTC(2026, 7, 27, 12), sourceRecords: 4, newRecords: 1, totalRecords: 4 },
    summary: { ...emptyDashboard.summary, messageCount: 2, sessionCount: 1, totalTokens: 11_000, cost: 1.5 },
    categories: [{ category: "Debugging", messageCount: 2, totalTokens: 11_000 }],
    limits: {
      capturedAt: 1,
      generatedAt: 1,
      providers: [{
        provider: "cursor",
        account: "dev@example.com",
        plan: "Pro",
        fetchedAt: 1,
        notes: [],
        windows: [{
          id: "included",
          label: "Included usage",
          unit: "usd",
          status: "ok",
          used: 12.5,
          limit: 20,
          remaining: 7.5,
          usedFraction: 0.625,
          resetsAt: null,
        }],
      }],
    },
  };
  const models: ModelsReport = {
    generatedAt: 0,
    models: [{
      model: "gpt-5",
      provider: "cursor",
      cost: 1.5,
      effectivePricePerMillion: 136.36,
    }],
  };
  const projects: ProjectsReport = {
    ...emptyProjects,
    projects: [{
      folder: "demo",
      path: "/tmp/demo",
      name: "demo",
      cost: 1.5,
      totalTokens: 11_000,
      inputTokens: 10_000,
      outputTokens: 1_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      messageCount: 2,
      sessionCount: 1,
      firstMessageAt: 1,
      lastMessageAt: 2,
      effectivePricePerMillion: 136.36,
      models: [],
    }],
  };

  const text = formatUsage("month", dashboard, models, projects);
  assert.match(text, /Spend: \$1\.50/);
  assert.match(text, /cursor · dev@example.com · Pro/);
  assert.match(text, /Included usage: \$12\.50 \/ \$20\.00 \(63%\)/);
  assert.match(text, /gpt-5 \(cursor\): \$1\.50/);
  assert.match(text, /- demo: \$1\.50/);
});

test("formatImport lists new records and warnings", () => {
  const text = formatImport(["Cursor is not signed in"], 3);
  assert.match(text, /New records: 3/);
  assert.match(text, /- Cursor is not signed in/);
});
