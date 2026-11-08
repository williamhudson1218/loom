import path from 'node:path';
import os from 'node:os';
import { httpCaller, runMcpStdio } from './orchmcp.ts';

// `loom` MCP server entry (see src/orchmcp.ts). The orchestrator's mcp.json runs
// this under tsx in a checkout, or as dist/orchmcp.js under Electron's node
// (ELECTRON_RUN_AS_NODE=1) in the app. Its args carry the token file; the port
// is Loom's fixed one unless $LOOM_PORT says otherwise.
const tokenFile = process.argv[2] || path.join(process.env.LOOM_HOME || path.join(os.homedir(), '.loom'), 'orchestrator', 'token');
const port = Number(process.env.LOOM_PORT) || 4317;
void runMcpStdio(httpCaller({ port, tokenFile })).then(() => process.exit(0));
