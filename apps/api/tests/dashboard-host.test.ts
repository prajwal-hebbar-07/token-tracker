import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startDashboard } from "../src/dashboard-host.js";

test("serves the dashboard shell and health from one origin", async () => {
  const directory = mkdtempSync(join(tmpdir(), "token-tracker-host-"));
  writeFileSync(join(directory, "index.html"), "<!doctype html><title>Token Tracker</title>");
  const dashboard = await startDashboard(directory, join(directory, "tracker.sqlite"));
  try {
    const origin = `http://127.0.0.1:${dashboard.port}`;
    const page = await fetch(origin);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Token Tracker/);
    const health = await fetch(`${origin}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);
  } finally {
    dashboard.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
