import { MessageStore, type StoredMessage } from './message-store.js';
import { SummaryStore, type SummaryNode } from './summary-store.js';
import type { ToolDescription } from '@ccbuddy/core';

export interface GrepResult {
  messages: StoredMessage[];
  summaries: SummaryNode[];
}

export interface BriefPair {
  trigger: StoredMessage;
  response: StoredMessage | undefined;
}

export interface GetBriefsResult {
  briefs: BriefPair[];
  count: number;
}

export interface ExpandResult {
  node: SummaryNode;
  sourceMessages: StoredMessage[];
  sourceNodes?: SummaryNode[];
}

export interface DescribeResult {
  messages: StoredMessage[];
  count: number;
}

export class RetrievalTools {
  private messages: MessageStore;
  private summaries: SummaryStore;

  constructor(messages: MessageStore, summaries: SummaryStore) {
    this.messages = messages;
    this.summaries = summaries;
  }

  /**
   * Search both messages and summaries for a given query string.
   */
  grep(userId: string, query: string): GrepResult {
    const messages = this.messages.search(userId, query);
    const summaries = this.summaries.search(userId, query);
    return { messages, summaries };
  }

  /**
   * Expand a summary node:
   * - depth=0 (leaf): resolve sourceIds as message IDs
   * - depth>0 (condensed): resolve sourceIds as summary node IDs
   * Returns undefined if the node does not exist.
   */
  expand(userId: string, nodeId: number): ExpandResult | undefined {
    const node = this.summaries.getById(nodeId);
    if (!node || node.userId !== userId) return undefined;

    if (node.depth === 0) {
      // Leaf node: sourceIds are message IDs
      const sourceMessages = node.sourceIds
        .map(id => this.messages.getById(id))
        .filter((m): m is StoredMessage => m !== undefined);
      return { node, sourceMessages };
    } else {
      // Condensed node: sourceIds are summary node IDs
      const sourceNodes = node.sourceIds
        .map(id => this.summaries.getById(id))
        .filter((s): s is SummaryNode => s !== undefined);
      const sourceMessages: StoredMessage[] = [];
      return { node, sourceMessages, sourceNodes };
    }
  }

  /**
   * Return scheduled briefing pairs (trigger + assistant response).
   * Optionally filter by job name (e.g. "evening_briefing", "morning_briefing_weekday").
   */
  getBriefs(userId: string, jobName?: string): GetBriefsResult {
    const briefs = this.messages.getBriefs(userId, jobName);
    return { briefs, count: briefs.length };
  }

  /**
   * Return messages in a given time range with count.
   */
  describe(userId: string, { startMs, endMs }: { startMs: number; endMs: number }): DescribeResult {
    const messages = this.messages.getByTimeRange(userId, startMs, endMs);
    return { messages, count: messages.length };
  }

  /**
   * Returns 4 ToolDescription objects compatible with the skill registry.
   */
  getToolDefinitions(): ToolDescription[] {
    return [
      {
        name: 'memory_grep',
        description: 'Search across stored messages and summaries for a user by query string. userId is optional — omit it to search all stored users (defaults to the owner user).',
        inputSchema: {
          type: 'object',
          properties: {
            userId: {
              type: 'string',
              description: 'The user ID to search within (optional — defaults to the owner user ID)',
            },
            query: {
              type: 'string',
              description: 'The search query string',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'memory_get_briefs',
        description: 'Retrieve scheduled briefing pairs (trigger + assistant response) from memory. Use this to look up morning or evening briefings. Optionally filter by job name.',
        inputSchema: {
          type: 'object',
          properties: {
            userId: {
              type: 'string',
              description: 'The user ID to query (optional — defaults to the owner user ID)',
            },
            jobName: {
              type: 'string',
              description: 'Optional job name to filter by (e.g. "evening_briefing", "morning_briefing_weekday", "morning_briefing_weekend"). Omit to get all scheduled briefings.',
            },
          },
          required: [],
        },
      },
      {
        name: 'memory_describe',
        description: 'Return messages in a time range for a user with a count.',
        inputSchema: {
          type: 'object',
          properties: {
            userId: {
              type: 'string',
              description: 'The user ID to query (optional — defaults to the owner user ID)',
            },
            startMs: {
              type: 'number',
              description: 'Start of time range in milliseconds since epoch',
            },
            endMs: {
              type: 'number',
              description: 'End of time range in milliseconds since epoch',
            },
          },
          required: ['startMs', 'endMs'],
        },
      },
      {
        name: 'memory_expand',
        description: 'Expand a summary node to its source messages or child summary nodes.',
        inputSchema: {
          type: 'object',
          properties: {
            userId: {
              type: 'string',
              description: 'The user ID that owns the node (optional — defaults to the owner user ID)',
            },
            nodeId: {
              type: 'number',
              description: 'The summary node ID to expand',
            },
          },
          required: ['nodeId'],
        },
      },
    ];
  }
}
