import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Prefers the desktop app's database when one already exists, so the agent and
 * the window report the same numbers. Otherwise keeps a file under
 * `~/.token-tracker` that does not need that app installed.
 */
export function resolveTrackerDatabasePath(): string {
  if (process.env.DATA_DIR) {
    return resolve(process.env.DATA_DIR, "token-tracker.sqlite");
  }
  const home = homedir();
  const desktop = join(
    home,
    "Library",
    "Application Support",
    "com.tokentracker.desktop",
    "token-tracker.sqlite",
  );
  if (existsSync(desktop)) return desktop;
  return join(home, ".token-tracker", "token-tracker.sqlite");
}
