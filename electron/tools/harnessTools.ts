// Self-introspection tool. Lets the connected LLM ask the harness "what am I,
// and what can I actually do here?" — returning the reasoning-engine/harness
// model and the capability matrix from electron/harness/capabilityModel.ts.
//
// This closes the loop on the core idea: the model is the reasoning engine and
// MAOS is the harness, so the harness should be able to describe itself to the
// model on demand instead of the model guessing its own affordances.
import { defineTool, ToolContext, ToolModule } from "./types";
import {
  CAPABILITIES,
  getCapability,
  renderCapability,
  renderHarnessOverview,
} from "../harness/capabilityModel";

export const harnessToolsModule: ToolModule = {
  definitions: [
    defineTool(
      "describe_harness",
      "Describe the MAOS agent model: how the reasoning engine (you, the LLM) and the agent " +
        "harness (MAOS — files, terminals, browser, documents, integrations, permissions, " +
        "retrieval, runtime) combine, plus the capability matrix mapping each capability to the " +
        "real tools that provide it. Call with no arguments for the full overview, or pass a " +
        "capability id (e.g. 'browser-use', 'safety-controls') for that row in detail.",
      {
        capability: {
          type: "string",
          description:
            "Optional capability id to detail. One of: " +
            CAPABILITIES.map((c) => c.id).join(", ") +
            ". Omit for the full overview.",
        },
      },
      []
    ),
  ],
  handlers: {
    describe_harness: async (args, _ctx: ToolContext) => {
      const id = typeof args.capability === "string" ? args.capability.trim() : "";
      if (id) {
        // Tolerate either the id or the human-facing capability name.
        const byName = CAPABILITIES.find(
          (c) => c.capability.toLowerCase() === id.toLowerCase(),
        );
        const resolved = getCapability(id) ? id : byName?.id ?? id;
        return renderCapability(resolved);
      }
      return renderHarnessOverview();
    },
  },
};
