import { confirm, input, password as passwordPrompt, select } from "@inquirer/prompts";
import {
  defaultLabel,
  readBool,
  readMailboxEntries,
  readServerSettings,
  type Env,
  type MailboxEntry,
  type ServerSettings,
} from "./config.js";
import {
  deleteFromKeychain,
  findClaudeCli,
  isOurKeychainCommand,
  keychainAvailable,
  keychainCommand,
  launchCommand,
  readClaudeCodeEnv,
  registerWithClaudeCode,
  saveToKeychain,
  SERVER_NAME,
} from "./claude-code.js";
import { FriendlyError, inboxStatus, withImap } from "./mail.js";

const DESKTOP_DOWNLOAD = "https://github.com/evilash182/spacemail-mcp/releases/latest/download/spacemail.mcpb";
const MAILBOX_KEY = /^SPACEMAIL_(\d+_)?(EMAIL|USER|PASSWORD|PASSWORD_COMMAND|LABEL|NAME)$/;

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code: number) => (text: string) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = paint(1);
const dim = paint(2);
const red = paint(31);
const green = paint(32);
const yellow = paint(33);
const cyan = paint(36);

const say = (text = "") => process.stdout.write(`${text}\n`);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface Mailbox extends MailboxEntry {
  /** Typed during this setup run; saved to the Keychain (or config) when the user finishes. */
  newPassword?: string;
}

interface State {
  mailboxes: Mailbox[];
  allowSend: boolean;
  /** Other SPACEMAIL_* settings already in the config (hosts, SAVE_SENT…), kept as they are. */
  extras: Record<string, string>;
  /** Mailboxes removed during this run whose Keychain items should be deleted on save. */
  removed: Mailbox[];
  changed: boolean;
}

function describe(m: Mailbox): string {
  const label = m.label ?? defaultLabel(m.email);
  const sender = m.senderName && m.senderName !== label ? dim(` · sends as "${m.senderName}"`) : "";
  return `${label} ${dim(`<${m.email}>`)}${sender}`;
}

