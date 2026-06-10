import { describe, it, expect } from "vitest";
import { opToToolName } from "../electron/llm-connection";

// The generic `browser` bridge tool routes {op: "..."} commands through
// opToToolName. These aliases are documented in FUNCTIONALITY_STACK.md §1.1.

describe("opToToolName alias mapping", () => {
  it.each([
    ["navigate", "browser_navigate"],
    ["goto", "browser_navigate"],
    ["open", "browser_navigate"],
    ["snapshot", "browser_snapshot"],
    ["observe", "browser_snapshot"],
    ["read", "browser_snapshot"],
    ["tabs", "browser_tabs"],
    ["list_tabs", "browser_tabs"],
    ["new_tab", "browser_tabs"],
    ["switch_tab", "browser_tabs"],
    ["click", "browser_click"],
    ["fill", "browser_fill"],
    ["type", "browser_type"],
    ["scroll", "browser_scroll"],
    ["select_option", "browser_select_option"],
    ["screenshot", "browser_take_screenshot"],
    ["press", "browser_press_key"],
    ["press_key", "browser_press_key"],
    ["highlight", "browser_highlight"],
    ["eval", "browser_cdp"],
    ["cdp", "browser_cdp"],
    ["get_html", "browser_get_html"],
    ["get_text", "browser_get_text"],
    ["reload", "browser_reload"],
    ["back", "browser_back"],
    ["forward", "browser_forward"],
  ])("maps op %s → %s", (op, tool) => {
    expect(opToToolName(op)).toBe(tool);
  });

  it("passes through already-canonical or unknown names unchanged", () => {
    expect(opToToolName("browser_navigate")).toBe("browser_navigate");
    expect(opToToolName("done")).toBe("done");
    expect(opToToolName("ask_user")).toBe("ask_user");
  });
});
