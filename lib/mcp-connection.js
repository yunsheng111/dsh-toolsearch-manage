// MCP transport, connection, and per-session instances.
//
// Connection model: ISOLATED, one instance per DSH session. Each session (a
// subagent included) gets its own stdio child process or HTTP connection, torn
// down when `agent.ctx` disposes. The alternative — one shared connection per
// configuration — saves a handshake and costs correctness: a stateful server
// (a browser, a local document bridge) then leaks state across sessions that
// happen to run concurrently. Shared connections are a per-server optimisation
// this plugin does not offer, because offering both in one registry means the
// registry can no longer say which semantics it implements.
//
// The transport, naming and result code is carried over from
// `dsh-skill-mcp-manager@1.2.2` (MIT). The concurrency fix in
// `SessionRuntime#withLoadLock` is new: the previous implementation disposed
// and re-established a connection across several `await`s, so two parallel
// `mcp_load` calls for one server could each dispose the other's connection.

import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ResilientStdioTransport } from './stdio-transport.js';
import { childEnv } from './child-env.js';

// DeepSeek function-name contract: 64 chars, [A-Za-z0-9_-].
const MAX_PUBLIC_NAME_LENGTH = 64;
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g;
const HASH_LENGTH = 12;

export const MAX_ERROR_CONTEXT_CHARS = 2000;

/**
 * The model-facing name of one MCP tool: `mcp__<server>__<raw>`.
 *
 * Falls back to a hashed suffix when the natural name breaks the function-name
 * contract. The hash covers `server\0raw` so two different tools can never
 * collide on one truncated name.
 */
