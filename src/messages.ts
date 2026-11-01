import type { ImapFlow, MessageStructureObject, SearchObject } from "imapflow";
import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
import { FriendlyError } from "./mail.js";

export interface MessageSummary {
  uid: number;
  date?: Date;
  from: string;
  to: string;
  subject: string;
  unread: boolean;
  flagged: boolean;
  answered: boolean;
  hasAttachments: boolean;
  size?: number;
  preview?: string;
}

export interface SearchFilters {
  unreadOnly?: boolean;
  flaggedOnly?: boolean;
  from?: string;
  to?: string;
  subject?: string;
  text?: string;
  since?: Date;
  before?: Date;
}

const PREVIEW_LENGTH = 220;

/** Accepts "today", "yesterday", "7d" (days ago) or any date string JavaScript understands. */
export function parseDate(input: string | undefined, field: string): Date | undefined {
  if (!input) return undefined;
  const value = input.trim().toLowerCase();
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  if (value === "today") return startOfToday;
  if (value === "yesterday") return new Date(startOfToday.getTime() - 86_400_000);
  const daysAgo = /^(\d+)\s*d(ays?)?$/.exec(value);
  if (daysAgo) return new Date(startOfToday.getTime() - Number(daysAgo[1]) * 86_400_000);

  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) {
    throw new FriendlyError(`"${input}" isn't a date I understand for ${field}. Try 2026-11-01, "today" or "7d".`);
  }
  return parsed;
}

function toSearchObject(filters: SearchFilters): SearchObject {
  const query: SearchObject = {};
  if (filters.unreadOnly) query.seen = false;
  if (filters.flaggedOnly) query.flagged = true;
  if (filters.from) query.from = filters.from;
  if (filters.to) query.to = filters.to;
  if (filters.subject) query.subject = filters.subject;
  if (filters.text) query.body = filters.text;
  if (filters.since) query.since = filters.since;
  if (filters.before) query.before = filters.before;
  if (Object.keys(query).length === 0) query.all = true;
  return query;
}

function formatAddressList(list: { name?: string; address?: string }[] | undefined): string {
  if (!list?.length) return "";
  return list.map((a) => (a.name ? `${a.name} <${a.address}>` : (a.address ?? ""))).join(", ");
}

function findTextPart(node: MessageStructureObject | undefined): { part: string; html: boolean } | undefined {
  if (!node) return undefined;
  if (node.childNodes?.length) {
    // Prefer plain text anywhere in the tree, fall back to HTML.
    const parts = node.childNodes.map((child) => findTextPart(child)).filter((p) => p !== undefined);
    return parts.find((p) => !p.html) ?? parts[0];
  }
  if (node.disposition === "attachment") return undefined;
  if (node.type === "text/plain") return { part: node.part ?? "1", html: false };
  if (node.type === "text/html") return { part: node.part ?? "1", html: true };
  return undefined;
}

function hasAttachment(node: MessageStructureObject | undefined): boolean {
  if (!node) return false;
  if (node.disposition === "attachment") return true;
  if (node.childNodes?.length) return node.childNodes.some(hasAttachment);
  const isBodyType = node.type.startsWith("text/") || node.type.startsWith("multipart/");
  return !isBodyType && Boolean(node.dispositionParameters?.filename ?? node.parameters?.name);
}

export function htmlToPlain(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function toPreview(text: string): string {
  const flat = text
    .split("\n")
    .filter((line) => !line.trim().startsWith(">"))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > PREVIEW_LENGTH ? `${flat.slice(0, PREVIEW_LENGTH).trimEnd()}…` : flat;
}

async function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Finds messages matching the filters, newest first.
 * Returns the total number of matches as well, so the caller can say "showing 20 of 143".
 */
export async function findMessages(
  client: ImapFlow,
  folder: string,
  filters: SearchFilters,
  limit: number,
  withPreviews: boolean,
): Promise<{ total: number; messages: MessageSummary[] }> {
  const lock = await client.getMailboxLock(folder, { readOnly: true });
  try {
    const found = await client.search(toSearchObject(filters), { uid: true });
    const uids = (found || []).sort((a, b) => b - a);
    const wanted = uids.slice(0, limit);
    if (wanted.length === 0) return { total: uids.length, messages: [] };

    const messages: MessageSummary[] = [];
    const textParts = new Map<number, { part: string; html: boolean }>();

    for await (const msg of client.fetch(
      wanted,
      { uid: true, envelope: true, flags: true, internalDate: true, size: true, bodyStructure: true },
      { uid: true },
    )) {
      const env = msg.envelope;
      const flags = msg.flags ?? new Set<string>();
      messages.push({
        uid: msg.uid,
        date: env?.date ? new Date(env.date) : msg.internalDate ? new Date(msg.internalDate) : undefined,
        from: formatAddressList(env?.from),
        to: formatAddressList(env?.to),
        subject: env?.subject || "(no subject)",
        unread: !flags.has("\\Seen"),
        flagged: flags.has("\\Flagged"),
        answered: flags.has("\\Answered"),
        hasAttachments: hasAttachment(msg.bodyStructure),
        size: msg.size,
      });
      const textPart = findTextPart(msg.bodyStructure);
      if (textPart) textParts.set(msg.uid, textPart);
    }

    // Downloads must wait until the fetch above has finished; IMAP can only run one command at a time.
    if (withPreviews) {
      for (const message of messages) {
        const textPart = textParts.get(message.uid);
        if (!textPart) continue;
        try {
          const { content } = await client.download(String(message.uid), textPart.part, { uid: true, maxBytes: 8_000 });
          if (!content) continue;
          const raw = await streamToString(content);
          message.preview = toPreview(textPart.html ? htmlToPlain(raw) : raw);
        } catch {
          // A preview is a nicety; never fail the listing because of one.
        }
      }
    }

    messages.sort((a, b) => b.uid - a.uid);
    return { total: uids.length, messages };
  } finally {
    lock.release();
  }
}

export interface FullMessage {
  uid: number;
  folder: string;
  flags: Set<string>;
  parsed: ParsedMail;
}

export async function fetchFullMessage(client: ImapFlow, folder: string, uid: number, markAsRead: boolean): Promise<FullMessage> {
  const lock = await client.getMailboxLock(folder, { readOnly: !markAsRead });
  try {
    const msg = await client.fetchOne(String(uid), { uid: true, source: true, flags: true }, { uid: true });
    if (!msg || !msg.source) {
      throw new FriendlyError(
        `There's no message with id ${uid} in ${folder}. It may have been moved or deleted; search again to get fresh ids.`,
      );
    }
    if (markAsRead && !msg.flags?.has("\\Seen")) {
      await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
    }
    const parsed = await simpleParser(msg.source, { skipImageLinks: true });
    return { uid, folder, flags: msg.flags ?? new Set(), parsed };
  } finally {
    lock.release();
  }
}

export function addressText(value: AddressObject | AddressObject[] | undefined): string {
  if (!value) return "";
  const list = Array.isArray(value) ? value : [value];
  return list.map((a) => a.text).join(", ");
}

export function addressList(value: AddressObject | AddressObject[] | undefined): string[] {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.flatMap((a) => a.value.map((v) => v.address).filter((x): x is string => Boolean(x)));
}

/** The readable body of a message: plain text when present, otherwise text derived from the HTML. */
export function bodyText(parsed: ParsedMail): string {
  if (parsed.text?.trim()) return parsed.text;
  if (typeof parsed.html === "string") return htmlToPlain(parsed.html).replace(/\n\s*\n\s*\n+/g, "\n\n");
  return "";
}
