import React, { useMemo, useRef, useState } from "react";
import { Bot, Send, UserRound, Wrench } from "lucide-react";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolRuns?: AssistantToolRun[];
}

export const AssistantPanel: React.FC = () => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const history = useMemo<AssistantChatMessage[]>(
    () => messages.map((message) => ({ role: message.role, content: message.content })),
    [messages]
  );

  const sendPrompt = async () => {
    const text = prompt.trim();
    if (!text || sending) return;
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
    };
    setMessages((prev) => [...prev, userMessage]);
    setPrompt("");
    setSending(true);

    try {
      const response = await window.browserAPI?.assistant.send({
        prompt: text,
        history,
      });
      const assistantMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: response?.content || "No response.",
        toolRuns: response?.toolRuns || [],
      };
      setMessages((prev) => [...prev, assistantMessage]);
      window.requestAnimationFrame(() => {
        listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
      });
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: error instanceof Error ? error.message : String(error),
        },
      ]);
    } finally {
      setSending(false);
    }
  };

  return (
    <section className="assistant-panel">
      <div className="assistant-panel__header">
        <div className="assistant-panel__title">
          <Bot size={16} />
          <span>LM_Browser Bridge</span>
        </div>
      </div>
      <div ref={listRef} className="assistant-panel__messages">
        {messages.length === 0 && (
          <div className="assistant-panel__empty">No chat messages yet.</div>
        )}
        {messages.map((message) => (
          <div
            key={message.id}
            className={`assistant-message assistant-message--${message.role}`}
          >
            <div className="assistant-message__icon">
              {message.role === "user" ? <UserRound size={14} /> : <Bot size={14} />}
            </div>
            <div className="assistant-message__body">
              <p>{message.content}</p>
              {message.toolRuns && message.toolRuns.length > 0 && (
                <div className="assistant-message__tools">
                  <Wrench size={12} />
                  <span>{message.toolRuns.length} browser tool run{message.toolRuns.length === 1 ? "" : "s"}</span>
                </div>
              )}
            </div>
          </div>
        ))}
        {sending && (
          <div className="assistant-message assistant-message--assistant">
            <div className="assistant-message__icon">
              <Bot size={14} />
            </div>
            <div className="assistant-message__body">
              <p>Working...</p>
            </div>
          </div>
        )}
      </div>
      <div className="assistant-panel__composer">
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              sendPrompt();
            }
          }}
          placeholder="Message the connected LLM"
        />
        <button
          className="assistant-panel__send"
          onClick={sendPrompt}
          disabled={sending || !prompt.trim()}
          title="Send"
        >
          <Send size={16} />
        </button>
      </div>
    </section>
  );
};