export function publicToolName(serverName, rawName) {
  const joined = `mcp__${serverName}__${rawName}`;
  const normalized = joined.replace(INVALID_NAME_CHARS, '_');
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized;
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, HASH_LENGTH);
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`;
}

/**
 * Connection identity: everything that must change before the connection is
 * torn down and rebuilt. Tier, notes and an unchanged resubmit are not in it.
 */
export function connectionIdentity(entry) {
  if (entry.transport === 'stdio') {
    return JSON.stringify({
      transport: 'stdio',
      command: entry.command ?? null,
      args: entry.args ?? [],
      env: entry.env ?? {},
      cwd: entry.cwd ?? null,
    });
  }
  return JSON.stringify({
    transport: entry.transport ?? null,
    url: entry.url ?? null,
    headers: entry.headers ?? {},
  });
}

async function buildTransport(entry, stdioMaxBufferSizeBytes) {
  switch (entry.transport) {
    case 'stdio':
      // ResilientStdioTransport is wire-compatible with the SDK transport, but
      // an oversized message is answered with a synthetic JSON-RPC error
      // instead of tearing the connection down (lib/stdio-transport.js).
      return new ResilientStdioTransport({
        command: entry.command,
        args: entry.args ?? [],
        env: await childEnv(entry.env),
        cwd: entry.cwd || undefined,
        ...(stdioMaxBufferSizeBytes === undefined ? {} : { maxBufferSize: stdioMaxBufferSizeBytes }),
      });
    case 'streamable-http':
      return new StreamableHTTPClientTransport(new URL(entry.url), {
        requestInit: { headers: entry.headers ?? {} },
      });
    default:
      throw new Error(`unsupported transport "${entry.transport}"`);
  }
}

async function listTools(client) {
  const tools = [];
  let cursor;
  do {
    const response = await client.request(
      { method: 'tools/list', ...(cursor === undefined ? {} : { params: { cursor } }) },
      ListToolsResultSchema,
    );
    tools.push(...response.tools);
    cursor = response.nextCursor;
  } while (cursor);
  return tools;
}

/**
 * Connect, list tools, and read the server-declared metadata.
 *
 * Server-declared metadata from the initialize handshake (newer spec adds
 * name/version/title/description/websiteUrl to `serverInfo`, plus a top-level
 * `instructions` string and a `capabilities` object). Empty when the server
 * omits them — that is information, not an error.
 */
export async function connectEntry(entry, { timeoutMs, version, stdioMaxBufferSizeBytes }) {
  const client = new Client({ name: 'toolsearch-manage', version });
  const transport = await buildTransport(entry, stdioMaxBufferSizeBytes);
  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`connection to "${entry.name}" timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    await Promise.race([client.connect(transport), timeout]);
    const tools = await listTools(client);
    return {
      client,
      transport,
      tools,
      serverInfo: client.getServerVersion(),
      instructions: client.getInstructions(),
      capabilities: client.getServerCapabilities(),
    };
  } catch (error) {
    try {
      await client.close();
    } catch {
      /* ignore */
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// Same job as dsh-mcp-client's RawCallToolResultSchema: do not let the SDK
// reject a tools/call payload before the host projection runs. A zod record is
// not importable here; safeParse is all the SDK calls.
const RawCallToolResultSchema = {
  safeParse(data) {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      return { success: false, error: new Error('MCP tool result must be an object') };
    }
    return { success: true, data };
  },
};

export function clipJson(value) {
  const text = JSON.stringify(value ?? null);
  if (text.length <= MAX_ERROR_CONTEXT_CHARS) return text;
  return `${text.slice(0, MAX_ERROR_CONTEXT_CHARS)}…(truncated, ${text.length} chars total)`;
}

/**
 * Invoke one MCP tool.
 *
 * Protocol/transport-level failures (-32602, -32603, timeouts, …) are opaque to
 * the model on their own, so when `errorInfo` is provided the call context
 * (server/tool, arguments sent, tool inputSchema) is appended — the model can
 * then see what it sent and self-correct instead of guessing.
 */
export async function callTool(client, rawName, args, { timeoutMs, signal, errorInfo }) {
  const safeArgs = args && typeof args === 'object' ? args : {};
  try {
    return await client.request(
      { method: 'tools/call', params: { name: rawName, arguments: safeArgs } },
      RawCallToolResultSchema,
      { signal, timeout: timeoutMs },
    );
  } catch (err) {
    if (errorInfo === undefined) throw err;
    const lines = [
      err instanceof Error ? err.message : String(err),
      `called MCP tool: ${errorInfo.server}/${rawName}`,
      `arguments sent: ${clipJson(safeArgs)}`,
    ];
    if (errorInfo.inputSchema !== undefined) lines.push(`tool inputSchema: ${clipJson(errorInfo.inputSchema)}`);
    throw new Error(lines.join('\n'));
  }
}

/**
 * isError results are normal responses (server-side business failures such as
 * "unknown tool" or bad parameters), not protocol rejects. Attach the same call
 * context so the model can self-correct there too.
 */
export function isErrorContextSuffix(errorInfo, rawName, args) {
  if (errorInfo === undefined) return '';
  return `\ncalled MCP tool: ${errorInfo.server}/${rawName}\narguments sent: ${clipJson(args && typeof args === 'object' ? args : {})}`;
}

/**
 * Per-session connection set.
 *
 * `withLoadLock` serialises the connect/replace sequence for one server name
 * inside one session. Two parallel tool calls that both ask for the same server
 * would otherwise interleave `dispose → connect → register`, and the second
 * disposal would kill the connection the first just published. The lock is
 * per (session, server), so different servers still connect in parallel.
 */
export class SessionRuntime {
  constructor(agent) {
    this.agent = agent;
    this.connections = new Map();
    this.nativeDisposers = new Map();
    this.connectionKeys = new Map();
    this.locks = new Map();
  }

  /** Run `body` with exclusive access to one server name inside this session. */
  withLoadLock(name, body) {
    const previous = this.locks.get(name) ?? Promise.resolve();
    const next = previous.then(body, body);
    // Keep the chain going even when a link rejects, so one failed load does
    // not deadlock every later load of the same server.
    this.locks.set(name, next.then(() => undefined, () => undefined));
    return next;
  }

  async disposeEntry(name) {
    const connection = this.connections.get(name);
    this.connections.delete(name);
    this.connectionKeys.delete(name);
    const disposers = this.nativeDisposers.get(name);
    this.nativeDisposers.delete(name);
    if (disposers !== undefined) for (const dispose of disposers.values()) dispose();
    if (connection !== undefined) {
      try {
        await connection.client.close();
      } catch {
        /* already closed */
      }
    }
  }

  async disposeAll() {
    const names = new Set([...this.connections.keys(), ...this.nativeDisposers.keys()]);
    for (const name of names) await this.disposeEntry(name);
  }
}
