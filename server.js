import fs from 'fs';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import { createRequire } from 'module';
import express from 'express';
import cors from 'cors';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js';

// Load .env if present
const require = createRequire(import.meta.url);
try {
  const dotenv = require('dotenv');
  dotenv.config();
} catch {}

const PORT = process.env.PORT || 3100;
const API_KEY = process.env.MCP_API_KEY;

if (!API_KEY) {
  console.error('ERROR: MCP_API_KEY environment variable is required.');
  process.exit(1);
}

// ── Database setup (better-sqlite3) ─────────────────────────────────────────

const MEMORY_DIR = path.join(os.homedir(), '.openclaw-memory');
const DB_PATH = path.join(MEMORY_DIR, 'memory.db');

if (!fs.existsSync(MEMORY_DIR)) fs.mkdirSync(MEMORY_DIR, { recursive: true });

const Database = require('better-sqlite3');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS context (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    value TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    tags TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS knowledge_base (
    id TEXT PRIMARY KEY,
    topic TEXT NOT NULL,
    content TEXT NOT NULL,
    relevance_score REAL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS conversation_history (
    id TEXT PRIMARY KEY,
    turn_number INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    session_id TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_memories_tags ON memories(tags);
  CREATE INDEX IF NOT EXISTS idx_kb_topic ON knowledge_base(topic);
  CREATE INDEX IF NOT EXISTS idx_conv_session ON conversation_history(session_id);
`);

// ── Tool definitions ─────────────────────────────────────────────────────────

const tools = [
  {
    name: 'store_context',
    description: 'Store persistent context data for openclaw',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Context key' },
        value: { type: 'string', description: 'Context value (JSON string)' },
      },
      required: ['key', 'value'],
    },
  },
  {
    name: 'get_context',
    description: 'Retrieve stored context data',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Context key to retrieve' },
      },
      required: ['key'],
    },
  },
  {
    name: 'store_memory',
    description: 'Store a memory entry with optional tags',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Memory title' },
        content: { type: 'string', description: 'Memory content' },
        tags: { type: 'string', description: 'Comma-separated tags' },
      },
      required: ['title', 'content'],
    },
  },
  {
    name: 'query_memories',
    description: 'Query memories by tag or title',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (tag or title)' },
        limit: { type: 'number', description: 'Max results', default: 10 },
      },
      required: ['query'],
    },
  },
  {
    name: 'add_knowledge',
    description: 'Add an entry to the knowledge base',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Knowledge topic' },
        content: { type: 'string', description: 'Knowledge content' },
        relevance_score: { type: 'number', description: 'Relevance score 0-1' },
      },
      required: ['topic', 'content'],
    },
  },
  {
    name: 'query_knowledge',
    description: 'Query knowledge base by topic',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Topic to search' },
        limit: { type: 'number', description: 'Max results', default: 5 },
      },
      required: ['topic'],
    },
  },
  {
    name: 'log_conversation',
    description: 'Log a conversation turn for history',
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', enum: ['user', 'assistant'], description: 'Speaker role' },
        content: { type: 'string', description: 'Message content' },
        session_id: { type: 'string', description: 'Session identifier' },
      },
      required: ['role', 'content', 'session_id'],
    },
  },
  {
    name: 'get_conversation_history',
    description: 'Retrieve conversation history for a session',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Session ID' },
        limit: { type: 'number', description: 'Number of recent turns', default: 20 },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'list_all_memories',
    description: 'List all stored memories',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results', default: 50 },
      },
    },
  },
  {
    name: 'delete_memory',
    description: 'Delete a memory entry by ID',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Memory ID to delete' },
      },
      required: ['id'],
    },
  },
];

// ── Tool handlers ────────────────────────────────────────────────────────────

function handleStoreContext({ key, value }) {
  const now = Date.now();
  const existing = db.prepare('SELECT id, created_at FROM context WHERE key = ?').get(key);
  const id = existing?.id ?? `ctx_${Date.now()}`;
  const createdAt = existing?.created_at ?? now;

  db.prepare(`
    INSERT INTO context (id, key, value, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `).run(id, key, value, createdAt, now);

  return { success: true, key, id };
}

function handleGetContext({ key }) {
  const row = db.prepare('SELECT key, value FROM context WHERE key = ?').get(key);
  if (row) return { success: true, key: row.key, value: row.value };
  return { success: false, error: 'Key not found' };
}

function handleStoreMemory({ title, content, tags }) {
  const id = `mem_${Date.now()}`;
  const now = Date.now();
  db.prepare(`INSERT INTO memories (id, title, content, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, title, content, tags ?? null, now, now);
  return { success: true, id, title };
}

function handleQueryMemories({ query, limit = 10 }) {
  const rows = db.prepare(`
    SELECT * FROM memories WHERE title LIKE ? OR tags LIKE ?
    ORDER BY updated_at DESC LIMIT ?
  `).all(`%${query}%`, `%${query}%`, limit);
  return { success: true, count: rows.length, memories: rows };
}

function handleAddKnowledge({ topic, content, relevance_score = 0 }) {
  const id = `kb_${Date.now()}`;
  const now = Date.now();
  db.prepare(`INSERT INTO knowledge_base (id, topic, content, relevance_score, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, topic, content, relevance_score, now, now);
  return { success: true, id, topic };
}

function handleQueryKnowledge({ topic, limit = 5 }) {
  const rows = db.prepare(`
    SELECT * FROM knowledge_base WHERE topic LIKE ?
    ORDER BY relevance_score DESC, updated_at DESC LIMIT ?
  `).all(`%${topic}%`, limit);
  return { success: true, count: rows.length, knowledge: rows };
}

function handleLogConversation({ role, content, session_id }) {
  const id = `conv_${Date.now()}`;
  const now = Date.now();
  const { count } = db.prepare('SELECT COUNT(*) as count FROM conversation_history WHERE session_id = ?').get(session_id);
  const turn_number = count + 1;
  db.prepare(`INSERT INTO conversation_history (id, turn_number, role, content, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, turn_number, role, content, session_id, now);
  return { success: true, id, turn_number };
}

function handleGetConversationHistory({ session_id, limit = 20 }) {
  const rows = db.prepare(`
    SELECT * FROM conversation_history WHERE session_id = ?
    ORDER BY turn_number DESC LIMIT ?
  `).all(session_id, limit);
  return { success: true, session_id, turn_count: rows.length, history: rows.reverse() };
}

function handleListAllMemories({ limit = 50 } = {}) {
  const rows = db.prepare('SELECT id, title, tags, created_at, updated_at FROM memories ORDER BY updated_at DESC LIMIT ?').all(limit);
  return { success: true, count: rows.length, memories: rows };
}

function handleDeleteMemory({ id }) {
  db.prepare('DELETE FROM memories WHERE id = ?').run(id);
  return { success: true, deleted: id };
}

// ── MCP Server factory ───────────────────────────────────────────────────────

function createMcpServer() {
  const server = new Server(
    { name: 'openclaw-memory', version: '2.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    let result;
    try {
      switch (name) {
        case 'store_context':           result = handleStoreContext(args); break;
        case 'get_context':             result = handleGetContext(args); break;
        case 'store_memory':            result = handleStoreMemory(args); break;
        case 'query_memories':          result = handleQueryMemories(args); break;
        case 'add_knowledge':           result = handleAddKnowledge(args); break;
        case 'query_knowledge':         result = handleQueryKnowledge(args); break;
        case 'log_conversation':        result = handleLogConversation(args); break;
        case 'get_conversation_history':result = handleGetConversationHistory(args); break;
        case 'list_all_memories':       result = handleListAllMemories(args); break;
        case 'delete_memory':           result = handleDeleteMemory(args); break;
        default:
          return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
      }
    } catch (e) {
      result = { success: false, error: e.message };
    }
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  return server;
}

// ── Express HTTP server ──────────────────────────────────────────────────────

const app = createMcpExpressApp({ host: 'localhost' });
app.use(cors({ origin: '*' }));
const transports = new Map();

app.use((req, _res, next) => {
  console.log(
    `[${new Date().toISOString()}] ${req.method} ${req.path} host=${req.headers.host ?? ''} session=${req.headers['mcp-session-id'] ?? ''} auth=${req.headers.authorization ? 'yes' : 'no'} bodyMethod=${req.body?.method ?? ''}`
  );
  next();
});

// Bearer token auth middleware
function requireAuth(req, res, next) {
  const auth = (req.headers['authorization'] || '').trim();

  if (!auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = auth.slice(7);

  if (token !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
}

// Health check (no auth needed — OpenAI uses this to verify the server is live)
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', server: 'openclaw-memory', version: '2.0.0' });
});

// MCP endpoint — JSON initialize response + session-based transport reuse
app.post('/mcp', requireAuth, async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  let transport = sessionId ? transports.get(sessionId) : undefined;

  try {
    if (!transport) {
      if (sessionId || !isInitializeRequest(req.body)) {
        return res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
          id: null,
        });
      }

      const server = createMcpServer();
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (newSessionId) => {
          transports.set(newSessionId, { transport, server });
        },
      });

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    await transport.transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('Error handling MCP request:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

app.get('/mcp', requireAuth, (_req, res) => {
  res.status(405).set('Allow', 'POST').send('Method Not Allowed');
});

app.delete('/mcp', requireAuth, async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  const entry = sessionId ? transports.get(sessionId) : undefined;

  if (!entry) {
    return res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
      id: null,
    });
  }

  try {
    await entry.transport.handleRequest(req, res, req.body);
  } finally {
    transports.delete(sessionId);
    entry.transport.close();
    entry.server.close();
  }
});

app.listen(PORT, () => {
  console.log(`openclaw-memory MCP server running on port ${PORT}`);
  console.log(`Endpoint: POST http://localhost:${PORT}/mcp`);
  console.log(`Health:   GET  http://localhost:${PORT}/health`);
});
