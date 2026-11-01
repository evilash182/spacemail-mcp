/**
 * Reads mailbox settings from environment variables.
 *
 * One mailbox:   SPACEMAIL_EMAIL, SPACEMAIL_PASSWORD, SPACEMAIL_LABEL, SPACEMAIL_NAME
 * Many mailboxes: SPACEMAIL_1_EMAIL, SPACEMAIL_1_PASSWORD, SPACEMAIL_1_LABEL, ... up to SPACEMAIL_20_*
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

type Env = Record<string, string | undefined>;

/** Treats blanks and unfilled template placeholders (e.g. "${user_config.x}") as unset. */
function read(env: Env, key: string): string | undefined {
  const value = env[key]?.trim();
  if (!value || value.startsWith("${")) return undefined;
  return value;
}

function readBool(env: Env, key: string, fallback: boolean): boolean {
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

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function defaultLabel(email: string): string {
  const domain = email.split("@")[1] ?? email;
  const name = domain.split(".")[0] ?? domain;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function loadConfig(env: Env = process.env): Config {
  const warnings: string[] = [];
  const accounts: Account[] = [];

  const prefixes = ["SPACEMAIL_"];
  for (let i = 1; i <= MAX_ACCOUNTS; i++) prefixes.push(`SPACEMAIL_${i}_`);

  for (const prefix of prefixes) {
    const email = read(env, `${prefix}EMAIL`) ?? read(env, `${prefix}USER`);
    const password = read(env, `${prefix}PASSWORD`);
    if (!email && !password) continue;
    if (!email) {
      warnings.push(`${prefix}PASSWORD is set but ${prefix}EMAIL is missing, so that mailbox was skipped.`);
      continue;
    }
    if (!password) {
      warnings.push(`${email} has no password (${prefix}PASSWORD), so it was skipped.`);
      continue;
    }
    if (!email.includes("@")) {
      warnings.push(`"${email}" doesn't look like an email address, so it was skipped.`);
      continue;
    }

    const label = read(env, `${prefix}LABEL`) ?? defaultLabel(email);
    let id = slugify(label) || slugify(email);
    // Two mailboxes on the same domain would otherwise share an id.
    if (accounts.some((a) => a.id === id)) id = slugify(email);

    if (accounts.some((a) => a.email.toLowerCase() === email.toLowerCase())) {
      warnings.push(`${email} is configured twice; only the first one is used.`);
      continue;
    }

    accounts.push({ id, label, email, password, senderName: read(env, `${prefix}NAME`) });
  }

  const server: ServerSettings = {
    imapHost: read(env, "SPACEMAIL_IMAP_HOST") ?? "mail.spacemail.com",
    imapPort: readPort(env, "SPACEMAIL_IMAP_PORT", 993, warnings),
    smtpHost: read(env, "SPACEMAIL_SMTP_HOST") ?? "mail.spacemail.com",
    smtpPort: readPort(env, "SPACEMAIL_SMTP_PORT", 465, warnings),
    insecure: readBool(env, "SPACEMAIL_INSECURE_PLAINTEXT", false),
  };

  return {
    accounts,
    server,
    allowSend: readBool(env, "SPACEMAIL_ALLOW_SEND", false),
    saveSent: readBool(env, "SPACEMAIL_SAVE_SENT", true),
    warnings,
  };
}
