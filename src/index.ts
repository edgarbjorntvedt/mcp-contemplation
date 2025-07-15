#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

// Documentation
const HELP_DOCUMENTATION = `
# MCP Contemplation Server

Interface to Claude's background contemplation loop - a persistent subprocess that:
- Processes thoughts asynchronously between conversations
- Works with local Ollama models for different thinking styles
- Manages context to avoid overflow
- Saves insights to both temporary scratch and permanent Obsidian storage
- Learns from usage patterns to improve insight selection

## Available Functions:

### start_contemplation()
Starts the background contemplation loop if not already running.
Returns: Status message

### send_thought(thought_type, content, priority?)
Sends a thought for background processing.
- thought_type: "pattern", "connection", "question", or "general"
- content: The thought content to process
- priority: Optional priority (1-10, default 5)
Returns: Thought ID for tracking

### get_insights(thought_type?, limit?)
Retrieves processed insights from the contemplation loop.
- thought_type: Optional filter by type
- limit: Max number of insights (default 10)
Returns: Array of insights with metadata

### get_status()
Gets the current status of the contemplation loop.
Returns: Status object with running state, queue size, etc.

### stop_contemplation()
Gracefully stops the contemplation loop.
Returns: Status message

### clear_scratch()
Clears temporary scratch notes (keeps Obsidian permanent notes).
Returns: Number of files cleared

### help()
Returns this documentation.

## Thought Types:
- **pattern**: Notice recurring themes across conversations
- **connection**: Find links between disparate ideas
- **question**: Explore interesting questions that arise
- **general**: Open-ended reflection

## How It Works:
The contemplation loop runs as a background process, using local LLMs (via Ollama)
to process thoughts between conversations. High-significance insights are saved
permanently to Obsidian, while medium-significance thoughts go to temporary scratch
storage for 4 days. The system learns which insights prove valuable over time.
`;

interface ContemplationStatus {
  running: boolean;
  process_id?: number;
  queue_size: number;
  last_thought?: string;
  uptime?: number;
}

interface Insight {
  id: string;
  thought_type: string;
  content: string;
  significance: number;
  timestamp: string;
  used: boolean;
}

class ContemplationManager {
  private subprocess?: ChildProcess;
  private contemplationPath: string;
  private bridgePath: string;
  private insights: Insight[] = [];
  
  constructor() {
    this.contemplationPath = '/Users/bard/Code/contemplation-loop/src/contemplation_loop.py';
    this.bridgePath = '/Users/bard/Code/contemplation-loop/src/contemplation_bridge.py';
  }

  async start(): Promise<string> {
    if (this.subprocess) {
      return 'Contemplation loop already running';
    }

    try {
      this.subprocess = spawn('python3', [this.contemplationPath], {
        cwd: path.dirname(this.contemplationPath),
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: false
      });

      this.subprocess.stdout?.on('data', (data) => {
        try {
          const lines = data.toString().split('\n').filter(line => line.trim());
          for (const line of lines) {
            const response = JSON.parse(line);
            if (response.has_insight) {
              this.insights.push({
                id: response.thought_id,
                thought_type: response.thought_type,
                content: response.insight,
                significance: response.significance || 5,
                timestamp: new Date().toISOString(),
                used: false
              });
            }
          }
        } catch (e) {
          // Not JSON, ignore
        }
      });

      this.subprocess.on('error', (err) => {
        console.error('Contemplation process error:', err);
      });

      // Give it a moment to start
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      return 'Contemplation loop started successfully';
    } catch (error) {
      throw new Error(`Failed to start contemplation: ${error}`);
    }
  }

