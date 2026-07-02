// Task-state tools: a session todo list the model uses to decompose multi-step
// work (architecture -> implementation -> testing -> delivery) and track
// progress across tool rounds. Deliberately tiny — the value is that the plan
// SURVIVES between rounds and the model can re-read it instead of losing the
// thread mid-task. In-memory, session-scoped, no approval needed (it mutates
// nothing outside the harness).

import { defineTool, type ToolHandler, type ToolModule } from "./types";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  id: number;
  text: string;
  status: TodoStatus;
}

let todos: TodoItem[] = [];

/** Test hook. */
export function resetTaskStateForTest(): void {
  todos = [];
}

function renderTodos(): string {
  if (todos.length === 0) return "Todo list is empty.";
  const mark: Record<TodoStatus, string> = { pending: "[ ]", in_progress: "[~]", completed: "[x]" };
  const done = todos.filter((t) => t.status === "completed").length;
  const lines = todos.map((t) => `${mark[t.status]} #${t.id} ${t.text}`);
  return `Todo list (${done}/${todos.length} done):\n${lines.join("\n")}`;
}

function normalizeStatus(raw: unknown): TodoStatus {
  const value = String(raw ?? "").toLowerCase().replace(/[\s-]+/g, "_");
  if (value === "completed" || value === "done" || value === "complete") return "completed";
  if (value === "in_progress" || value === "active" || value === "doing") return "in_progress";
  return "pending";
}

const todoWriteHandler: ToolHandler = async (args) => {
  const items = args.items;
  if (!Array.isArray(items)) {
    return "Error: todo_write requires 'items': an array of {text, status} replacing the whole list.";
  }
  todos = items
    .map((raw, index) => {
      const text =
        typeof raw === "string"
          ? raw
          : typeof raw?.text === "string"
          ? raw.text
          : typeof raw?.task === "string"
          ? raw.task
          : "";
      return { id: index + 1, text: text.trim(), status: normalizeStatus(raw?.status) };
    })
    .filter((t) => t.text.length > 0)
    .slice(0, 50);
  return renderTodos();
};

const todoUpdateHandler: ToolHandler = async (args) => {
  const id = Number(args.id);
  const item = todos.find((t) => t.id === id);
  if (!item) return `Error: no todo #${args.id}. Call todo_read first.`;
  if (typeof args.text === "string" && args.text.trim()) item.text = args.text.trim();
  if (args.status !== undefined) item.status = normalizeStatus(args.status);
  return renderTodos();
};

const todoReadHandler: ToolHandler = async () => renderTodos();

export const taskToolsModule: ToolModule = {
  definitions: [
    defineTool(
      "todo_write",
      "Replace the session todo list with a new plan. Use this at the START of any multi-step task to decompose it, and keep statuses current as you work — the list persists across tool rounds.",
      {
        items: {
          type: "array",
          description: "The full new list, in order.",
          items: {
            type: "object",
            properties: {
              text: { type: "string", description: "What needs to be done." },
              status: { type: "string", description: "pending | in_progress | completed (default pending)." },
            },
            required: ["text"],
          },
        },
      },
      ["items"]
    ),
    defineTool(
      "todo_update",
      "Update one todo item's status (and optionally its text) by id.",
      {
        id: { type: "number", description: "Todo id from todo_read." },
        status: { type: "string", description: "pending | in_progress | completed." },
        text: { type: "string", description: "Optional replacement text." },
      },
      ["id"]
    ),
    defineTool("todo_read", "Read the current session todo list with statuses.", {}),
  ],
  handlers: {
    todo_write: todoWriteHandler,
    todo_update: todoUpdateHandler,
    todo_read: todoReadHandler,
  },
};
