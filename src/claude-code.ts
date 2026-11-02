import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import type { Env } from "./config.js";

/** The name the server is registered under in Claude Code. */
export const SERVER_NAME = "spacemail";

// Overridable so the setup flow can be tested without touching the real Keychain or Claude config.
const KEYCHAIN_SERVICE = process.env.SPACEMAIL_KEYCHAIN_SERVICE || "spacemail-mcp";
const CLAUDE_CONFIG = process.env.SPACEMAIL_SETUP_CLAUDE_CONFIG || join(homedir(), ".claude.json");

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

/** The settings Claude Code currently has for this server (user scope), if any. */
export function readClaudeCodeEnv(): Env | undefined {
  try {
    const config = JSON.parse(readFileSync(CLAUDE_CONFIG, "utf8"));
    const server = config?.mcpServers?.[SERVER_NAME];
    return server ? { ...(server.env ?? {}) } : undefined;
  } catch {
    return undefined;
  }
}

/** Finds the `claude` command on PATH (or a few usual install places). */
export function findClaudeCli(): string | undefined {
  if (process.env.SPACEMAIL_SETUP_CLAUDE_BIN) return process.env.SPACEMAIL_SETUP_CLAUDE_BIN;
  const names = process.platform === "win32" ? ["claude.cmd", "claude.exe", "claude"] : ["claude"];
  const dirs = [...(process.env.PATH ?? "").split(delimiter), join(homedir(), ".local", "bin"), join(homedir(), ".claude", "local")];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (dir && existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * How Claude Code should start the server. When setup was launched with npx, use npx too
 * (so people get updates); when it was run from a local copy, point at that copy.
 */
export function launchCommand(): string[] {
  const script = process.argv[1] ?? "";
  const viaNpx = process.env.npm_command === "exec" || /[\\/]_npx[\\/]/.test(script);
  if (viaNpx) return ["npx", "-y", "spacemail-mcp@latest"];
  return [process.execPath, resolve(script)];
}

/** Registers (or re-registers) the server for all of the user's Claude Code projects. */
export function registerWithClaudeCode(cli: string, env: Record<string, string>, command: string[]): void {
  try {
    execFileSync(cli, ["mcp", "remove", SERVER_NAME, "-s", "user"], { stdio: "ignore" });
  } catch {
    // Not registered yet.
  }
  const envArgs = Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  execFileSync(cli, ["mcp", "add", SERVER_NAME, "-s", "user", ...envArgs, "--", ...command], {
    stdio: ["ignore", "ignore", "pipe"],
  });
}

// ---------------------------------------------------------------------------
// macOS Keychain
// ---------------------------------------------------------------------------

export const keychainAvailable = process.platform === "darwin";

/** The command the server runs at start-up to read a password back from the Keychain. */
export function keychainCommand(email: string): string {
  return `security find-generic-password -s ${KEYCHAIN_SERVICE} -a '${email}' -w`;
}

export function isOurKeychainCommand(command: string | undefined, email: string): boolean {
  return command === keychainCommand(email);
}

export function saveToKeychain(email: string, password: string): void {
  // -U updates an existing item. The password is passed as an argument (no shell involved);
  // it is only visible to this user's own processes for the moment the command runs.
  execFileSync("security", ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", email, "-l", `Spacemail (${email})`, "-w", password], {
    stdio: "ignore",
  });
}

export function deleteFromKeychain(email: string): void {
  try {
    execFileSync("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", email], { stdio: "ignore" });
  } catch {
    // Already gone.
  }
}
