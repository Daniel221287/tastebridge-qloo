// TasteBridge local server: MCP (Streamable HTTP, /mcp) + single-page web demo + JSON API.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {createMcpHandler, McpServer} from '@modelcontextprotocol/server';
import {hostHeaderValidation, localhostHostValidation, localhostOriginValidation, originValidation, toNodeHandler} from '@modelcontextprotocol/node';
import {loadDotEnv} from './src/env.mjs';
import {QLOO_BASE_URL, QlooClient, QlooError} from './src/qloo.mjs';
import {AgentInputError, findCommonGround} from './src/agent.mjs';
import {TOOLS} from './src/tools.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const VERSION = '1.0.0';
const FILES = Object.freeze({
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/app.js': ['public/app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['public/style.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['public/favicon.svg', 'image/svg+xml']
});
const HEADERS = Object.freeze({
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: https://images.qloo.com; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store'
});

function httpError(code, status) {
  const err = new Error(code);
  err.status = status;
  return err;
}

function respond(res, status, payload) {
  res.writeHead(status, {...HEADERS, 'Content-Type': 'application/json; charset=utf-8'});
  res.end(JSON.stringify(payload));
}

async function parseJson(req) {
  if (!/^application\/json(?:;|$)/i.test(String(req.headers['content-type'] || ''))) throw httpError('JSON_CONTENT_TYPE_REQUIRED', 415);
  const chunks = [];
  let bytes = 0;
  for await (const part of req) {
    bytes += part.length;
    if (bytes > 16384) throw httpError('REQUEST_TOO_LARGE', 413);
    chunks.push(part);
  }
  let obj;
  try { obj = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw httpError('MALFORMED_REQUEST_JSON', 400); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw httpError('REQUEST_OBJECT_REQUIRED', 400);
  return obj;
}

// Maps errors to safe public payloads (never includes the API key or stack traces).
export function publicError(err) {
  if (err instanceof AgentInputError) return {status: 400, body: {ok: false, error: err.code, message: err.userMessage}};
  if (err instanceof QlooError) {
    const missing = err.code === 'QLOO_API_KEY_MISSING';
    return {status: missing ? 503 : 502, body: {ok: false, error: err.code, message: missing ? 'The server has no Qloo API key configured.' : 'Qloo API error: ' + err.code + (err.detail ? ' - ' + err.detail : '')}};
  }
  if (err?.status && /^[A-Z][A-Z0-9_]{3,80}$/.test(String(err.message))) return {status: err.status, body: {ok: false, error: err.message}};
  return {status: 500, body: {ok: false, error: 'INTERNAL_ERROR'}};
}

function mcpFactory(client) {
  const srv = new McpServer({name: 'tastebridge-qloo', version: VERSION});
  for (const tool of TOOLS) {
    srv.registerTool(tool.name, {title: tool.title, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations}, async args => {
      try {
        return {content: [{type: 'text', text: JSON.stringify(await tool.run(client, args))}]};
      } catch (err) {
        return {isError: true, content: [{type: 'text', text: JSON.stringify(publicError(err).body)}]};
      }
    });
  }
  return srv;
}

// Fixed-window limiter per client IP: protects the Qloo quota if the demo is ever exposed publicly.
export function createLimiter({limit = 30, windowMs = 60000, now = () => Date.now()} = {}) {
  const hits = new Map();
  return key => {
    const t = now();
    const w = hits.get(key);
    if (!w || t - w.start >= windowMs) {
      if (hits.size > 5000) hits.clear();
      hits.set(key, {start: t, n: 1});
      return true;
    }
    w.n += 1;
    return w.n <= limit;
  };
}

export function createAppServer({client, rateLimit = 30, allowedHosts = []} = {}) {
  if (!client) throw new Error('CLIENT_REQUIRED');
  const handler = createMcpHandler(() => mcpFactory(client), {responseMode: 'json'});
  const nodeHandler = toNodeHandler(handler);
  const checkHost = allowedHosts.length ? hostHeaderValidation(allowedHosts) : localhostHostValidation();
  const checkOrigin = allowedHosts.length ? originValidation(allowedHosts) : localhostOriginValidation();
  const allow = createLimiter({limit: rateLimit});
  const http = createServer((req, res) => {
    if (!checkHost(req, res) || !checkOrigin(req, res)) return;
    void (async () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const limited = url.pathname === '/mcp' || url.pathname.startsWith('/api/');
      if (limited && !allow(req.socket.remoteAddress || 'unknown')) return respond(res, 429, {ok: false, error: 'RATE_LIMITED'});
      if (url.pathname === '/mcp') return nodeHandler(req, res);
      if (req.method === 'GET' && url.pathname === '/health') {
        return respond(res, 200, {ok: true, app: 'TasteBridge', version: VERSION, mcp: '/mcp', qlooBaseUrl: QLOO_BASE_URL, qlooKeyConfigured: client.configured});
      }
      if (req.method === 'GET' && FILES[url.pathname]) {
        const [file, type] = FILES[url.pathname];
        const data = await readFile(resolve(here, file));
        res.writeHead(200, {...HEADERS, 'Content-Type': type});
        return res.end(data);
      }
      if (req.method === 'POST' && url.pathname === '/api/common-ground') {
        return respond(res, 200, await findCommonGround(client, await parseJson(req)));
      }
      respond(res, 404, {ok: false, error: 'NOT_FOUND'});
    })().catch(err => {
      if (res.headersSent) return res.destroy();
      const {status, body} = publicError(err);
      respond(res, status, body);
    });
  });
  return {http, handler};
}

export async function startApp({port = 4793, host = '127.0.0.1', client, allowedHosts = [], rateLimit} = {}) {
  const local = host === '127.0.0.1' || host === 'localhost';
  if (!local && !allowedHosts.length) throw new Error('PUBLIC_BINDING_REQUIRES_ALLOWED_HOSTS');
  const app = createAppServer({client, allowedHosts, rateLimit});
  await new Promise((ok, no) => {
    app.http.once('error', no);
    app.http.listen(port, host, ok);
  });
  return app;
}

export async function stopApp(app) {
  await app.handler.close();
  await new Promise(ok => app.http.close(ok));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadDotEnv(resolve(here, '.env'));
  const client = new QlooClient({apiKey: process.env.QLOO_API_KEY});
  const allowedHosts = String(process.env.ALLOWED_HOSTS || '').split(',').map(s => s.trim()).filter(Boolean);
  const host = process.env.HOST || '127.0.0.1';
  const app = await startApp({port: Number(process.env.PORT || 4793), host, client, allowedHosts});
  const {port} = app.http.address();
  console.log(`TASTEBRIDGE_READY http://${host}:${port}  (MCP endpoint: /mcp, Qloo key configured: ${client.configured ? 'yes' : 'no'})`);
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => stopApp(app).then(() => process.exit(0)));
}
