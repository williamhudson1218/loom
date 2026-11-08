import fs from 'node:fs';
import { ORCH_TOOLS } from './orchdefs.ts';

// The Loom MCP server the orchestrator session gets via --mcp-config: stdio,
// newline-delimited JSON-RPC 2.0 (the MCP stdio transport). It holds no state and
// opens nothing: every tools/call is forwarded to Loom's own server
// (POST /api/orch/tool), which owns the database, tmux and the focused-pane guard.
// So the orchestrator keeps working across a Loom restart: the next call simply
// reaches the new server. Entry point: src/orchmcp-main.ts.

export const MCP_SERVER_NAME = 'loom';
const SERVER_VERSION = '0.1.0';
const DEFAULT_PROTOCOL = '2025-06-18';

export type ToolOutcome = { ok: true; result: unknown } | { ok: false; error: string };
export type ToolCaller = (name: string, args: Record<string, unknown>) => Promise<ToolOutcome>;

interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const reply = (id: RpcMessage['id'], result: unknown) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id: RpcMessage['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

/** One incoming message -> the response to write, or null for a notification. */
export async function handleMcpMessage(msg: RpcMessage, call: ToolCaller): Promise<object | null> {
  const isRequest = msg.id !== undefined && msg.id !== null;
  switch (msg.method) {
    case 'initialize': {
      const asked = typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : DEFAULT_PROTOCOL;
      return reply(msg.id, {
        protocolVersion: asked,
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: SERVER_VERSION },
        instructions: 'Loom: every chat, PR and Slack thread on this Mac, the status items, and relays into other chats.',
      });
    }
    case 'ping':
      return reply(msg.id, {});
    case 'tools/list':
      return reply(msg.id, { tools: ORCH_TOOLS });
    case 'tools/call': {
      const name = typeof msg.params?.name === 'string' ? msg.params.name : '';
      const args = (msg.params?.arguments && typeof msg.params.arguments === 'object' ? msg.params.arguments : {}) as Record<string, unknown>;
      if (!ORCH_TOOLS.some((t) => t.name === name)) return rpcError(msg.id, -32602, `unknown tool ${name}`);
      let out: ToolOutcome;
      try {
        out = await call(name, args);
      } catch (e) {
        out = { ok: false, error: (e as Error).message };
      }
      const text = out.ok ? JSON.stringify(out.result, null, 1) : out.error;
      return reply(msg.id, { content: [{ type: 'text', text }], ...(out.ok ? {} : { isError: true }) });
    }
    default:
      if (!isRequest) return null; // notifications/initialized, notifications/cancelled, ...
      return rpcError(msg.id, -32601, `method not found: ${msg.method}`);
  }
}

/**
 * Forward tool calls to Loom's server. The token is re-read on every call (Loom
 * may have restarted since this process started); it rides a custom header, which
 * a browser page cannot send cross-origin without a preflight Loom never grants.
 */
export function httpCaller(opts: { port: number; tokenFile: string; fetchImpl?: typeof fetch }): ToolCaller {
  const f = opts.fetchImpl ?? fetch;
  return async (name, args) => {
    let token = '';
    try {
      token = fs.readFileSync(opts.tokenFile, 'utf-8').trim();
    } catch {
      return { ok: false, error: 'Loom has not written its token yet; is Loom running?' };
    }
    try {
      const r = await f(`http://127.0.0.1:${opts.port}/api/orch/tool`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-loom-orch-token': token },
        body: JSON.stringify({ name, args }),
      });
      const j = (await r.json()) as ToolOutcome;
      return j && typeof j === 'object' && 'ok' in j ? j : { ok: false, error: `bad response (${r.status})` };
    } catch (e) {
      return { ok: false, error: 'Loom is not reachable: ' + (e as Error).message };
    }
  };
}

/** Run the stdio loop until stdin closes. Responses are written in arrival order. */
export function runMcpStdio(call: ToolCaller, input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<void> {
  return new Promise((resolve) => {
    let buf = '';
    let chain: Promise<void> = Promise.resolve();
    const write = (o: object | null) => {
      if (o) output.write(JSON.stringify(o) + '\n');
    };
    input.setEncoding?.('utf-8');
    input.on('data', (chunk: string | Buffer) => {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: RpcMessage;
        try {
          msg = JSON.parse(line);
        } catch {
          write(rpcError(null, -32700, 'parse error'));
          continue;
        }
        chain = chain.then(() => handleMcpMessage(msg, call).then(write, (e) => write(rpcError(msg.id, -32603, (e as Error).message))));
      }
    });
    input.on('end', () => void chain.then(() => resolve()));
  });
}
