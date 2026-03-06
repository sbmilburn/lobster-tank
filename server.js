#!/usr/bin/env node
'use strict';

const fs   = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const SESSIONS_DIR = path.join(process.env.HOME, '.openclaw/agents/main/sessions');
const CRON_DIR     = path.join(process.env.HOME, '.openclaw/cron/runs');
const PUBLIC_DIR   = path.join(__dirname, 'public');
const PORT         = parseInt(process.env.PORT || '3742', 10);
const DEMO_MODE    = process.argv.includes('--demo');

// ---------------------------------------------------------------------------
// Cron session ID cache — refreshed periodically
// ---------------------------------------------------------------------------
let cronSessionIds = new Set();

function refreshCronIds() {
  const ids = new Set();
  try {
    for (const file of fs.readdirSync(CRON_DIR)) {
      if (!file.endsWith('.jsonl')) continue;
      const text = fs.readFileSync(path.join(CRON_DIR, file), 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try { const o = JSON.parse(line); if (o.sessionId) ids.add(o.sessionId); } catch {}
      }
    }
  } catch {}
  cronSessionIds = ids;
}

function classifySession(filePath) {
  const id = path.basename(filePath, '.jsonl');
  if (cronSessionIds.has(id)) return 'cron';
  return 'main'; // subagent detection TBD — could check sessionKey prefix
}

// ---------------------------------------------------------------------------
// File tailing — track byte offsets per file
// ---------------------------------------------------------------------------
const fileCursors = new Map();

function processNewBytes(filePath, source, broadcast) {
  try {
    const stat = fs.statSync(filePath);
    const cursor = fileCursors.get(filePath) || 0;
    if (stat.size <= cursor) return;

    const buf = Buffer.alloc(stat.size - cursor);
    const fd  = fs.openSync(filePath, 'r');
    fs.readSync(fd, buf, 0, buf.length, cursor);
    fs.closeSync(fd);
    fileCursors.set(filePath, stat.size);

    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type !== 'message') continue;
        const content = obj.message?.content;
        if (!Array.isArray(content)) continue;
        for (const block of content) {
          if (block?.type === 'toolCall' && block.name) {
            broadcast({ tool: block.name, source, timestamp: obj.timestamp || new Date().toISOString() });
          }
        }
      } catch {}
    }
  } catch {}
}

// ---------------------------------------------------------------------------
// HTTP server (static files)
// ---------------------------------------------------------------------------
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };

const httpServer = http.createServer((req, res) => {
  let urlPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const filePath = path.resolve(PUBLIC_DIR, '.' + urlPath);

  // Guard against path traversal
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const mime = MIME[path.extname(filePath)] || 'text/plain';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

// ---------------------------------------------------------------------------
// WebSocket server
// ---------------------------------------------------------------------------
const wss     = new WebSocket.Server({ server: httpServer });
const clients = new Set();

wss.on('connection', ws => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'hello', mode: DEMO_MODE ? 'demo' : 'live' }));
  ws.on('close', () => clients.delete(ws));
});

function broadcast(event) {
  const msg = JSON.stringify(event);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

// ---------------------------------------------------------------------------
// Live mode — watch sessions directory
// ---------------------------------------------------------------------------
function watchSessions() {
  refreshCronIds();
  setInterval(refreshCronIds, 60_000);

  // Seed cursors at current EOF (ignore historical events)
  for (const file of fs.readdirSync(SESSIONS_DIR)) {
    if (!file.endsWith('.jsonl')) continue;
    const fp = path.join(SESSIONS_DIR, file);
    try { fileCursors.set(fp, fs.statSync(fp).size); } catch {}
  }

  fs.watch(SESSIONS_DIR, { persistent: true }, (eventType, filename) => {
    if (!filename || !filename.endsWith('.jsonl')) return;
    const fp     = path.join(SESSIONS_DIR, filename);
    const source = classifySession(fp);
    processNewBytes(fp, source, broadcast);
  });

  console.log(`👁  Watching ${SESSIONS_DIR}`);
}

// ---------------------------------------------------------------------------
// Demo mode — replay a synthetic event stream in a loop
// ---------------------------------------------------------------------------
const DEMO_TOOLS = [
  // (tool, source, weight)
  ['exec',           'main',     10],
  ['Read',           'main',      6],
  ['Write',          'main',      4],
  ['Edit',           'main',      4],
  ['web_search',     'main',      5],
  ['web_fetch',      'main',      3],
  ['memory_search',  'main',      5],
  ['memory_get',     'main',      4],
  ['session_status', 'main',      2],
  ['message',        'main',      2],
  ['exec',           'cron',      4],
  ['memory_search',  'cron',      2],
  ['sessions_spawn', 'main',      1],
  ['subagents',      'subagent',  1],
  ['cron',           'cron',      3],
  ['gateway',        'main',      1],
  ['image',          'main',      1],
  ['browser',        'main',      1],
  ['tts',            'main',      1],
  ['pdf',            'main',      1],
];

// Expand by weight
const DEMO_WEIGHTED = [];
for (const [tool, source, weight] of DEMO_TOOLS) {
  for (let i = 0; i < weight; i++) DEMO_WEIGHTED.push({ tool, source });
}

function runDemo() {
  console.log(`🎬 Demo mode — firing synthetic tool events`);

  function fireNext() {
    const entry = DEMO_WEIGHTED[Math.floor(Math.random() * DEMO_WEIGHTED.length)];
    broadcast({ tool: entry.tool, source: entry.source, timestamp: new Date().toISOString() });
    // Realistic timing: sometimes rapid bursts, sometimes slow
    const delay = Math.random() < 0.3
      ? 300  + Math.random() * 700   // burst
      : 1200 + Math.random() * 2800; // calm
    setTimeout(fireNext, delay);
  }

  // Start after a short delay so the browser has time to connect
  setTimeout(fireNext, 2000);
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
httpServer.listen(PORT, () => {
  console.log(`🦞 Lobster Tank → http://localhost:${PORT}`);
  console.log(`   Mode: ${DEMO_MODE ? 'DEMO (synthetic events)' : 'LIVE (watching logs)'}`);
  if (DEMO_MODE) runDemo(); else watchSessions();
});
