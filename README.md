# openclaw-memory MCP Server

A custom Model Context Protocol (MCP) server for openclaw providing persistent context storage, memory management, and conversation history with fast query capabilities.

## Features

- **Persistent Context Storage**: Store and retrieve key-value configuration data
- **Memory Management**: Create, query, and delete timestamped memory entries with tagging
- **Knowledge Base**: Structured topic-based knowledge with relevance scoring
- **Conversation History**: Full conversation logging per session with turn tracking
- **Fast Queries**: SQL-powered search across all memory types
- **Automatic Persistence**: All data saved to `~/.openclaw-memory/memory.db`

## Installation

```bash
npm install
```

## Configuration

This server runs as a remote HTTP MCP endpoint, not a local stdio process.

Set your env file or shell environment:

```bash
cp .env.example .env
```

```bash
MCP_API_KEY=your-secret-key-here
PORT=3100
```

Start the server:

```bash
npm start
```

Point your MCP client at the HTTP endpoint:

```json
{
  "name": "filesystem-memory",
  "type": "http",
  "url": "http://localhost:3100/mcp",
  "headers": {
    "Authorization": "Bearer your-secret-key-here"
  }
}
```

Health check:

```text
GET http://localhost:3100/health
```

## Available Tools

### Context Management
- **store_context** - Store persistent key-value configuration
- **get_context** - Retrieve stored context by key

### Memory Management
- **store_memory** - Create a memory entry with optional tags
- **query_memories** - Search memories by title or tag
- **list_all_memories** - List all stored memories
- **delete_memory** - Delete a memory entry by ID

### Knowledge Base
- **add_knowledge** - Add to knowledge base with topic and relevance
- **query_knowledge** - Search knowledge base by topic

### Conversation History
- **log_conversation** - Record a conversation turn
- **get_conversation_history** - Retrieve conversation history for a session

## Usage Examples

### Store Context
```javascript
{
  "tool": "store_context",
  "arguments": {
    "key": "current_project",
    "value": "{\"name\": \"openclaw\", \"stage\": \"development\"}"
  }
}
```

### Store Memory
```javascript
{
  "tool": "store_memory",
  "arguments": {
    "title": "User Preferences",
    "content": "User prefers concise responses",
    "tags": "user,preferences,communication"
  }
}
```

### Query Memories
```javascript
{
  "tool": "query_memories",
  "arguments": {
    "query": "preferences",
    "limit": 5
  }
}
```

### Log Conversation
```javascript
{
  "tool": "log_conversation",
  "arguments": {
    "role": "user",
    "content": "What should we build next?",
    "session_id": "session-123"
  }
}
```

## Data Storage

Memory database is stored at: `~/.openclaw-memory/memory.db`

The database includes:
- `context` - Key-value store for configuration
- `memories` - Timestamped memory entries with tags
- `knowledge_base` - Topic-indexed knowledge with relevance scores
- `conversation_history` - Full conversation logs per session

## Testing

Check syntax:

```bash
node --check server.js
```

Run the server manually:
```bash
npm start
```

## Development

Run with file watching:
```bash
npm run dev
```
