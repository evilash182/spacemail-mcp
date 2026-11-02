import { execSync } from "node:child_process";

/**
 * Reads mailbox settings from environment variables.
 *
 * One mailbox:   SPACEMAIL_EMAIL, SPACEMAIL_PASSWORD, SPACEMAIL_LABEL, SPACEMAIL_NAME
 * Many mailboxes: SPACEMAIL_1_EMAIL, SPACEMAIL_1_PASSWORD, SPACEMAIL_1_LABEL, ... up to SPACEMAIL_20_*
 * Any PASSWORD can be replaced by PASSWORD_COMMAND, a command that prints the password.
 */

export const MAX_ACCOUNTS = 20;

export interface Account {
  /** Short lowercase handle, e.g. "boxcart". */
  id: string;
  /** Friendly name shown to Claude and the user, e.g. "BoxCart". */
  label: string;
  email: string;
  password: string;
  /** Display name used in the From header, e.g. "BoxCart Support". */
  senderName?: string;
}

export interface ServerSettings {
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  /** Plain-text connections, only for local testing. */
  insecure: boolean;
}

export interface Config {
  accounts: Account[];
  server: ServerSettings;
  allowSend: boolean;
  saveSent: boolean;
  /** Problems found while reading the settings, reported to the user instead of crashing. */
  warnings: string[];
}

export type Env = Record<string, string | undefined>;

/** Treats blanks and unfilled template placeholders (e.g. "${user_config.x}") as unset. */
function read(env: Env, key: string): string | undefined {
  const value = env[key]?.trim();
  if (!value || value.startsWith("${")) return undefined;
  return value;
}

export function readBool(env: Env, key: string, fallback: boolean): boolean {
  const value = read(env, key)?.toLowerCase();
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value);
}

function readPort(env: Env, key: string, fallback: number, warnings: string[]): number {
  const value = read(env, key);
  if (value === undefined) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    warnings.push(`${key} is "${value}", which is not a valid port. Using ${fallback}.`);
    return fallback;
  }
  return port;
}

/**
 * Runs a command such as `security find-generic-password -s spacemail-mcp -a me@x.com -w`
 * and uses its output as the password, so passwords can live in the system keychain or a
 * password manager instead of a config file.
 */
function runPasswordCommand(command: string): string {
  let output: string;
  try {
    output = execSync(command, { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    const stderr = String((err as { stderr?: string }).stderr ?? "").trim();
    if (/could not be found in the keychain/i.test(stderr)) throw new Error("no matching item in the Keychain");
    throw new Error(stderr.split("\n")[0] || "the command failed");
  }
  const password = output.replace(/\r?\n$/, "");
  if (!password) throw new Error("the command printed nothing");
  return password;
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function defaultLabel(email: string): string {
  const domain = email.split("@")[1] ?? email;
  const name = domain.split(".")[0] ?? domain;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function readServerSettings(env: Env, warnings: string[] = []): ServerSettings {
  return {
    imapHost: read(env, "SPACEMAIL_IMAP_HOST") ?? "mail.spacemail.com",
    imapPort: readPort(env, "SPACEMAIL_IMAP_PORT", 993, warnings),
    smtpHost: read(env, "SPACEMAIL_SMTP_HOST") ?? "mail.spacemail.com",
    smtpPort: readPort(env, "SPACEMAIL_SMTP_PORT", 465, warnings),
    insecure: readBool(env, "SPACEMAIL_INSECURE_PLAINTEXT", false),
  };
}

/** A mailbox as written in the settings, before its password has been looked up. */
export interface MailboxEntry {
  email: string;
  password?: string;
  passwordCommand?: string;
  label?: string;
  senderName?: string;
}

/**
 * Lists the mailboxes in the settings in order, without running any password commands,
 * so setup can show what's configured without touching the keychain.
 */
export function readMailboxEntries(env: Env, warnings: string[] = []): MailboxEntry[] {
  const entries: MailboxEntry[] = [];
  const prefixes = ["SPACEMAIL_"];
  for (let i = 1; i <= MAX_ACCOUNTS; i++) prefixes.push(`SPACEMAIL_${i}_`);

  for (const prefix of prefixes) {
    const email = read(env, `${prefix}EMAIL`) ?? read(env, `${prefix}USER`);
    const password = read(env, `${prefix}PASSWORD`);
    const passwordCommand = read(env, `${prefix}PASSWORD_COMMAND`);
    if (!email && !password && !passwordCommand) continue;
    if (!email) {
      warnings.push(`${prefix}PASSWORD is set but ${prefix}EMAIL is missing, so that mailbox was skipped.`);
      continue;
    }
    if (!email.includes("@")) {
      warnings.push(`"${email}" doesn't look like an email address, so it was skipped.`);
      continue;
    }
    if (entries.some((e) => e.email.toLowerCase() === email.toLowerCase())) {
      warnings.push(`${email} is configured twice; only the first one is used.`);
      continue;
    }
    entries.push({
      email,
      password,
      passwordCommand,
      label: read(env, `${prefix}LABEL`),
      senderName: read(env, `${prefix}NAME`),
    });
  }
  return entries;
}

export function loadConfig(env: Env = process.env): Config {
  const warnings: string[] = [];
  const accounts: Account[] = [];

  for (const entry of readMailboxEntries(env, warnings)) {
    let password = entry.password;
    if (!password && entry.passwordCommand) {
      try {
        password = runPasswordCommand(entry.passwordCommand);
      } catch (err) {
        warnings.push(`Couldn't get the password for ${entry.email} from its PASSWORD_COMMAND: ${(err as Error).message}`);
        continue;
      }
    }
    if (!password) {
      warnings.push(`${entry.email} has no password (PASSWORD or PASSWORD_COMMAND), so it was skipped.`);
      continue;
    }

    const label = entry.label ?? defaultLabel(entry.email);
    let id = slugify(label) || slugify(entry.email);
    // Two mailboxes on the same domain would otherwise share an id.
    if (accounts.some((a) => a.id === id)) id = slugify(entry.email);

    accounts.push({ id, label, email: entry.email, password, senderName: entry.senderName });
  }

  return {
    accounts,
    server: readServerSettings(env, warnings),
    allowSend: readBool(env, "SPACEMAIL_ALLOW_SEND", false),
    saveSent: readBool(env, "SPACEMAIL_SAVE_SENT", true),
    warnings,
  };
}
