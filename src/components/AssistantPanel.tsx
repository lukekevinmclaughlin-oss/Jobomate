import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, Brain, FileText, Paperclip, Pause, Play, Power, Send, Square, UserRound, Wrench, X } from "lucide-react";
import { stripReasoning, friendlyError, isTransient } from "../lib/sanitize";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolRuns?: AssistantToolRun[];
  attachments?: { name: string }[];
}

interface PendingAttachment {
  id: string;
  name: string;
  size: number;
  path: string;
}

// One-line human summary of a tool call for the activity feed / details list:
// the tool name plus its most identifying argument (path, command, url, ...).
const summarizeToolRun = (run: AssistantToolRun): string => {
  const args = run.arguments || {};
  const keyArg =
    ["path", "file", "command", "url", "pattern", "from", "selector", "id", "question", "message"]
      .map((key) => args[key])
      .find((value) => typeof value === "string" && value.length > 0) as string | undefined;
  const detail = keyArg ? ` ${keyArg}` : "";
  return `${run.name}${detail}`.slice(0, 110);
};

const previewToolResult = (result: unknown): string => {
  const text = typeof result === "string" ? result : JSON.stringify(result);
  if (!text) return "";
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
};

const formatAttachmentSize = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, exp);
  return `${exp === 0 ? value : value.toFixed(1)} ${units[exp]}`;
};

