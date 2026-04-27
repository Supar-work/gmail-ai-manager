/**
 * stdio MCP server entry point.
 *
 * Spawned as a child process by the chat agent runner via
 * `claude -p --mcp-config <config>` where the config tells claude-p
 * to exec this file with `GAM_USER_ID=<userId>` in its env. Inside the
 * subprocess we reuse the same Prisma client + Gmail helpers + audit
 * recorder, so chat-driven mutations land in the same `AgentAction`
 * table the rules engine writes to.
 *
 * Read tools first; mutating tools (`inbox.apply`, `rules.create`,
 * `schedule.add`, `drafts.create`) land in milestone 5 once the chat
 * surface is verified end-to-end.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { registerInboxReadTools } from './tools/inbox.js';
import { registerRulesReadTools } from './tools/rules.js';
import { registerDecisionsReadTools } from './tools/decisions.js';
import { registerAgentActionsReadTools } from './tools/agent-actions.js';
import { registerAllWriteTools } from './tools/write.js';
import { logger } from '../logger.js';

export type ToolDefinition<I = unknown> = {
  name: string;
  description: string;
  inputSchema: z.ZodSchema<I>;
  /** Returns either an MCP CallToolResult or a plain JSON-serialisable
   *  value the registry will wrap into a single text content block. */
  handler: (args: I, ctx: ToolContext) => Promise<unknown>;
};

export type ToolContext = {
  userId: string;
};

const tools: Map<string, ToolDefinition<unknown>> = new Map();

export function registerTool<I>(def: ToolDefinition<I>): void {
  tools.set(def.name, def as ToolDefinition<unknown>);
}

async function main(): Promise<void> {
  const userId = process.env.GAM_USER_ID;
  if (!userId) {
    process.stderr.write(
      'GAM_USER_ID env var required (set by the chat agent runner before exec)\n',
    );
    process.exit(1);
  }

  // Read tools are always registered. Write tools are opt-in via env
  // so the chat agent runner can ship a read-only build first
  // (milestone 5) and enable mutations in milestone 6 by setting
  // GAM_MCP_ENABLE_WRITE=1.
  registerInboxReadTools();
  registerRulesReadTools();
  registerDecisionsReadTools();
  registerAgentActionsReadTools();
  if (process.env.GAM_MCP_ENABLE_WRITE === '1') {
    registerAllWriteTools();
  }

  const server = new Server(
    { name: 'gmail-ai-manager', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Array.from(tools.values()).map((t) => ({
      name: t.name,
      description: t.description,
      // The SDK expects a plain JSON Schema. zod-to-json-schema would do
      // it more accurately, but for our small-leaf tool inputs the bare
      // shape from `_def` is enough.
      inputSchema: zodToJsonSchema(t.inputSchema),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const def = tools.get(request.params.name);
    if (!def) {
      return errorResult(`unknown_tool: ${request.params.name}`);
    }
    const parsed = def.inputSchema.safeParse(request.params.arguments ?? {});
    if (!parsed.success) {
      return errorResult(`bad_arguments: ${parsed.error.message}`);
    }
    try {
      const out = await def.handler(parsed.data, { userId });
      return wrapResult(out);
    } catch (err) {
      logger.error({ err, tool: def.name }, 'mcp tool failed');
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Keep the process alive — MCP server reads from stdin until EOF.
}

function wrapResult(out: unknown): CallToolResult {
  // Allow handlers to return an MCP-shaped result directly when they
  // want fine control (rare); otherwise serialise the value.
  if (out && typeof out === 'object' && 'content' in (out as Record<string, unknown>)) {
    return out as CallToolResult;
  }
  const text = typeof out === 'string' ? out : JSON.stringify(out, null, 2);
  return {
    content: [{ type: 'text', text }],
  };
}

function errorResult(message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
  };
}

/**
 * Tiny zod → JSON Schema converter that handles the cases our tools
 * actually use (string / number / boolean / optional / object). Avoids
 * pulling `zod-to-json-schema` for what is currently a 5-tool surface.
 */
function zodToJsonSchema(schema: z.ZodSchema<unknown>): Record<string, unknown> {
  const def = (schema as unknown as { _def: { typeName: string } })._def;
  switch (def.typeName) {
    case 'ZodObject': {
      const shape = (schema as unknown as z.AnyZodObject).shape;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, sub] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(sub as z.ZodSchema<unknown>);
        const isOptional =
          ((sub as { _def?: { typeName?: string } })._def?.typeName ?? '') ===
            'ZodOptional' ||
          ((sub as { isOptional?: () => boolean }).isOptional?.() ?? false);
        if (!isOptional) required.push(key);
      }
      return { type: 'object', properties, required };
    }
    case 'ZodOptional':
      return zodToJsonSchema(
        (schema as unknown as { _def: { innerType: z.ZodSchema<unknown> } })._def.innerType,
      );
    case 'ZodString':
      return { type: 'string' };
    case 'ZodNumber':
      return { type: 'number' };
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodArray':
      return {
        type: 'array',
        items: zodToJsonSchema(
          (schema as unknown as { _def: { type: z.ZodSchema<unknown> } })._def.type,
        ),
      };
    default:
      return {};
  }
}

main().catch((err) => {
  process.stderr.write(`stdio mcp fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(2);
});
