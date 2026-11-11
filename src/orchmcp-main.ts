import path from 'node:path';
import os from 'node:os';
import { httpCaller, runMcpStdio } from './orchmcp.ts';
import { resolveLoomPort } from './serverjson.ts';

// `loom` MCP server entry (see src/orchmcp.ts). The orchestrator's mcp.json runs
// this under tsx in a checkout, or as dist/orchmcp.js under Electron's node
// (ELECTRON_RUN_AS_NODE=1) in the app. Its args carry the token file; the port
// is $LOOM_PORT, else the one this user's Loom wrote to server.json, else 4317.
const tokenFile = process.argv[2] || path.join(process.env.LOOM_HOME || path.join(os.homedir(), '.loom'), 'orchestrator', 'token');
const port = resolveLoomPort();
void runMcpStdio(httpCaller({ port, tokenFile })).then(() => process.exit(0));
