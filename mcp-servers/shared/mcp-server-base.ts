/**
 * Lightweight MCP Server base implementing stdio JSON-RPC transport.
 * This serves as a shim until @anthropic-ai/sdk/mcp becomes available.
 *
 * Implements the minimum MCP protocol:
 * - initialize / initialized handshake
 * - tools/list
 * - tools/call
 */

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export type McpToolHandler = (input: Record<string, unknown>) => Promise<McpToolResult>;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface McpServerOptions {
  name: string;
  version: string;
  description?: string;
}

export class McpServerBase {
  private readonly name: string;
  private readonly version: string;
  private readonly description: string;
  private readonly tools = new Map<string, { definition: McpToolDefinition; handler: McpToolHandler }>();

  constructor(options: McpServerOptions) {
    this.name = options.name;
    this.version = options.version;
    this.description = options.description ?? '';
  }

  /**
   * Register a tool with its schema and handler.
   */
  tool(
    name: string,
    description: string,
    inputSchema: Record<string, unknown>,
    handler: McpToolHandler,
  ): void {
    this.tools.set(name, {
      definition: { name, description, inputSchema },
      handler,
    });
  }

  /**
   * Start the server on stdio transport.
   * Reads JSON-RPC messages from stdin, writes responses to stdout.
   */
  async run(): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = '';

    for await (const chunk of Bun.stdin.stream()) {
      buffer += decoder.decode(chunk, { stream: true });

      // Process complete lines
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);

        if (line.length === 0) continue;

        try {
          const request: JsonRpcRequest = JSON.parse(line);
          const response = await this.handleRequest(request);
          if (response) {
            this.writeResponse(response);
          }
        } catch {
          this.writeResponse({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: 'Parse error' },
          });
        }
      }
    }
  }

  /**
   * Handle a single JSON-RPC request.
   */
  async handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const { method, id, params } = request;

    switch (method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id: id ?? null,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: {
              name: this.name,
              version: this.version,
            },
          },
        };

      case 'notifications/initialized':
        // No response for notifications
        return null;

      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id: id ?? null,
          result: {
            tools: Array.from(this.tools.values()).map(t => ({
              name: t.definition.name,
              description: t.definition.description,
              inputSchema: {
                type: 'object',
                properties: t.definition.inputSchema,
              },
            })),
          },
        };

      case 'tools/call': {
        const toolName = (params as Record<string, unknown>)?.name as string;
        const toolInput = ((params as Record<string, unknown>)?.arguments ?? {}) as Record<string, unknown>;
        const toolEntry = this.tools.get(toolName);

        if (!toolEntry) {
          return {
            jsonrpc: '2.0',
            id: id ?? null,
            result: {
              content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
              isError: true,
            },
          };
        }

        try {
          const result = await toolEntry.handler(toolInput);
          return {
            jsonrpc: '2.0',
            id: id ?? null,
            result,
          };
        } catch (error) {
          return {
            jsonrpc: '2.0',
            id: id ?? null,
            result: {
              content: [{ type: 'text', text: `Error: ${String(error)}` }],
              isError: true,
            },
          };
        }
      }

      default:
        return {
          jsonrpc: '2.0',
          id: id ?? null,
          error: { code: -32601, message: `Method not found: ${method}` },
        };
    }
  }

  getToolDefinitions(): McpToolDefinition[] {
    return Array.from(this.tools.values()).map(t => t.definition);
  }

  private writeResponse(response: JsonRpcResponse): void {
    const json = JSON.stringify(response);
    process.stdout.write(json + '\n');
  }
}
