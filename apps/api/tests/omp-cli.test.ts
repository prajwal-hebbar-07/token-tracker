import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { readProviderLimits, syncOmpSessions } from "../src/omp-cli.js";

async function withBinary(
  contents: string | null,
  run: (directory: string) => void | Promise<void>,
): Promise<void> {
  const previousBinary = process.env.OMP_BIN;
  const previousDatabase = process.env.OMP_AGENT_DB;
  const previousApiKey = process.env.OLLAMA_API_KEY;
  const directory = mkdtempSync(join(tmpdir(), "omp-cli-"));
  const binary = join(directory, "omp");
  if (contents !== null) {
    writeFileSync(binary, contents);
    chmodSync(binary, 0o755);
  }
  process.env.OMP_BIN = binary;
  process.env.OMP_AGENT_DB = join(directory, "agent.db");
  delete process.env.OLLAMA_API_KEY;
  try {
    await run(directory);
  } finally {
    if (previousBinary === undefined) delete process.env.OMP_BIN;
    else process.env.OMP_BIN = previousBinary;
    if (previousDatabase === undefined) delete process.env.OMP_AGENT_DB;
    else process.env.OMP_AGENT_DB = previousDatabase;
    if (previousApiKey === undefined) delete process.env.OLLAMA_API_KEY;
    else process.env.OLLAMA_API_KEY = previousApiKey;
    rmSync(directory, { force: true, recursive: true });
  }
}

test("session sync reports no warning when omp exits cleanly", async () => {
  await withBinary("#!/bin/sh\necho '{}'\n", async () => {
    assert.equal(syncOmpSessions(), null);
  });
});

test("session sync warns instead of throwing when the omp binary is missing", async () => {
  await withBinary(null, async () => {
    const warning = syncOmpSessions();
    assert.ok(warning);
    assert.match(warning, /OMP_BIN/);
    assert.match(warning, /stale/);
  });
});

test("session sync warns with the failing exit code and stderr detail", async () => {
  await withBinary("#!/bin/sh\necho 'stats database is locked' >&2\nexit 3\n", async () => {
    const warning = syncOmpSessions();
    assert.ok(warning);
    assert.match(warning, /exit code 3/);
    assert.match(warning, /stats database is locked/);
  });
});

const usagePayload = {
  generatedAt: 1_700_000_000_000,
  reports: [
    {
      provider: "anthropic",
      fetchedAt: 1_699_999_999_000,
      limits: [
        {
          id: "anthropic:5h",
          label: "Claude 5 Hour",
          window: { id: "5h", label: "5 Hour", durationMs: 18_000_000, resetsAt: 1_700_003_600_000 },
          amount: { used: 47, limit: 100, remaining: 53, usedFraction: 0.47, unit: "percent" },
          status: "ok",
        },
        {
          id: "anthropic:extra",
          label: "Claude Extra Usage",
          amount: { used: 36.05, limit: 50, remaining: 13.95, usedFraction: 0.721, unit: "usd" },
          status: "ok",
        },
        { label: "dropped because it has no id", amount: { used: 1, unit: "percent" } },
      ],
      metadata: { email: "someone@example.com", accountId: "acct-1", orgName: "ignored" },
    },
    {
      provider: "openai-codex",
      limits: [],
      metadata: { planType: "plus", accountId: "acct-2" },
    },
    {
      provider: "ollama-cloud",
      limits: [],
      notes: ["Ollama does not expose a standalone quota usage API.", 7],
    },
    { limits: [] },
  ],
};

test("reads provider limits and keeps only recognised fields", async () => {
  await withBinary(`#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(usagePayload)}\nJSON\n`, async (directory) => {
    const databasePath = join(directory, "agent.db");
    const credentials = new DatabaseSync(databasePath);
    credentials.exec(`
      CREATE TABLE auth_credentials (
        provider TEXT,
        disabled_cause TEXT,
        updated_at INTEGER,
        data TEXT
      )
    `);
    credentials.prepare(`
      INSERT INTO auth_credentials (provider, disabled_cause, updated_at, data)
      VALUES (?, NULL, ?, ?)
    `).run("ollama-cloud", 1_700_000_000_000, JSON.stringify({ key: "ollama-test-key" }));
    credentials.close();

    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(String(input), "https://ollama.com/api/usage");
      assert.equal(new Headers(init?.headers).get("Authorization"), "ollama-test-key");
      return Response.json({
        limits: {
          session: { usage: 0.046, models: [] },
          weekly: { usage: 0.051, models: [] },
        },
      });
    }) as typeof fetch;

    try {
      const { snapshot, warning } = await readProviderLimits();
      assert.equal(warning, null);
      assert.ok(snapshot);
      assert.equal(snapshot.generatedAt, 1_700_000_000_000);
      assert.ok(snapshot.capturedAt > 0);

      // The report without a provider is dropped, the other three survive in order.
      assert.deepEqual(
        snapshot.providers.map((provider) => provider.provider),
        ["anthropic", "openai-codex", "ollama-cloud"],
      );

      const anthropic = snapshot.providers[0]!;
      assert.equal(anthropic.account, "someone@example.com");
      assert.equal(anthropic.plan, null);
      assert.equal(anthropic.fetchedAt, 1_699_999_999_000);
      assert.deepEqual(anthropic.windows.map((quota) => quota.id), ["anthropic:5h", "anthropic:extra"]);
      assert.deepEqual(anthropic.windows[0], {
        id: "anthropic:5h",
        label: "Claude 5 Hour",
        unit: "percent",
        status: "ok",
        used: 47,
        limit: 100,
        remaining: 53,
        usedFraction: 0.47,
        resetsAt: 1_700_003_600_000,
      });
      // No `window` object means no reset time rather than a fabricated one.
      assert.equal(anthropic.windows[1]?.resetsAt, null);
      assert.equal(anthropic.windows[1]?.unit, "usd");

      const codex = snapshot.providers[1]!;
      assert.equal(codex.plan, "plus");
      assert.equal(codex.account, "acct-2");

      const ollama = snapshot.providers[2]!;
      assert.deepEqual(
        ollama.windows.map((quota) => quota.id),
        ["ollama-cloud:session", "ollama-cloud:weekly"],
      );
      assert.deepEqual(ollama.windows[0], {
        id: "ollama-cloud:session",
        label: "Session",
        unit: "percent",
        status: "ok",
        used: 4.6,
        limit: 100,
        remaining: 95.4,
        usedFraction: 0.046,
        resetsAt: null,
      });
      assert.equal(ollama.windows[1]?.used, 5.1);
      assert.deepEqual(ollama.notes, ["Ollama's usage endpoint does not expose reset times."]);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("limits reading warns and keeps the previous snapshot on bad output", async () => {
  await withBinary("#!/bin/sh\necho 'not json'\n", async () => {
    const { snapshot, warning } = await readProviderLimits();
    assert.equal(snapshot, null);
    assert.ok(warning);
    assert.match(warning, /did not return JSON/);
    assert.match(warning, /Kept the previous limits/);
  });

  await withBinary("#!/bin/sh\necho '{\"generatedAt\":1}'\n", async () => {
    const { snapshot, warning } = await readProviderLimits();
    assert.equal(snapshot, null);
    assert.ok(warning);
    assert.match(warning, /unexpected shape/);
  });
});
