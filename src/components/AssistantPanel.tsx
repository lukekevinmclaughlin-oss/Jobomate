import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, FileText, Paperclip, Send, UserRound, Wrench, X } from "lucide-react";

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
  const listRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const sendPrompt = async () => {
    const text = prompt.trim();
    if ((!text && attachments.length === 0) || sending) return;
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
    setSending(true);

    try {
      const response = await window.browserAPI?.assistant.send({
        prompt: text,
        history,
        attachments: outgoing.map((a) => ({ path: a.path, name: a.name, size: a.size })),
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
            <button
              className="assistant-panel__send"
              onClick={sendPrompt}
              disabled={sending || (!prompt.trim() && attachments.length === 0)}
              title="Send"
            >
              <Send size={16} />
            </button>
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
