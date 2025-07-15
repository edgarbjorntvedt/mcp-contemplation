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

### get_insights(thought_type?, limit?, min_significance?)
Retrieves processed insights from the contemplation loop.
- thought_type: Optional filter by type
- limit: Max number of insights (default 10)
- min_significance: Minimum significance score (default 5)
Returns: Array of insights with metadata

### set_threshold(significance_threshold)
Sets the minimum significance for insights to be returned.
- significance_threshold: Number 1-10 (default 5)
Returns: Confirmation message

### get_memory_stats()
Gets memory usage statistics for the contemplation system.
Returns: Stats object with insight counts, memory usage, etc.

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
  similar_count?: number;
  aggregated_ids?: string[];
}

class ContemplationManager {
  private subprocess?: ChildProcess;
  private contemplationPath: string;
  private bridgePath: string;
  private insights: Insight[] = [];
  private maxInsightsInMemory: number = 100;
  private significanceThreshold: number = 5;
  
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
          const lines = data.toString().split('\n').filter((line: string) => line.trim());
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
    // First, clean up old/low-value insights
    this.pruneInsights();
    
    // Aggregate similar insights
    this.aggregateSimilarInsights();
    
    // Filter unused insights above threshold
    let filtered = this.insights.filter(i => 
      !i.used && i.significance >= this.significanceThreshold
    );
    
    if (thoughtType) {
      filtered = filtered.filter(i => i.thought_type === thoughtType);
    }
    
    // Sort by significance and recency
    filtered.sort((a, b) => {
      // Prioritize aggregated insights
      if (a.similar_count && b.similar_count) {
        const countDiff = (b.similar_count || 1) - (a.similar_count || 1);
        if (countDiff !== 0) return countDiff;
      }
      
      if (b.significance !== a.significance) {
        return b.significance - a.significance;
      }
      return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
    });

    // Mark as used and clean from memory
    const results = filtered.slice(0, limit);
    results.forEach(insight => {
      insight.used = true;
      // Remove high-frequency patterns after use to prevent repetition
      if (insight.similar_count && insight.similar_count > 3) {
        this.removeInsight(insight.id);
      }
    });

    return results;
  }

  private pruneInsights(): void {
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours
    
    // Remove old, used, or low-significance insights
    this.insights = this.insights.filter(insight => {
      const age = now - new Date(insight.timestamp).getTime();
      
      // Keep if: recent AND (unused OR high significance)
      return age < maxAge && (!insight.used || insight.significance >= 8);
    });
    
    // If still too many, keep only the most significant
    if (this.insights.length > this.maxInsightsInMemory) {
      this.insights.sort((a, b) => b.significance - a.significance);
      this.insights = this.insights.slice(0, this.maxInsightsInMemory);
    }
  }

  private aggregateSimilarInsights(): void {
    // Simple similarity check based on content overlap
    const aggregated: Map<string, Insight> = new Map();
    
    for (const insight of this.insights) {
      if (insight.used) continue;
      
      let foundSimilar = false;
      for (const [key, existing] of aggregated) {
        if (this.areSimilar(insight.content, existing.content)) {
          // Merge into existing
          existing.similar_count = (existing.similar_count || 1) + 1;
          existing.aggregated_ids = existing.aggregated_ids || [existing.id];
          existing.aggregated_ids.push(insight.id);
          existing.significance = Math.max(existing.significance, insight.significance);
          foundSimilar = true;
          break;
        }
      }
      
      if (!foundSimilar) {
        aggregated.set(insight.id, { ...insight });
      }
    }
    
    // Replace insights with aggregated version
    this.insights = Array.from(aggregated.values());
  }

  private areSimilar(content1: string, content2: string): boolean {
    // Simple similarity check - can be enhanced
    const words1 = content1.toLowerCase().split(/\s+/);
    const words2 = content2.toLowerCase().split(/\s+/);
    
    const commonWords = words1.filter(w => words2.includes(w));
    const similarity = commonWords.length / Math.min(words1.length, words2.length);
    
    return similarity > 0.6; // 60% word overlap
  }

  private removeInsight(id: string): void {
    this.insights = this.insights.filter(i => i.id !== id && !i.aggregated_ids?.includes(id));
  }

  setThreshold(threshold: number): void {
    this.significanceThreshold = Math.max(1, Math.min(10, threshold));
  }

  getMemoryStats(): any {
    const total = this.insights.length;
    const unused = this.insights.filter(i => !i.used).length;
    const highSig = this.insights.filter(i => i.significance >= 8).length;
    const aggregated = this.insights.filter(i => i.similar_count && i.similar_count > 1).length;
    
    return {
      total_insights: total,
      unused_insights: unused,
      high_significance: highSig,
      aggregated_patterns: aggregated,
      memory_limit: this.maxInsightsInMemory,
      significance_threshold: this.significanceThreshold,
      estimated_context_usage: `${Math.round((total / this.maxInsightsInMemory) * 100)}%`
    };
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
            },
            min_significance: {
              type: 'number',
              description: 'Minimum significance score 1-10 (default 5)',
              minimum: 1,
              maximum: 10
            }
          },
        },
      },
      {
        name: 'set_threshold',
        description: 'Set minimum significance threshold for insights',
        inputSchema: {
          type: 'object',
          properties: {
            significance_threshold: {
              type: 'number',
              description: 'Minimum significance 1-10',
              minimum: 1,
              maximum: 10
            }
          },
          required: ['significance_threshold'],
        },
      },
      {
        name: 'get_memory_stats',
        description: 'Get memory usage statistics',
        inputSchema: {
          type: 'object',
          properties: {},
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
        const { thought_type, limit, min_significance } = args as {
          thought_type?: string;
          limit?: number;
          min_significance?: number;
        };
        
        if (min_significance) {
          contemplation.setThreshold(min_significance);
        }
        
        const insights = await contemplation.getInsights(thought_type, limit);
        return {
          content: [{ type: 'text', text: JSON.stringify(insights, null, 2) }],
        };
      }

      case 'set_threshold': {
        const { significance_threshold } = args as { significance_threshold: number };
        contemplation.setThreshold(significance_threshold);
        return {
          content: [{ type: 'text', text: `Significance threshold set to ${significance_threshold}` }],
        };
      }

      case 'get_memory_stats': {
        const stats = contemplation.getMemoryStats();
        return {
          content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }],
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