export const AssistantPanel: React.FC = () => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [sending, setSending] = useState(false);
  const [paused, setPaused] = useState(false);
  const [llmEnabled, setLlmEnabled] = useState(true);
  // Live answer tokens + the model's chain-of-thought for the orange "Thinking"
  // box, both streamed in real time from the engine.
  const [streamingText, setStreamingText] = useState("");
  const [reasoning, setReasoning] = useState("");
  // Live tool activity for the in-flight run (what the agent is doing NOW).
  const [liveTools, setLiveTools] = useState<string[]>([]);
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
  const sendingRef = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);
  const reasoningRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Live streams from the engine: answer tokens, reasoning, and tool-round
  // boundaries (each new round resets the buffers so the box shows the current
  // step, not every round concatenated).
  useEffect(() => {
    const api = window.browserAPI;
    const offStream = api?.assistant.onStream?.(({ delta }) => {
      if (sendingRef.current) setStreamingText((prev) => prev + delta);
    });
    const offReason = api?.assistant.onReasoning?.(({ delta }) => {
      if (sendingRef.current) setReasoning((prev) => prev + delta);
    });
    const offTool = api?.assistant.onToolRun?.((run) => {
      if (sendingRef.current) {
        setStreamingText("");
        setReasoning("");
        const summary = summarizeToolRun(run as AssistantToolRun);
        setLiveTools((prev) => [...prev.slice(-11), summary]);
      }
    });
    return () => {
      offStream?.();
      offReason?.();
      offTool?.();
    };
  }, []);

  // Keep the reasoning box pinned to the latest thought.
  useEffect(() => {
    reasoningRef.current?.scrollTo({ top: reasoningRef.current.scrollHeight });
  }, [reasoning]);

  const history = useMemo<AssistantChatMessage[]>(
    () => messages.map((message) => ({ role: message.role, content: message.content })),
    [messages]
  );

  // Without this, dropping a file anywhere in the window makes Electron navigate
  // to file://… and blow away the app. Swallow the default drag/drop globally;
  // the composer dropzone's own handler still receives drops landing on it.
  useEffect(() => {
    const prevent = (event: DragEvent) => event.preventDefault();
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", prevent);
    return () => {
      window.removeEventListener("dragover", prevent);
      window.removeEventListener("drop", prevent);
    };
  }, []);

  const addFiles = useCallback((fileList: FileList | File[] | null) => {
    if (!fileList) return;
    const incoming: PendingAttachment[] = [];
    for (const file of Array.from(fileList)) {
      const resolvedPath =
        window.browserAPI?.files?.pathFor?.(file) ||
        (file as File & { path?: string }).path ||
        "";
      if (!resolvedPath) continue; // can't read a file we can't locate on disk
      incoming.push({ id: crypto.randomUUID(), name: file.name, size: file.size, path: resolvedPath });
    }
    if (incoming.length === 0) return;
    setAttachments((prev) => {
      const seen = new Set(prev.map((a) => a.path));
      return [...prev, ...incoming.filter((a) => !seen.has(a.path))];
    });
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const handleDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setDragOver(false);
      addFiles(event.dataTransfer?.files ?? null);
    },
    [addFiles]
  );

  const handleFileInput = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      addFiles(event.target.files);
      event.target.value = "";
    },
    [addFiles]
  );

  // The LLM on/off switch is a runtime state in main; sync it on mount.
  useEffect(() => {
    let cancelled = false;
    window.browserAPI?.assistant
      ?.controlState?.()
      .then((state) => {
        if (!cancelled && state) setLlmEnabled(state.enabled);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const stopRun = useCallback(() => {
    void window.browserAPI?.assistant?.stop?.();
    setPaused(false);
  }, []);

  const togglePause = useCallback(() => {
    setPaused((prev) => {
      const next = !prev;
      if (next) void window.browserAPI?.assistant?.pause?.();
      else void window.browserAPI?.assistant?.resume?.();
      return next;
    });
  }, []);

  const toggleLlm = useCallback(async () => {
    const next = !llmEnabled;
    setLlmEnabled(next);
    if (!next) setPaused(false);
    await window.browserAPI?.assistant?.setEnabled?.(next);
  }, [llmEnabled]);

  const sendPrompt = async () => {
    const text = prompt.trim();
    if ((!text && attachments.length === 0) || sending || !llmEnabled) return;
    const outgoing = attachments;
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: text || (outgoing.length > 0 ? "(sent attached file" + (outgoing.length > 1 ? "s" : "") + ")" : ""),
      attachments: outgoing.map((a) => ({ name: a.name })),
    };
    setMessages((prev) => [...prev, userMessage]);
    setPrompt("");
    setAttachments([]);
    setPaused(false);
    setSending(true);
    sendingRef.current = true;
    setReasoning("");
    setStreamingText("");
    setLiveTools([]);

    const sendOnce = () =>
      window.browserAPI?.assistant.send({
        prompt: text,
        history,
        attachments: outgoing.map((a) => ({ path: a.path, name: a.name, size: a.size })),
      });

    try {
      let response;
      try {
        response = await sendOnce();
      } catch (firstError) {
        // Transient failures (fetch failed / script failed) cleared on retry in
        // testing — try once more automatically before surfacing anything.
        if (!isTransient(firstError)) throw firstError;
        await new Promise((r) => setTimeout(r, 600));
        response = await sendOnce();
      }
      const assistantMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: response?.content || "No response.",
        toolRuns: response?.toolRuns || [],
      };
      // Keep the live-streamed reasoning if we got any; otherwise fall back to
      // the reasoning returned with a non-streamed response.
      setReasoning((prev) => prev || response?.reasoning || "");
      setStreamingText("");
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
          content: friendlyError(error),
        },
      ]);
    } finally {
      setSending(false);
      sendingRef.current = false;
      setPaused(false);
      setStreamingText("");
    }
  };

  return (
    <section className="assistant-panel">
      <div className="assistant-panel__header">
        <div className="assistant-panel__title">
          <Bot size={16} />
          <span>{llmEnabled ? "LM_Browser Bridge" : "LLM turned off"}</span>
        </div>
        <button
          type="button"
          className={`assistant-panel__power${llmEnabled ? " assistant-panel__power--on" : " assistant-panel__power--off"}`}
          onClick={toggleLlm}
          title={llmEnabled ? "LLM is on — click to turn it off" : "LLM is off — click to turn it on"}
          aria-pressed={llmEnabled}
          aria-label={llmEnabled ? "Turn LLM off" : "Turn LLM on"}
        >
          <Power size={14} />
        </button>
      </div>
      {reasoning.trim() && (
        <div className="assistant-reasoning" aria-label="Model reasoning">
          <div className="assistant-reasoning__head">
            <Brain size={13} />
            <span>Thinking{sending ? "…" : ""}</span>
          </div>
          <div ref={reasoningRef} className="assistant-reasoning__body">
            {reasoning}
          </div>
        </div>
      )}
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
              <p>{stripReasoning(message.content)}</p>
              {message.attachments && message.attachments.length > 0 && (
                <div className="assistant-message__attachments">
                  {message.attachments.map((attachment, index) => (
                    <span className="assistant-message__chip" key={`${attachment.name}-${index}`}>
                      <Paperclip size={11} />
                      {attachment.name}
                    </span>
                  ))}
                </div>
              )}
              {message.toolRuns && message.toolRuns.length > 0 && (
                <div className="assistant-message__toolblock">
                  <button
                    type="button"
                    className="assistant-message__tools"
                    style={{ background: "none", border: "none", padding: 0, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4, color: "inherit" }}
                    onClick={() =>
                      setExpandedTools((prev) => {
                        const next = new Set(prev);
                        if (next.has(message.id)) next.delete(message.id);
                        else next.add(message.id);
                        return next;
                      })
                    }
                    title="Show what the agent did"
                  >
                    <Wrench size={12} />
                    <span>
                      {expandedTools.has(message.id) ? "▾" : "▸"} {message.toolRuns.length} tool run{message.toolRuns.length === 1 ? "" : "s"}
                    </span>
                  </button>
                  {expandedTools.has(message.id) && (
                    <ol className="assistant-message__toollist" style={{ margin: "4px 0 0", paddingLeft: 18, fontSize: 11.5, opacity: 0.85 }}>
                      {message.toolRuns.map((run, index) => (
                        <li key={index} style={{ marginBottom: 2 }}>
                          <code>{summarizeToolRun(run)}</code>
                          {previewToolResult(run.result) && (
                            <div style={{ opacity: 0.75, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                              {previewToolResult(run.result)}
                            </div>
                          )}
                        </li>
                      ))}
                    </ol>
                  )}
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
              <p>{stripReasoning(streamingText) || "Working..."}</p>
              {liveTools.length > 0 && (
                <div className="assistant-message__live-tools" style={{ marginTop: 4, fontSize: 11.5, opacity: 0.8 }}>
                  <Wrench size={11} style={{ verticalAlign: "-1px", marginRight: 4 }} />
                  <code>{liveTools[liveTools.length - 1]}</code>
                  {liveTools.length > 1 && <span> · {liveTools.length} tool calls</span>}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      <div
        className={`assistant-panel__dropzone${dragOver ? " assistant-panel__dropzone--over" : ""}`}
        onDragOver={handleDragOver}
        onDragEnter={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {attachments.length > 0 && (
          <div className="assistant-attachments" aria-label="Attached files">
            {attachments.map((attachment) => (
              <div className="assistant-attachment" key={attachment.id} title={attachment.name}>
                <FileText size={13} />
                <span className="assistant-attachment__name">{attachment.name}</span>
                {formatAttachmentSize(attachment.size) && (
                  <span className="assistant-attachment__size">{formatAttachmentSize(attachment.size)}</span>
                )}
                <button
                  type="button"
                  className="assistant-attachment__remove"
                  onClick={() => removeAttachment(attachment.id)}
                  title="Remove attachment"
                  aria-label={`Remove ${attachment.name}`}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
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
            placeholder="Message the connected LLM, or drop a file..."
          />
          <div className="assistant-panel__composer-actions">
            <button
              type="button"
              className="assistant-panel__attach"
              onClick={() => fileInputRef.current?.click()}
              disabled={sending}
              title="Attach files"
              aria-label="Attach files"
            >
              <Paperclip size={15} />
            </button>
            {sending && (
              <button
                type="button"
                className="assistant-panel__attach"
                onClick={togglePause}
                title={paused ? "Resume the run" : "Pause between steps"}
                aria-label={paused ? "Resume" : "Pause"}
              >
                {paused ? <Play size={15} /> : <Pause size={15} />}
              </button>
            )}
            {sending ? (
              <button
                type="button"
                className="assistant-panel__send assistant-panel__send--stop"
                onClick={stopRun}
                title="Stop the LLM"
                aria-label="Stop the LLM"
              >
                <Square size={14} />
              </button>
            ) : (
              <button
                className="assistant-panel__send"
                onClick={sendPrompt}
                disabled={!llmEnabled || (!prompt.trim() && attachments.length === 0)}
                title={llmEnabled ? "Send" : "LLM is off"}
              >
                <Send size={16} />
              </button>
            )}
          </div>
        </div>
        {dragOver && <div className="assistant-panel__drop-hint">Drop files to attach them as context</div>}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="assistant-panel__file-input"
          onChange={handleFileInput}
        />
      </div>
    </section>
  );
};
