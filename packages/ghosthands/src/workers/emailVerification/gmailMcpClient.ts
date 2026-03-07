import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface McpToolDefinition {
  name: string;
  description?: string;
}

export type GmailMcpTransport =
  | {
      type: 'stdio';
      command: string;
      args: string[];
    }
  | {
      type: 'http';
      url: string;
    };

export interface GmailMcpClientOptions {
  transport: GmailMcpTransport;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export class GmailMcpClient {
  private readonly transport: GmailMcpTransport;
  private readonly timeoutMs: number;

  private initialized = false;
  private requestId = 1;
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = Buffer.alloc(0);
  private sessionId: string | null = null;

  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();

  constructor(options: GmailMcpClientOptions) {
    this.transport = options.transport;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    if (this.transport.type === 'stdio') {
      this.startStdioProcess();
    }

    try {
      await this.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'ghosthands', version: '0.1.0' },
      });
    } catch {
      // Some MCP servers don't require/implement initialize strictly.
    }

    try {
      await this.notify('notifications/initialized', {});
    } catch {
      // Best effort notification.
    }

    this.initialized = true;
  }

  async listTools(): Promise<McpToolDefinition[]> {
    const result = await this.request('tools/list', {});
    const obj = asObject(result);
    const tools = Array.isArray(obj?.tools) ? obj?.tools : [];

    return tools
      .map((tool) => asObject(tool))
      .filter((tool): tool is Record<string, unknown> => Boolean(tool && typeof tool.name === 'string'))
      .map((tool) => ({
        name: String(tool.name),
        description: typeof tool.description === 'string' ? tool.description : undefined,
      }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.request('tools/call', {
      name,
      arguments: args,
    });
  }

  async close(): Promise<void> {
    for (const [id, pendingReq] of this.pending) {
      clearTimeout(pendingReq.timeout);
      pendingReq.reject(new Error(`MCP client closed before response for request ${id}`));
      this.pending.delete(id);
    }

    if (this.child) {
      const child = this.child;
      this.child = null;
      try {
        child.kill('SIGTERM');
      } catch {
        // Ignore process kill errors.
      }
    }

    this.initialized = false;
  }

  private startStdioProcess(): void {
    if (this.transport.type !== 'stdio') return;
    if (this.child) return;

    const child = spawn(this.transport.command, this.transport.args, {
      stdio: 'pipe',
    });

    child.stdout.on('data', (chunk: Buffer) => {
      this.handleStdioData(chunk);
    });

    child.stderr.on('data', () => {
      // Ignore stderr noise from MCP server by default.
    });

    child.on('error', (err) => {
      this.rejectAllPending(new Error(`MCP stdio process error: ${err.message}`));
    });

    child.on('close', (code, signal) => {
      this.child = null;
      this.rejectAllPending(new Error(`MCP stdio process closed (code=${code ?? 'null'}, signal=${signal ?? 'null'})`));
    });

    this.child = child;
  }

  private handleStdioData(chunk: Buffer): void {
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);

    while (true) {
      const headerEnd = this.stdoutBuffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;

      const headerText = this.stdoutBuffer.subarray(0, headerEnd).toString('utf8');
      const match = /content-length:\s*(\d+)/i.exec(headerText);
      if (!match) {
        this.stdoutBuffer = this.stdoutBuffer.subarray(headerEnd + 4);
        continue;
      }

      const bodyLength = Number(match[1]);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + bodyLength;

      if (this.stdoutBuffer.length < bodyEnd) {
        return;
      }

      const body = this.stdoutBuffer.subarray(bodyStart, bodyEnd).toString('utf8');
      this.stdoutBuffer = this.stdoutBuffer.subarray(bodyEnd);

      let parsed: JsonRpcResponse;
      try {
        parsed = JSON.parse(body) as JsonRpcResponse;
      } catch {
        continue;
      }

      this.handleRpcResponse(parsed);
    }
  }

  private handleRpcResponse(response: JsonRpcResponse): void {
    if (typeof response.id !== 'number') return;

    const pendingReq = this.pending.get(response.id);
    if (!pendingReq) return;

    clearTimeout(pendingReq.timeout);
    this.pending.delete(response.id);

    if (response.error) {
      pendingReq.reject(new Error(`MCP error ${response.error.code}: ${response.error.message}`));
      return;
    }

    pendingReq.resolve(response.result ?? null);
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pendingReq] of this.pending) {
      clearTimeout(pendingReq.timeout);
      pendingReq.reject(error);
      this.pending.delete(id);
    }
  }

  private async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (this.transport.type === 'http') {
      return this.sendHttp({
        jsonrpc: '2.0',
        id: this.requestId++,
        method,
        params,
      });
    }

    if (!this.child || !this.child.stdin.writable) {
      throw new Error('MCP stdio process is not running');
    }

    const id = this.requestId++;
    const payload: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params ? { params } : {}),
    };

    const serialized = JSON.stringify(payload);
    const frame = `Content-Length: ${Buffer.byteLength(serialized, 'utf8')}\r\n\r\n${serialized}`;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, this.timeoutMs);

      this.pending.set(id, { resolve, reject, timeout });
      this.child!.stdin.write(frame, 'utf8');
    });
  }

  private async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    if (this.transport.type === 'http') {
      await this.sendHttp({
        jsonrpc: '2.0',
        method,
        ...(params ? { params } : {}),
      }, false);
      return;
    }

    if (!this.child || !this.child.stdin.writable) {
      throw new Error('MCP stdio process is not running');
    }

    const payload: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      ...(params ? { params } : {}),
    };

    const serialized = JSON.stringify(payload);
    const frame = `Content-Length: ${Buffer.byteLength(serialized, 'utf8')}\r\n\r\n${serialized}`;
    this.child.stdin.write(frame, 'utf8');
  }

  private async sendHttp(payload: JsonRpcRequest | JsonRpcNotification, expectResponse = true): Promise<unknown> {
    if (this.transport.type !== 'http') {
      throw new Error('HTTP transport is not configured');
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (this.sessionId) {
      headers['mcp-session-id'] = this.sessionId;
    }

    const response = await fetch(this.transport.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    const sessionId = response.headers.get('mcp-session-id');
    if (sessionId) {
      this.sessionId = sessionId;
    }

    if (!response.ok) {
      const text = await safeReadBody(response);
      throw new Error(`MCP HTTP request failed (${response.status}): ${text}`);
    }

    if (!expectResponse || response.status === 202 || response.status === 204) {
      return null;
    }

    const text = await safeReadBody(response);
    if (!text) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Invalid MCP HTTP response body: ${text.slice(0, 400)}`);
    }

    const normalized = Array.isArray(parsed)
      ? parsed.find((item) => asObject(item)?.id === (payload as JsonRpcRequest).id) ?? parsed[0]
      : parsed;

    const obj = asObject(normalized);
    if (!obj) return null;

    const error = asObject(obj.error);
    if (error) {
      const code = typeof error.code === 'number' ? error.code : -1;
      const message = typeof error.message === 'string' ? error.message : 'Unknown MCP error';
      throw new Error(`MCP error ${code}: ${message}`);
    }

    return obj.result ?? null;
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

async function safeReadBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