  async sendThought(thoughtType: string, content: string, priority: number = 5): Promise<string> {
    if (!this.subprocess) {
      throw new Error('Contemplation loop not running. Call start_contemplation first.');
    }

    const thoughtId = `thought_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const message = {
      action: 'add_thought',
      thought_type: thoughtType,
      content: content,
      priority: priority,
      thought_id: thoughtId
    };

    this.subprocess.stdin?.write(JSON.stringify(message) + '\n');
    return thoughtId;
  }

  async getInsights(thoughtType?: string, limit: number = 10): Promise<Insight[]> {
    let filtered = this.insights;
    
    if (thoughtType) {
      filtered = filtered.filter(i => i.thought_type === thoughtType);
    }
    
    // Sort by significance and recency
    filtered.sort((a, b) => {
      if (b.significance !== a.significance) {
        return b.significance - a.significance;
      }
      return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
    });

    // Mark as used (for learning system)
    const results = filtered.slice(0, limit);
    results.forEach(insight => {
      insight.used = true;
    });

    return results;
  }

  async getStatus(): Promise<ContemplationStatus> {
    const running = !!this.subprocess && !this.subprocess.killed;
    
    if (!running) {
      return {
        running: false,
        queue_size: 0
      };
    }

    // Send status request
    this.subprocess?.stdin?.write(JSON.stringify({ action: 'status' }) + '\n');
    
    // For now, return basic status
    return {
      running: true,
      process_id: this.subprocess?.pid,
      queue_size: this.insights.filter(i => !i.used).length,
      last_thought: this.insights[this.insights.length - 1]?.content
    };
  }

  async stop(): Promise<string> {
    if (!this.subprocess) {
      return 'Contemplation loop not running';
    }

    this.subprocess.stdin?.write(JSON.stringify({ action: 'stop' }) + '\n');
    this.subprocess.kill();
    this.subprocess = undefined;
    
    return 'Contemplation loop stopped';
  }

  async clearScratch(): Promise<number> {
    const scratchPath = '/Users/bard/Code/contemplation-loop/tmp/contemplation';
    let count = 0;

    try {
      const days = fs.readdirSync(scratchPath);
      for (const day of days) {
        const dayPath = path.join(scratchPath, day);
        const files = fs.readdirSync(dayPath);
        count += files.length;
        fs.rmSync(dayPath, { recursive: true, force: true });
      }
    } catch (e) {
      // Directory might not exist
    }

    return count;
  }
}

// Global instance
const contemplation = new ContemplationManager();

const server = new Server(
  {
    name: 'mcp-contemplation',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Tool handlers
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'start_contemplation',
        description: 'Start the background contemplation loop',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'send_thought',
        description: 'Send a thought for background processing',
        inputSchema: {
          type: 'object',
          properties: {
            thought_type: {
              type: 'string',
              enum: ['pattern', 'connection', 'question', 'general'],
              description: 'Type of thought to process'
            },
            content: {
              type: 'string',
              description: 'The thought content to process'
            },
            priority: {
              type: 'number',
              description: 'Priority 1-10 (default 5)',
              minimum: 1,
              maximum: 10
            }
          },
          required: ['thought_type', 'content'],
        },
      },
      {
        name: 'get_insights',
        description: 'Retrieve processed insights from contemplation',
        inputSchema: {
          type: 'object',
          properties: {
            thought_type: {
              type: 'string',
              enum: ['pattern', 'connection', 'question', 'general'],
              description: 'Filter by thought type'
            },
            limit: {
              type: 'number',
              description: 'Maximum insights to return (default 10)'
            }
          },
        },
      },
      {
        name: 'get_status',
        description: 'Get contemplation loop status',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'stop_contemplation',
        description: 'Stop the contemplation loop',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'clear_scratch',
        description: 'Clear temporary scratch notes',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'help',
        description: 'Get help documentation for contemplation system',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'start_contemplation': {
        const result = await contemplation.start();
        return {
          content: [{ type: 'text', text: result }],
        };
      }

      case 'send_thought': {
        const { thought_type, content, priority } = args as {
          thought_type: string;
          content: string;
          priority?: number;
        };
        
        const thoughtId = await contemplation.sendThought(thought_type, content, priority);
        return {
          content: [{ type: 'text', text: `Thought sent for processing. ID: ${thoughtId}` }],
        };
      }

      case 'get_insights': {
        const { thought_type, limit } = args as {
          thought_type?: string;
          limit?: number;
        };
        
        const insights = await contemplation.getInsights(thought_type, limit);
        return {
          content: [{ type: 'text', text: JSON.stringify(insights, null, 2) }],
        };
      }

      case 'get_status': {
        const status = await contemplation.getStatus();
        return {
          content: [{ type: 'text', text: JSON.stringify(status, null, 2) }],
        };
      }

      case 'stop_contemplation': {
        const result = await contemplation.stop();
        return {
          content: [{ type: 'text', text: result }],
        };
      }

      case 'clear_scratch': {
        const count = await contemplation.clearScratch();
        return {
          content: [{ type: 'text', text: `Cleared ${count} scratch files` }],
        };
      }

      case 'help': {
        return {
          content: [{ type: 'text', text: HELP_DOCUMENTATION }],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [{ 
        type: 'text', 
        text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}` 
      }],
    };
  }
});

// Start the server
const transport = new StdioServerTransport();
server.connect(transport);
console.error('mcp-contemplation MCP server running on stdio');
