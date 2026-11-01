import { ImapFlow, type ListResponse } from "imapflow";
import MailComposer from "nodemailer/lib/mail-composer";
import nodemailer from "nodemailer";
import type { Account, ServerSettings } from "./config.js";

/** An error whose message is written for the person using Claude, not a developer. */
export class FriendlyError extends Error {}

const CONNECT_TIMEOUT_MS = 20_000;

export async function withImap<T>(
  account: Account,
  server: ServerSettings,
  work: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  const client = new ImapFlow({
    host: server.imapHost,
    port: server.imapPort,
    secure: !server.insecure,
    doSTARTTLS: server.insecure ? false : undefined,
    auth: { user: account.email, pass: account.password },
    logger: false,
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
    socketTimeout: 60_000,
  });
  // A dropped socket emits 'error'; without a listener Node would crash the server.
  client.on("error", () => {});

  try {
    await client.connect();
  } catch (err) {
    throw explainConnectionError(err, account, server);
  }

  try {
    return await work(client);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

export function explainConnectionError(err: unknown, account: Account, server: ServerSettings): FriendlyError {
  const e = err as { authenticationFailed?: boolean; code?: string; responseText?: string; message?: string };
  const where = `${account.label} (${account.email})`;

  if (e.authenticationFailed || /auth|login|credentials/i.test(e.responseText ?? "")) {
    return new FriendlyError(
      `Spacemail rejected the email address or password for ${where}. ` +
        `Check the password is the mailbox password (not your Spaceship account password), ` +
        `and that IMAP/SMTP access is switched on in Spacemail Manager.`,
    );
  }
  if (e.code === "ENOTFOUND" || e.code === "EAI_AGAIN") {
    return new FriendlyError(`Couldn't reach ${server.imapHost}. Check this computer is online.`);
  }
  if (e.code === "ETIMEDOUT" || e.code === "ECONNREFUSED" || e.code === "ECONNRESET") {
    return new FriendlyError(
      `Couldn't connect to ${server.imapHost}:${server.imapPort} for ${where} (${e.code}). ` +
        `A firewall or VPN may be blocking email ports, or Spacemail may be briefly unavailable.`,
    );
  }
  return new FriendlyError(`Couldn't open ${where}: ${e.responseText || e.message || String(err)}`);
}

export async function inboxStatus(client: ImapFlow): Promise<{ messages: number; unseen: number }> {
  const status = await client.status("INBOX", { messages: true, unseen: true });
  return { messages: status ? (status.messages ?? 0) : 0, unseen: status ? (status.unseen ?? 0) : 0 };
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

/** Friendly folder words, mapped to IMAP special-use flags and common folder names. */
const FOLDER_ALIASES: Record<string, { specialUse?: string; names: string[] }> = {
  inbox: { names: ["INBOX"] },
  sent: { specialUse: "\\Sent", names: ["Sent", "Sent Items", "Sent Messages", "Sent Mail"] },
  drafts: { specialUse: "\\Drafts", names: ["Drafts", "Draft"] },
  trash: { specialUse: "\\Trash", names: ["Trash", "Deleted", "Deleted Items", "Bin"] },
  spam: { specialUse: "\\Junk", names: ["Junk", "Spam", "Junk E-mail", "Junk Email"] },
  junk: { specialUse: "\\Junk", names: ["Junk", "Spam", "Junk E-mail", "Junk Email"] },
  archive: { specialUse: "\\Archive", names: ["Archive", "Archives"] },
};

export function describeFolder(box: ListResponse): string {
  const special = box.specialUse && box.specialUse !== "\\Inbox" ? ` (${box.specialUse.replace("\\", "").toLowerCase()})` : "";
  return `${box.path}${special}`;
}

/**
 * Turns "inbox", "sent", "Trash", "Clients/Acme" etc. into the real folder path on the server.
 * Throws a FriendlyError listing the available folders when nothing matches.
 */
export async function resolveFolder(client: ImapFlow, requested: string | undefined): Promise<string> {
  const wanted = (requested ?? "inbox").trim();
  if (wanted.toUpperCase() === "INBOX") return "INBOX";

  const boxes = (await client.list()).filter((b) => !b.flags.has("\\Noselect"));
  const exact = boxes.find((b) => b.path === wanted);
  if (exact) return exact.path;

  const lower = wanted.toLowerCase();
  const alias = FOLDER_ALIASES[lower];
  if (alias?.specialUse) {
    const bySpecial = boxes.find((b) => b.specialUse === alias.specialUse);
    if (bySpecial) return bySpecial.path;
  }
  const candidates = [lower, ...(alias?.names ?? []).map((n) => n.toLowerCase())];
  const byName =
    boxes.find((b) => candidates.includes(b.path.toLowerCase())) ??
    boxes.find((b) => candidates.includes(b.name.toLowerCase()));
  if (byName) return byName.path;

  throw new FriendlyError(
    `There's no folder called "${wanted}". Available folders: ${boxes.map(describeFolder).join(", ")}.`,
  );
}

/** Like resolveFolder, but creates the folder when a well-known one (e.g. Drafts) is missing. */
export async function resolveOrCreateFolder(client: ImapFlow, alias: "drafts" | "sent"): Promise<string> {
  try {
    return await resolveFolder(client, alias);
  } catch (err) {
    if (!(err instanceof FriendlyError)) throw err;
    const name = alias === "drafts" ? "Drafts" : "Sent";
    await client.mailboxCreate(name);
    return name;
  }
}

// ---------------------------------------------------------------------------
// Composing and sending
// ---------------------------------------------------------------------------

export interface Outgoing {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
}

export function fromAddress(account: Account): { name: string; address: string } | string {
  return account.senderName ? { name: account.senderName, address: account.email } : account.email;
}

export function domainOf(email: string): string {
  return email.split("@")[1] ?? "spacemail.local";
}

/** Builds a complete RFC 5322 message, ready to save as a draft or send. */
export async function composeMessage(account: Account, message: Outgoing, options: { keepBcc: boolean }): Promise<Buffer> {
  const composer = new MailComposer({
    from: fromAddress(account),
    to: message.to,
    cc: message.cc?.length ? message.cc : undefined,
    bcc: message.bcc?.length ? message.bcc : undefined,
    subject: message.subject,
    text: message.text,
    html: message.html,
    inReplyTo: message.inReplyTo,
    references: message.references?.length ? message.references : undefined,
    date: new Date(),
    messageId: `<${crypto.randomUUID()}@${domainOf(account.email)}>`,
  });
  const node = composer.compile();
  // Drafts keep Bcc so it survives until the user presses send; sent mail must not expose it.
  node.keepBcc = options.keepBcc;
  return node.build();
}

export async function sendMessage(account: Account, server: ServerSettings, raw: Buffer, envelope: { from: string; to: string[] }): Promise<string> {
  const transport = nodemailer.createTransport({
    host: server.smtpHost,
    port: server.smtpPort,
    secure: !server.insecure,
    ignoreTLS: server.insecure,
    auth: { user: account.email, pass: account.password },
    connectionTimeout: CONNECT_TIMEOUT_MS,
  });
  try {
    const info = await transport.sendMail({ envelope, raw });
    return info.messageId ?? "";
  } catch (err) {
    const e = err as { code?: string; responseCode?: number; response?: string; message?: string };
    if (e.code === "EAUTH" || e.responseCode === 535) {
      throw new FriendlyError(
        `Spacemail's outgoing server rejected the password for ${account.email}. ` +
          `Check the mailbox password and that SMTP access is enabled in Spacemail Manager.`,
      );
    }
    throw new FriendlyError(`Sending failed: ${e.response || e.message || String(err)}`);
  } finally {
    transport.close();
  }
}
