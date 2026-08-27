import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { MCP_VERSION } from "./version.js";

export const SERVER_NAME = "token-tracker";

export interface InstallPaths {
  dest: string;
  mcpJson: string;
  skill: string;
  server: string;
}

export function installPaths(home = homedir()): InstallPaths {
  const dest = join(home, ".token-tracker", "mcp");
  return {
    dest,
    mcpJson: join(home, ".cursor", "mcp.json"),
    skill: join(home, ".cursor", "skills", SERVER_NAME, "SKILL.md"),
    server: join(dest, "server.js"),
  };
}

export function assertSupportedNode(version = process.versions.node): void {
  const [major = 0, minor = 0] = version.split(".").map((part) => Number(part));
  if (major < 22 || (major === 22 && minor < 5)) {
    throw new Error(`Token Tracker MCP needs Node.js 22.5 or later; this is ${version}.`);
  }
}

export function sourceLayout(source: string): { server: string; web: string; skill: string } {
  const server = join(source, "server.js");
  const web = join(source, "web", "index.html");
  const skill = join(source, "skill", "SKILL.md");
  if (!existsSync(server) || !existsSync(web) || !existsSync(skill)) {
    throw new Error(`This folder is not a Token Tracker MCP package (missing server.js, web/, or skill/).`);
  }
  return { server, web, skill };
}

export function upsertMcpServer(
  filePath: string,
  command: string,
  serverPath: string,
): Record<string, unknown> {
  let parsed: Record<string, unknown> = {};
  if (existsSync(filePath)) {
    const text = readFileSync(filePath, "utf8").trim();
    if (text.length > 0) {
      const value: unknown = JSON.parse(text);
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${filePath} is not a JSON object, so it was left unchanged.`);
      }
      parsed = value as Record<string, unknown>;
    }
  }
  const servers = asRecord(parsed.mcpServers) ?? {};
  servers[SERVER_NAME] = {
    type: "stdio",
    command,
    args: [serverPath],
  };
  parsed.mcpServers = servers;
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(parsed, null, 2)}\n`);
  return parsed;
}

export function removeMcpServer(filePath: string): void {
  if (!existsSync(filePath)) return;
  const text = readFileSync(filePath, "utf8").trim();
  if (text.length === 0) return;
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const parsed = value as Record<string, unknown>;
  const servers = asRecord(parsed.mcpServers);
  if (!servers || !(SERVER_NAME in servers)) return;
  delete servers[SERVER_NAME];
  parsed.mcpServers = servers;
  writeFileSync(filePath, `${JSON.stringify(parsed, null, 2)}\n`);
}

export function installFromPackage(source: string, home = homedir(), nodeCommand = process.execPath): InstallPaths {
  assertSupportedNode();
  const layout = sourceLayout(source);
  const paths = installPaths(home);
  mkdirSync(paths.dest, { recursive: true });
  cpSync(layout.server, paths.server);
  rmSync(join(paths.dest, "web"), { recursive: true, force: true });
  cpSync(join(source, "web"), join(paths.dest, "web"), { recursive: true });
  const installer = join(source, "install.js");
  if (existsSync(installer)) cpSync(installer, join(paths.dest, "install.js"));
  const pkg = join(source, "package.json");
  if (existsSync(pkg)) cpSync(pkg, join(paths.dest, "package.json"));
  mkdirSync(dirname(paths.skill), { recursive: true });
  cpSync(layout.skill, paths.skill);
  upsertMcpServer(paths.mcpJson, nodeCommand, paths.server);
  return paths;
}

export function uninstall(home = homedir()): InstallPaths {
  const paths = installPaths(home);
  rmSync(paths.dest, { recursive: true, force: true });
  rmSync(dirname(paths.skill), { recursive: true, force: true });
  removeMcpServer(paths.mcpJson);
  return paths;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function main(argv: string[]): void {
  const home = homedir();
  const source = dirname(process.argv[1] ?? ".");
  if (argv.includes("--uninstall")) {
    const paths = uninstall(home);
    process.stdout.write(`Token Tracker MCP removed from ${paths.dest}.\nReload MCP from Customize in Cursor.\n`);
    return;
  }
  const paths = installFromPackage(source, home);
  process.stdout.write(
    [
      `Token Tracker MCP ${MCP_VERSION} installed.`,
      `Files:  ${paths.dest}`,
      `Cursor: ${paths.mcpJson}`,
      "",
      "Reload MCP from Customize in Cursor, then ask: open the dashboard",
      "",
    ].join("\n"),
  );
}

const entry = process.argv[1];
if (entry) {
  try {
    if (import.meta.url === pathToFileURL(realpathSync(entry)).href) {
      try {
        main(process.argv.slice(2));
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Install failed";
        process.stderr.write(`${detail}\n`);
        process.exit(1);
      }
    }
  } catch {
    // argv[1] is not a real file (tests).
  }
}
