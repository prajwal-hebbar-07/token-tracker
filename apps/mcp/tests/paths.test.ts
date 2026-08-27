import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { resolveTrackerDatabasePath } from "../src/paths.js";

test("DATA_DIR overrides the default tracker database location", () => {
  const previous = process.env.DATA_DIR;
  process.env.DATA_DIR = "/tmp/token-tracker-mcp-data";
  try {
    assert.equal(
      resolveTrackerDatabasePath(),
      resolve("/tmp/token-tracker-mcp-data", "token-tracker.sqlite"),
    );
  } finally {
    if (previous === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previous;
  }
});
