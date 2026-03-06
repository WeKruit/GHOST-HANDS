import type { EmailProvider, EmailSearchOptions, VerificationSignal } from './types.js';
import { GmailMcpClient, type McpToolDefinition } from './gmailMcpClient.js';

interface GmailMcpProviderOptions {
  client: GmailMcpClient;
  searchToolName?: string;
  readToolName?: string;
  maxCandidates?: number;
}

interface ParsedEmail {
  id?: string;
  subject?: string;
  snippet?: string;
  from?: string;
  receivedAt?: string;
  body?: string;
}

const DEFAULT_MAX_CANDIDATES = 5;

export class GmailMcpProvider implements EmailProvider {
  private readonly client: GmailMcpClient;
  private readonly configuredSearchToolName?: string;
  private readonly configuredReadToolName?: string;
  private readonly maxCandidates: number;

  private toolsCache: McpToolDefinition[] | null = null;

  constructor(options: GmailMcpProviderOptions) {
    this.client = options.client;
    this.configuredSearchToolName = options.searchToolName;
    this.configuredReadToolName = options.readToolName;
    this.maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  }

  async findLatestVerificationSignal(options: EmailSearchOptions): Promise<VerificationSignal | null> {
    await this.client.init();

    const tools = await this.getTools();
    const searchTool = this.selectSearchToolName(tools);
    const readTool = this.selectReadToolName(tools);

    if (!searchTool) {
      throw new Error('No Gmail MCP search tool found');
    }

    const query = this.buildVerificationQuery(options.loginEmail, options.lookbackMinutes);
    const searchResult = await this.callSearchTool(searchTool, query);

    const textFromSearch = extractText(searchResult);
    const parsedFromSearch = parseEmails(searchResult);

    const sortedCandidates = parsedFromSearch
      .sort((a, b) => {
        const aTs = a.receivedAt ? Date.parse(a.receivedAt) : 0;
        const bTs = b.receivedAt ? Date.parse(b.receivedAt) : 0;
        return bTs - aTs;
      })
      .slice(0, this.maxCandidates);

    for (const email of sortedCandidates) {
      const bodyText = [email.subject, email.snippet, email.body].filter(Boolean).join('\n');
      const signal = detectSignal(bodyText, email);
      if (signal) return signal;

      if (readTool && email.id) {
        const detailedBody = await this.readEmailBody(readTool, email.id);
        const signalFromRead = detectSignal(detailedBody, email);
        if (signalFromRead) return signalFromRead;
      }
    }

    if (textFromSearch) {
      return detectSignal(textFromSearch, {});
    }

    return null;
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  private async getTools(): Promise<McpToolDefinition[]> {
    if (this.toolsCache) return this.toolsCache;
    const tools = await this.client.listTools();
    this.toolsCache = tools;
    return tools;
  }

  private selectSearchToolName(tools: McpToolDefinition[]): string | null {
    if (this.configuredSearchToolName) return this.configuredSearchToolName;

    const preferred = tools.find((tool) => /gmail[:_.-]?(search|list|query)|mail[:_.-]?(search|list|query)/i.test(tool.name));
    if (preferred) return preferred.name;

    const fallback = tools.find((tool) => /search|list|query/i.test(tool.name));
    return fallback?.name ?? null;
  }

  private selectReadToolName(tools: McpToolDefinition[]): string | null {
    if (this.configuredReadToolName) return this.configuredReadToolName;

    const preferred = tools.find((tool) => /gmail[:_.-]?(read|get|message)|mail[:_.-]?(read|get|message)/i.test(tool.name));
    if (preferred) return preferred.name;

    const fallback = tools.find((tool) => /read|get|message/i.test(tool.name));
    return fallback?.name ?? null;
  }

  private buildVerificationQuery(loginEmail: string, lookbackMinutes: number): string {
    const lookbackHours = Math.max(1, Math.ceil(lookbackMinutes / 60));
    const mailbox = loginEmail ? `to:${loginEmail}` : '';
    return [
      mailbox,
      '(verify OR verification OR confirm OR activation OR otp OR "one-time" OR "sign in" OR "security code")',
      `newer_than:${lookbackHours}h`,
      '(is:unread OR newer_than:1d)',
    ].filter(Boolean).join(' ');
  }

  private async callSearchTool(searchToolName: string, query: string): Promise<unknown> {
    const attempts: Array<Record<string, unknown>> = [
      { query, maxResults: 10 },
      { query, limit: 10 },
      { q: query, limit: 10 },
      { query },
      { q: query },
      { limit: 10 },
      {},
    ];

    let lastError: Error | null = null;
    for (const args of attempts) {
      try {
        return await this.client.callTool(searchToolName, args);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }

    throw lastError ?? new Error('Failed to execute Gmail MCP search tool');
  }

  private async readEmailBody(readToolName: string, messageId: string): Promise<string> {
    const attempts: Array<Record<string, unknown>> = [
      { id: messageId },
      { messageId },
      { emailId: messageId },
      { threadId: messageId },
    ];

    for (const args of attempts) {
      try {
        const result = await this.client.callTool(readToolName, args);
        const text = extractText(result);
        if (text) return text;
      } catch {
        // Try next argument shape.
      }
    }

    return '';
  }
}

function detectSignal(text: string, email: Partial<ParsedEmail>): VerificationSignal | null {
  if (!text) return null;

  const link = extractVerificationLink(text);
  if (link) {
    return {
      kind: 'link',
      messageId: email.id,
      subject: email.subject,
      from: email.from,
      receivedAt: email.receivedAt,
      link,
      rawText: text,
    };
  }

  const code = extractOtp(text);
  if (code) {
    return {
      kind: 'otp',
      messageId: email.id,
      subject: email.subject,
      from: email.from,
      receivedAt: email.receivedAt,
      code,
      rawText: text,
    };
  }

  return null;
}

function extractVerificationLink(text: string): string | null {
  const urls = text.match(/https?:\/\/[^\s<>")]+/gi) || [];
  if (urls.length === 0) return null;

  const preferred = urls.find((url) => /verify|verification|confirm|activate|magic|token|signin|sign-in|account/i.test(url));
  return preferred ?? urls[0] ?? null;
}

function extractOtp(text: string): string | null {
  const focusedMatches = text.matchAll(
    /(?:verification(?:\s+code)?|security(?:\s+code)?|one[-\s]?time(?:\s+pass(?:word|code))?|otp|passcode|pin)\D{0,16}\b([A-Z0-9]{4,10})\b/gi,
  );
  for (const match of focusedMatches) {
    const candidate = match[1];
    if (candidate && isLikelyOtpToken(candidate)) {
      return candidate;
    }
  }

  const numeric = text.match(/\b(\d{4,8})\b/);
  if (numeric?.[1]) return numeric[1];

  return null;
}

function isLikelyOtpToken(value: string): boolean {
  const token = value.trim();
  if (token.length < 4 || token.length > 10) return false;
  if (!/[0-9]/.test(token)) return false;
  return true;
}

function parseEmails(result: unknown): ParsedEmail[] {
  const raw = normalizeToolPayload(result);

  const candidateArrays: unknown[][] = [];
  if (Array.isArray(raw)) {
    candidateArrays.push(raw);
  } else {
    const obj = asObject(raw);
    if (obj) {
      for (const key of ['messages', 'emails', 'items', 'results', 'data']) {
        if (Array.isArray(obj[key])) {
          candidateArrays.push(obj[key] as unknown[]);
        }
      }
    }
  }

  const items = candidateArrays[0] ?? [];

  const parsed: ParsedEmail[] = [];
  for (const item of items) {
    const record = asObject(item);
    if (!record) continue;

    const parsedItem: ParsedEmail = {
      id: pickString(record, ['id', 'messageId', 'emailId', 'threadId']),
      subject: pickString(record, ['subject', 'title']),
      snippet: pickString(record, ['snippet', 'preview', 'summary']),
      from: pickString(record, ['from', 'sender', 'fromAddress']),
      receivedAt: pickTimestamp(record),
      body: pickString(record, ['body', 'textBody', 'content', 'text']),
    };

    if (parsedItem.id || parsedItem.subject || parsedItem.snippet || parsedItem.body) {
      parsed.push(parsedItem);
    }
  }

  return parsed;
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function pickTimestamp(obj: Record<string, unknown>): string | undefined {
  for (const key of ['receivedAt', 'received_at', 'date', 'timestamp', 'internalDate']) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) {
      const ts = Date.parse(value);
      if (!Number.isNaN(ts)) return new Date(ts).toISOString();
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      const millis = value < 10_000_000_000 ? value * 1000 : value;
      return new Date(millis).toISOString();
    }
  }
  return undefined;
}

function normalizeToolPayload(result: unknown): unknown {
  const obj = asObject(result);
  if (!obj) return result;

  if (obj.structuredContent !== undefined) {
    return obj.structuredContent;
  }

  if (Array.isArray(obj.content)) {
    const joined = (obj.content as unknown[])
      .map((entry) => {
        const e = asObject(entry);
        if (!e) return '';
        return typeof e.text === 'string' ? e.text : '';
      })
      .filter(Boolean)
      .join('\n');

    if (!joined) return result;

    try {
      return JSON.parse(joined);
    } catch {
      return joined;
    }
  }

  return result;
}

function extractText(result: unknown): string {
  const normalized = normalizeToolPayload(result);

  if (typeof normalized === 'string') return normalized;

  if (Array.isArray(normalized)) {
    return normalized.map((item) => {
      if (typeof item === 'string') return item;
      const obj = asObject(item);
      return obj ? JSON.stringify(obj) : '';
    }).filter(Boolean).join('\n');
  }

  const obj = asObject(normalized);
  if (!obj) return '';

  const directText = pickString(obj, ['text', 'body', 'snippet', 'summary']);
  if (directText) return directText;

  return JSON.stringify(obj);
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
