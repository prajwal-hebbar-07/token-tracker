import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertSupportedNode,
  installFromPackage,
  uninstall,
  upsertMcpServer,
} from "../src/install.js";

test("rejects Node versions below 22.5", () => {
  assert.throws(() => assertSupportedNode("22.4.0"), /22\.5/);
  assert.doesNotThrow(() => assertSupportedNode("22.5.0"));
  assert.doesNotThrow(() => assertSupportedNode("24.18.0"));
});

test("install copies the package and merges Cursor MCP config", () => {
  const home = mkdtempSync(join(tmpdir(), "token-tracker-home-"));
  const source = mkdtempSync(join(tmpdir(), "token-tracker-pack-"));
  mkdirSync(join(source, "web"));
  mkdirSync(join(source, "skill"));
  writeFileSync(join(source, "server.js"), "export {}\n");
  writeFileSync(join(source, "install.js"), "export {}\n");
  writeFileSync(join(source, "package.json"), `${JSON.stringify({ type: "module" })}\n`);
  writeFileSync(join(source, "web", "index.html"), "<!doctype html>");
  writeFileSync(join(source, "skill", "SKILL.md"), "# Token Tracker\n");
  mkdirSync(join(home, ".cursor"));
  writeFileSync(
    join(home, ".cursor", "mcp.json"),
    `${JSON.stringify({ mcpServers: { paper: { command: "keep-me" } } }, null, 2)}\n`,
  );

  try {
    const paths = installFromPackage(source, home, "/usr/local/bin/node");
    assert.equal(readFileSync(paths.server, "utf8"), "export {}\n");
    assert.equal(readFileSync(join(paths.dest, "install.js"), "utf8"), "export {}\n");
    assert.match(readFileSync(join(paths.dest, "package.json"), "utf8"), /"type":"module"/);
    assert.equal(readFileSync(join(paths.dest, "web", "index.html"), "utf8"), "<!doctype html>");
    assert.match(readFileSync(paths.skill, "utf8"), /Token Tracker/);
    const config = JSON.parse(readFileSync(paths.mcpJson, "utf8")) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    assert.equal(config.mcpServers.paper.command, "keep-me");
    assert.equal(config.mcpServers["token-tracker"]?.command, "/usr/local/bin/node");
    assert.deepEqual(config.mcpServers["token-tracker"]?.args, [paths.server]);

    uninstall(home);
    const after = JSON.parse(readFileSync(paths.mcpJson, "utf8")) as { mcpServers: Record<string, { command: string }> };
    assert.equal(after.mcpServers["token-tracker"], undefined);
    assert.equal(after.mcpServers.paper.command, "keep-me");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  }
});

test("upsertMcpServer creates a config file when none exists", () => {
  const directory = mkdtempSync(join(tmpdir(), "token-tracker-mcp-json-"));
  const filePath = join(directory, "mcp.json");
  try {
    upsertMcpServer(filePath, "node", "/tmp/server.js");
    const config = JSON.parse(readFileSync(filePath, "utf8")) as { mcpServers: { "token-tracker": { type: string } } };
    assert.equal(config.mcpServers["token-tracker"].type, "stdio");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
