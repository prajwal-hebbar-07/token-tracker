import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const web = join(root, "dist", "web");
const skill = join(root, "..", "..", ".cursor", "skills", "token-tracker", "SKILL.md");
const packRoot = join(root, "pack");
const pack = join(packRoot, "token-tracker-mcp");
const zipPath = join(root, `Token-Tracker-${version}-mcp.zip`);

if (!existsSync(join(web, "index.html"))) {
  throw new Error("Dashboard bundle missing. Run `pnpm --filter @token-tracker/mcp build` first.");
}
if (!existsSync(skill)) {
  throw new Error(`Skill missing at ${skill}`);
}

rmSync(packRoot, { recursive: true, force: true });
mkdirSync(pack, { recursive: true });

await build({
  absWorkingDir: root,
  bundle: true,
  entryPoints: [join(root, "src", "server.ts")],
  outfile: join(pack, "server.js"),
  platform: "node",
  format: "esm",
  target: "node22",
});
await build({
  absWorkingDir: root,
  bundle: true,
  entryPoints: [join(root, "src", "install.ts")],
  outfile: join(pack, "install.js"),
  platform: "node",
  format: "esm",
  target: "node22",
});

chmodSync(join(pack, "server.js"), 0o755);
chmodSync(join(pack, "install.js"), 0o755);
cpSync(web, join(pack, "web"), { recursive: true });
mkdirSync(join(pack, "skill"));
cpSync(skill, join(pack, "skill", "SKILL.md"));
writeFileSync(
  join(pack, "package.json"),
  `${JSON.stringify({ name: "token-tracker-mcp", private: true, type: "module", version }, null, 2)}\n`,
);
writeFileSync(
  join(pack, "install.sh"),
  `#!/bin/sh
exec node "$(dirname "$0")/install.js" "$@"
`,
  { mode: 0o755 },
);
writeFileSync(
  join(pack, "README.txt"),
  `Token Tracker MCP ${version}

Requires Node.js 22.5 or later.

  unzip Token-Tracker-${version}-mcp.zip
  cd token-tracker-mcp
  node install.js

Then reload MCP from Customize in Cursor and ask: open the dashboard

Uninstall:

  node install.js --uninstall
`,
);

rmSync(zipPath, { force: true });
const zipped = spawnSync("zip", ["-r", zipPath, "token-tracker-mcp"], { cwd: packRoot, stdio: "inherit" });
if (zipped.status !== 0) {
  throw new Error("zip failed. Install zip or run this on macOS/Linux.");
}
process.stdout.write(`${zipPath}\n`);
