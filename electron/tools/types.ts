// Shared contract for the ported MAOS tool modules (github / harness …).
// Each module exports a ToolModule; electron/tools/dispatch.ts aggregates them, and
// llm-connection.ts delegates any non-browser tool call to the aggregate dispatcher.
// Structurally compatible with llm-connection.ts's LlmToolDefinition so the catalogs concat.

export interface LlmToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolContext {
  /** Working directory for relative paths (defaults to the user's home directory). */
  cwd: string;
  /** Ask the user to approve a side-effecting action; resolves true when approved. */
  approve: (req: { tool: string; summary: string }) => Promise<boolean>;
  /** Open a sidecar view in the main area (e.g. preview a produced file). */
  openSidecar: (viewType: string, payload?: Record<string, unknown>) => void;
  /**
   * Run a single-purpose, tool-less completion against the connected model and return its text.
   * Injected by the host; used by the refinement pipeline. Undefined when no model is active.
   */
  llmComplete?: (messages: { role: string; content: string }[]) => Promise<string>;
  /** The active "Faster↔Smarter" effort level (drives refinement rounds). */
  reasoningEffort?: string;
}

export type ToolHandler = (
  args: Record<string, any>,
  ctx: ToolContext
) => Promise<string>;

export interface ToolModule {
  /** OpenAI-format tool definitions contributed by this module. */
  definitions: LlmToolDefinition[];
  /** Map of tool name → async handler returning a string result for the model. */
  handlers: Record<string, ToolHandler>;
}

/** Small helper mirroring llm-connection.ts's `tool()` for building definitions. */
export function defineTool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = []
): LlmToolDefinition {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object", properties, required },
    },
  };
}