const EMAIL_PATTERN = /^[^\s@'"`$\\]+@[^\s@'"`$\\]+\.[^\s@'"`$\\]+$/;

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

async function checkLogin(email: string, password: string, server: ServerSettings): Promise<boolean> {
  process.stdout.write(dim("  Checking… "));
  try {
    const account = { id: "setup", label: email, email, password };
    const status = await withImap(account, server, inboxStatus);
    say(green(`✓ Connected: ${status.messages} messages, ${status.unseen} unread.`));
    return true;
  } catch (err) {
    say(red("✗"));
    say(red(`  ${err instanceof FriendlyError ? err.message : (err as Error).message}`));
    return false;
  }
}

/** Asks for a password until it logs in, or the user gives up. Returns undefined to skip. */
async function askWorkingPassword(email: string, server: ServerSettings): Promise<string | "change-email" | undefined> {
  for (;;) {
    const password = await passwordPrompt({
      message: `Mailbox password for ${email}:`,
      mask: "•",
      validate: (v) => (v ? true : "Please enter the mailbox password."),
    });
    if (await checkLogin(email, password, server)) return password;

    const next = await select({
      message: "What would you like to do?",
      choices: [
        { name: "Try the password again", value: "retry" },
        { name: "Use a different email address", value: "change-email" },
        { name: "Skip this mailbox", value: "skip" },
      ],
    });
    if (next === "change-email") return "change-email";
    if (next === "skip") return undefined;
  }
}

async function addMailbox(state: State, server: ServerSettings): Promise<boolean> {
  if (state.mailboxes.length === 0) {
    say(dim("  Use the mailbox password: the one you use for Spacemail webmail,"));
    say(dim("  not your Spaceship account password."));
    say();
  }

  for (;;) {
    const email = (
      await input({
        message: "Spacemail address:",
        validate: (v) => {
          const value = v.trim();
          if (!EMAIL_PATTERN.test(value)) return "That doesn't look like an email address.";
          if (state.mailboxes.some((m) => m.email.toLowerCase() === value.toLowerCase())) return "That mailbox is already set up.";
          return true;
        },
      })
    ).trim();

    const password = await askWorkingPassword(email, server);
    if (password === "change-email") continue;
    if (password === undefined) return false;

    const label = (
      await input({ message: "Nickname (what you'll call it when talking to Claude):", default: defaultLabel(email) })
    ).trim();
    const senderName = (await input({ message: "Sender name people see on your emails:", default: label })).trim();

    state.mailboxes.push({ email, label: label || undefined, senderName: senderName || undefined, newPassword: password });
    state.changed = true;
    say(green(`  ✓ Added ${label || email}.`));
    say();
    return true;
  }
}

async function askSending(current: boolean): Promise<boolean> {
  say();
  say(dim("  By default Claude saves replies as drafts for you to check and send yourself."));
  return confirm({ message: "Allow Claude to send emails directly when you ask it to?", default: current });
}

async function pickMailbox(state: State, message: string): Promise<Mailbox> {
  return select({ message, choices: state.mailboxes.map((m) => ({ name: describe(m), value: m })) });
}

async function manage(state: State, server: ServerSettings): Promise<"save" | "quit"> {
  for (;;) {
    say();
    say(bold("Your mailboxes:"));
    if (state.mailboxes.length === 0) say(dim("  (none)"));
    for (const m of state.mailboxes) say(`  • ${describe(m)}`);
    say(`  Sending: ${state.allowSend ? yellow("on") : "off (drafts only)"}`);
    say();

    const hasMailboxes = state.mailboxes.length > 0;
    const action = await select({
      message: "What would you like to do?",
      choices: [
        { name: "Add a mailbox", value: "add" },
        { name: "Change a mailbox's password", value: "password", disabled: !hasMailboxes },
        { name: "Rename a mailbox or change its sender name", value: "rename", disabled: !hasMailboxes },
        { name: "Remove a mailbox", value: "remove", disabled: !hasMailboxes },
        { name: state.allowSend ? "Turn sending off (drafts only)" : "Turn sending on", value: "send" },
        { name: state.changed ? "Save and finish" : "Finish", value: "save" },
        { name: "Quit without saving", value: "quit" },
      ],
    });

    if (action === "save" || action === "quit") return action;
    if (action === "add") await addMailbox(state, server);
    if (action === "send") {
      state.allowSend = !state.allowSend;
      state.changed = true;
    }
    if (action === "password") {
      const m = await pickMailbox(state, "Which mailbox?");
      const password = await askWorkingPassword(m.email, server);
      if (typeof password === "string" && password !== "change-email") {
        m.newPassword = password;
        state.changed = true;
      }
    }
    if (action === "rename") {
      const m = await pickMailbox(state, "Which mailbox?");
      m.label = (await input({ message: "Nickname:", default: m.label ?? defaultLabel(m.email) })).trim() || undefined;
      m.senderName = (await input({ message: "Sender name:", default: m.senderName ?? m.label ?? "" })).trim() || undefined;
      state.changed = true;
    }
    if (action === "remove") {
      const m = await pickMailbox(state, "Which mailbox should Claude stop using?");
      if (await confirm({ message: `Remove ${m.email}? (This doesn't touch the mailbox itself.)`, default: false })) {
        state.mailboxes = state.mailboxes.filter((x) => x !== m);
        state.removed.push(m);
        state.changed = true;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

function buildEnv(state: State): Record<string, string> {
  const env: Record<string, string> = { ...state.extras };
  state.mailboxes.forEach((m, index) => {
    const prefix = `SPACEMAIL_${index + 1}_`;
    env[`${prefix}EMAIL`] = m.email;
    if (m.passwordCommand) env[`${prefix}PASSWORD_COMMAND`] = m.passwordCommand;
    else if (m.password) env[`${prefix}PASSWORD`] = m.password;
    if (m.label) env[`${prefix}LABEL`] = m.label;
    if (m.senderName) env[`${prefix}NAME`] = m.senderName;
  });
  if (state.allowSend) env.SPACEMAIL_ALLOW_SEND = "true";
  return env;
}

function storePasswords(state: State): void {
  for (const m of state.mailboxes) {
    if (!m.newPassword) continue;
    if (keychainAvailable) {
      saveToKeychain(m.email, m.newPassword);
      m.passwordCommand = keychainCommand(m.email);
      m.password = undefined;
    } else {
      m.password = m.newPassword;
      m.passwordCommand = undefined;
    }
    m.newPassword = undefined;
  }
  for (const m of state.removed) {
    if (keychainAvailable && isOurKeychainCommand(m.passwordCommand, m.email)) deleteFromKeychain(m.email);
  }
}

function printManualConfig(env: Record<string, string>, command: string[]): void {
  const [cmd, ...args] = command;
  const config = { mcpServers: { [SERVER_NAME]: { command: cmd, args, env } } };
  say(yellow("Couldn't find the `claude` command, so here's the configuration to add by hand"));
  say(yellow("(Claude Code: ~/.claude.json, Cursor: ~/.cursor/mcp.json, or your app's MCP settings):"));
  say();
  say(JSON.stringify(config, null, 2));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runSetup(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    say("Setup asks you questions, so it needs to run in a terminal window:");
    say("  npx -y spacemail-mcp setup");
    process.exitCode = 1;
    return;
  }

  say();
  say(bold(cyan("  Spacemail for Claude: setup")));
  say(dim("  by Norwich Website Design · https://norwichwebsite.design"));
  say();
  say(dim(`  Using Claude Desktop? The one-click extension is easier: ${DESKTOP_DOWNLOAD}`));
  say();

  const existing: Env = readClaudeCodeEnv() ?? {};
  const state: State = {
    mailboxes: readMailboxEntries(existing),
    allowSend: readBool(existing, "SPACEMAIL_ALLOW_SEND", false),
    extras: Object.fromEntries(
      Object.entries(existing).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === "string" && !MAILBOX_KEY.test(entry[0]) && entry[0] !== "SPACEMAIL_ALLOW_SEND",
      ),
    ),
    removed: [],
    changed: false,
  };
  // Test logins against the same servers the saved settings (or this shell) point at.
  const server = readServerSettings({ ...existing, ...process.env });

  try {
    if (state.mailboxes.length === 0) {
      while (!(await addMailbox(state, server))) {
        if (!(await confirm({ message: "Try adding a mailbox again?", default: true }))) {
          say("No mailboxes added, so nothing was saved.");
          return;
        }
      }
      while (await confirm({ message: "Would you like to add another mailbox?", default: false })) {
        await addMailbox(state, server);
      }
      state.allowSend = await askSending(false);
    } else if ((await manage(state, server)) === "quit") {
      say("Nothing was changed.");
      return;
    }
  } catch (err) {
    if (err instanceof Error && err.name === "ExitPromptError") {
      say();
      say("Setup cancelled. Nothing was changed.");
      process.exitCode = 130;
      return;
    }
    throw err;
  }

  if (!state.changed) {
    say("Nothing was changed.");
    return;
  }

  storePasswords(state);
  const env = buildEnv(state);
  const command = launchCommand();
  const cli = findClaudeCli();

  say();
  if (cli) {
    try {
      registerWithClaudeCode(cli, env, command);
    } catch (err) {
      const stderr = String((err as { stderr?: Buffer }).stderr ?? "").trim();
      say(red(`Claude Code didn't accept the settings: ${stderr || (err as Error).message}`));
      printManualConfig(env, command);
      process.exitCode = 1;
      return;
    }
    say(green(bold(`✓ Saved. Spacemail is set up in Claude Code for all your projects.`)));
  } else {
    printManualConfig(env, command);
  }

  for (const m of state.mailboxes) say(`  • ${describe(m)}`);
  say(`  Sending: ${state.allowSend ? "on" : "off (Claude saves drafts for you to send)"}`);
  if (state.mailboxes.some((m) => m.passwordCommand)) say(dim("  Passwords are stored in your Mac's Keychain, not in any config file."));
  else if (state.mailboxes.some((m) => m.password)) say(yellow("  Note: passwords are saved in Claude Code's settings file on this computer."));
  say();
  if (cli) {
    say(`Next: start a new Claude Code session and ask ${bold('"Anything new in my inbox today?"')}`);
  }
  say(dim("Run `npx spacemail-mcp setup` again any time to add or change mailboxes."));
  say();
}
