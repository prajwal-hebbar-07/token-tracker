import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { syncOmpSessions } from "../src/omp-sync.js";

function withBinary(contents: string | null, run: () => void): void {
  const previous = process.env.OMP_BIN;
  const directory = mkdtempSync(join(tmpdir(), "omp-sync-"));
  const binary = join(directory, "omp");
  if (contents !== null) {
    writeFileSync(binary, contents);
    chmodSync(binary, 0o755);
  }
  process.env.OMP_BIN = binary;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env.OMP_BIN;
    else process.env.OMP_BIN = previous;
    rmSync(directory, { force: true, recursive: true });
  }
}

test("reports the synced command when omp exits cleanly", () => {
  withBinary("#!/bin/sh\necho '{}'\n", () => {
    const result = syncOmpSessions();
    assert.equal(result.warning, null);
    assert.ok(result.command.endsWith("omp stats --json"));
    assert.ok(result.durationMs >= 0);
  });
});

test("warns instead of throwing when the omp binary is missing", () => {
  withBinary(null, () => {
    const result = syncOmpSessions();
    assert.ok(result.warning);
    assert.match(result.warning, /OMP_BIN/);
    assert.match(result.warning, /stale/);
  });
});

test("warns with the failing exit code and stderr detail", () => {
  withBinary("#!/bin/sh\necho 'stats database is locked' >&2\nexit 3\n", () => {
    const result = syncOmpSessions();
    assert.ok(result.warning);
    assert.match(result.warning, /exit code 3/);
    assert.match(result.warning, /stats database is locked/);
  });
});
