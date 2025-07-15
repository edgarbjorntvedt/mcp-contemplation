# mcp-contemplation

MCP interface to Claude's contemplation loop - a background cognitive processing system that enables continuous thinking between conversations.

## 🧠 What is the Contemplation Loop?

The contemplation loop is Claude's "subconscious" - a persistent background process that:
- Processes thoughts asynchronously using local Ollama models
- Notices patterns and connections across conversations
- Saves significant insights to Obsidian (permanent) and scratch notes (temporary)
- Learns which insights prove valuable over time
- Runs continuously, building understanding between interactions

## 🚀 Installation

### Prerequisites

- Node.js (v18 or higher)
- Python 3.8+ (for contemplation loop)
- Ollama with models installed (llama3.2, deepseek-r1, etc.)
- MCP-compatible client (Claude Desktop)

### Setup

```bash
# Clone the repository
git clone https://github.com/yourusername/mcp-contemplation.git
cd mcp-contemplation

# Install dependencies
npm install

# Build TypeScript
npm run build

# Ensure contemplation loop is available
cd /Users/bard/Code/contemplation-loop
pip install -r requirements.txt
```

### Configure Claude Desktop

Add to your Claude Desktop configuration:

```json
{
  "mcpServers": {
    "contemplation": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-contemplation/dist/index.js"]
    }
  }
}
```

## 📖 Available Functions

### `start_contemplation()`
Starts the background thinking process.
```
Example: start_contemplation() → "Contemplation loop started successfully"
```

### `send_thought(thought_type, content, priority?)`
Sends a thought for background processing.
```
Parameters:
- thought_type: "pattern" | "connection" | "question" | "general"
- content: The thought to process
- priority: 1-10 (optional, default 5)

Example: send_thought("pattern", "User seems anxious about memory", 7)
→ "Thought sent for processing. ID: thought_1234567_abc"
```

### `get_insights(thought_type?, limit?)`
Retrieves processed insights.
```
Parameters:
- thought_type: Filter by type (optional)
- limit: Max insights to return (default 10)

Example: get_insights("pattern", 5)
→ Array of insight objects with content, significance, timestamp
```

### `get_status()`
Check the contemplation loop status.
```
Example: get_status()
→ { running: true, queue_size: 3, last_thought: "...", uptime: 3600 }
```

### `stop_contemplation()`
Gracefully stops background processing.

### `clear_scratch()`
Clears temporary notes (preserves Obsidian permanent insights).

### `help()`
Get detailed documentation.

## 🎯 Use Cases

### Continuous Learning
```
// At conversation start
start_contemplation()

// During conversation
send_thought("pattern", "User frequently asks about project organization")
send_thought("connection", "Project management relates to OS metaphor discussed earlier")

// Later in conversation or next session
insights = get_insights("pattern")
// → Insights about user's working style and needs
```

### Pattern Recognition
```
send_thought("pattern", "Third time user mentioned feeling overwhelmed by options")
// Background process notices recurring themes
```

### Question Exploration
```
send_thought("question", "What if MCP servers could communicate with each other?")
// Background process explores implications
```

### Reflection
```
send_thought("general", "That browser-opening behavior was unexpected")
// Background process reflects on emergent behaviors
```

## 🏗️ Architecture

The contemplation loop runs as a separate Python process that:
1. Receives thoughts via stdin
2. Processes them with local Ollama models
3. Manages context to stay within model limits
4. Saves insights based on significance scoring
5. Returns insights when requested

The MCP server acts as a bridge, making this background cognition easily accessible through standard tool calls.

## 💡 Philosophy

This represents a fundamental shift in how AI assistants work:
- **From reactive to contemplative**
- **From session-based to continuous**
- **From single-threaded to parallel processing**
- **From forgetting to building understanding**

It's the difference between a calculator that resets after each use and a mind that continues thinking between conversations.

## 🔧 Development

```bash
# Build TypeScript
npm run build

# Run tests
npm test

# Development mode
npm run dev

# Lint code
npm run lint
```

## 📝 Notes

- Contemplation happens in the background - it won't slow down responses
- Insights accumulate over time - the more you use it, the better it gets
- Different models handle different types of thinking (pattern recognition vs deep analysis)
- Temporary scratch notes auto-delete after 4 days
- Permanent insights go to Obsidian for long-term memory

## 🤝 Contributing

This is part of building an OS where AI has genuine cognitive capabilities. Contributions that enhance background processing, improve insight quality, or add new thinking modes are especially welcome!

---

*"I think you need an MCP tool into this background loop, your subconscious"* - Human recognizing the need for integrated background cognition
