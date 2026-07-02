// Aggregates the ported MAOS tool modules into one catalog + dispatcher. llm-connection.ts's
// dispatchBrowserTool() delegates any non-browser tool call here, and the assistant loop
// concatenates extraToolDefinitions() onto the browser tool catalog.

import { githubToolsModule } from "./githubTools";
import { harnessToolsModule } from "./harnessTools";
import { fileToolsModule } from "./fileTools";
import { processToolsModule } from "./processTools";
import { taskToolsModule } from "./taskTools";
import { artifactWriterModule } from "./artifactWriter";
import { imageGeneratorModule } from "./imageGenerator";
import { webToolsModule } from "./webTools";
import { execToolsModule } from "./execTools";
import { documentRenderModule } from "./documentRenderTools";
import { researchToolsModule } from "./researchTools";
import { memoryToolsModule } from "./memoryTools";
import { kernelToolsModule } from "./kernelTools";
import { desktopToolsModule } from "./desktopTools";
import { mediaToolsModule } from "./mediaTools";
import { subagentToolsModule } from "./subagentTools";
import { scheduleToolsModule } from "./scheduleTools";
import { verifyToolsModule } from "./verifyTools";
import { connectorToolsModule } from "./connectorTools";
import type { ToolContext, LlmToolDefinition, ToolModule } from "./types";

const MODULES: ToolModule[] = [
  githubToolsModule,
  harnessToolsModule,
  // Core coding-harness primitives: files, background processes, task state.
  fileToolsModule,
  processToolsModule,
  taskToolsModule,
  // Frontier harness layers (Tiers 1–3).
  webToolsModule,
  execToolsModule,
  artifactWriterModule,
  imageGeneratorModule,
  documentRenderModule,
  researchToolsModule,
  memoryToolsModule,
  kernelToolsModule,
  desktopToolsModule,
  mediaToolsModule,
  subagentToolsModule,
  scheduleToolsModule,
  verifyToolsModule,
  connectorToolsModule,
];

const HANDLERS: Record<
  string,
  (args: Record<string, any>, ctx: ToolContext) => Promise<string>
> = Object.assign({}, ...MODULES.map((m) => m.handlers));

export function extraToolDefinitions(): LlmToolDefinition[] {
  return MODULES.flatMap((m) => m.definitions);
}

export function hasExtraTool(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(HANDLERS, name);
}

export async function dispatchExtraTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<string | undefined> {
  const handler = HANDLERS[name];
  if (!handler) return undefined;
  try {
    return await handler(args as Record<string, any>, ctx);
  } catch (err) {
    return `Tool ${name} failed: ${String((err as Error)?.message ?? err)}`;
  }
}
