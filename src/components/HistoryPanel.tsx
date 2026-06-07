import React, { useMemo, useState } from "react";
import { useHistoryStore } from "../stores/historyStore";
import { useTabStore } from "../stores/tabStore";
import { HistoryEntry } from "../types";
import { Search, Trash2, X, Clock } from "lucide-react";

function dayLabel(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (sameDay(d, today)) return "Today";
  if (sameDay(d, yesterday)) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
}

function timeLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

export const HistoryPanel: React.FC = () => {
  const { entries, removeEntry, clearHistory } = useHistoryStore();
  const { addTab } = useTabStore();
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? entries.filter(
          (e) =>
            e.title.toLowerCase().includes(q) ||
            e.url.toLowerCase().includes(q)
        )
      : entries;
    const groups: { label: string; items: HistoryEntry[] }[] = [];
    for (const entry of list) {
      const label = dayLabel(entry.visitTime);
      const last = groups[groups.length - 1];
      if (last && last.label === label) last.items.push(entry);
      else groups.push({ label, items: [entry] });
    }
    return groups;
  }, [entries, query]);

  const openEntry = (url: string) => {
    const api = window.browserAPI;
    if (api) api.tabs.create(url).catch(() => addTab(url));
    else addTab(url);
  };

  return (
    <div className="sidebar-panel">
      <div className="sidebar-panel__header">
        <h3>History</h3>
        {entries.length > 0 && (
          <button
            className="sidebar-panel__action"
            onClick={clearHistory}
            title="Clear all history"
          >
            <Trash2 size={14} />
            <span>Clear</span>
          </button>
        )}
      </div>

      {entries.length > 0 && (
        <div className="sidebar-search">
          <Search size={14} />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search history"
            aria-label="Search history"
          />
        </div>
      )}

      {filtered.length === 0 ? (
        <p className="sidebar-empty">
          {entries.length === 0
            ? "Pages you visit will appear here"
            : "No matching history"}
        </p>
      ) : (
        filtered.map((group) => (
          <div key={group.label} className="sidebar-folder">
            <h4>{group.label}</h4>
            {group.items.map((entry) => (
              <div key={entry.id} className="history-item">
                <button
                  className="history-item__link"
                  onClick={() => openEntry(entry.url)}
                  title={entry.url}
                >
                  <Clock size={14} className="history-item__icon" />
                  <span className="history-item__text">
                    <span className="history-item__title">
                      {entry.title || entry.url}
                    </span>
                    <span className="history-item__url">{entry.url}</span>
                  </span>
                  <span className="history-item__time">
                    {timeLabel(entry.visitTime)}
                  </span>
                </button>
                <button
                  className="history-item__remove"
                  onClick={() => removeEntry(entry.id)}
                  aria-label="Remove from history"
                  title="Remove"
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        ))
      )}
    </div>
  );
};
