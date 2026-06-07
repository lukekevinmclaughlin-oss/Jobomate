import React from "react";
import { useDownloadStore } from "../stores/downloadStore";
import { DownloadItem } from "../types";
import { FolderOpen, FileText, X, Ban, CheckCircle2 } from "lucide-react";

function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
}

function progress(item: DownloadItem): number {
  if (item.state === "completed") return 100;
  if (!item.totalBytes) return 0;
  return Math.min(100, Math.round((item.receivedBytes / item.totalBytes) * 100));
}

function stateLabel(item: DownloadItem): string {
  switch (item.state) {
    case "completed":
      return formatBytes(item.totalBytes || item.receivedBytes);
    case "cancelled":
      return "Cancelled";
    case "interrupted":
      return "Failed";
    default:
      return item.totalBytes
        ? `${formatBytes(item.receivedBytes)} of ${formatBytes(item.totalBytes)}`
        : formatBytes(item.receivedBytes);
  }
}

export const DownloadsPanel: React.FC = () => {
  const { items, removeItem, clearCompleted } = useDownloadStore();

  const open = (item: DownloadItem) => {
    if (item.state === "completed") {
      window.browserAPI?.downloads.open(item.path).catch(() => undefined);
    }
  };
  const reveal = (item: DownloadItem) =>
    window.browserAPI?.downloads.showInFolder(item.path).catch(() => undefined);
  const cancel = (item: DownloadItem) =>
    window.browserAPI?.downloads.cancel(item.id).catch(() => undefined);
  const openFolder = () =>
    window.browserAPI?.downloads.openFolder().catch(() => undefined);

  const hasFinished = items.some((d) => d.state !== "progressing");

  return (
    <div className="sidebar-panel">
      <div className="sidebar-panel__header">
        <h3>Downloads</h3>
        <div className="sidebar-panel__header-actions">
          <button
            className="sidebar-panel__action"
            onClick={openFolder}
            title="Open downloads folder"
          >
            <FolderOpen size={14} />
          </button>
          {hasFinished && (
            <button
              className="sidebar-panel__action"
              onClick={clearCompleted}
              title="Clear finished downloads"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {items.length === 0 ? (
        <p className="sidebar-empty">Downloaded files will appear here</p>
      ) : (
        <div className="downloads-list">
          {items.map((item) => (
            <div key={item.id} className="download-item">
              <div className="download-item__icon">
                {item.state === "completed" ? (
                  <CheckCircle2 size={18} />
                ) : (
                  <FileText size={18} />
                )}
              </div>
              <div className="download-item__body">
                <button
                  className="download-item__name"
                  onClick={() => open(item)}
                  title={item.state === "completed" ? "Open file" : item.filename}
                  disabled={item.state !== "completed"}
                >
                  {item.filename}
                </button>
                {item.state === "progressing" && (
                  <div className="download-item__bar">
                    <div
                      className="download-item__bar-fill"
                      style={{ width: `${progress(item)}%` }}
                    />
                  </div>
                )}
                <div className="download-item__meta">
                  <span>{stateLabel(item)}</span>
                  {item.state === "completed" && (
                    <button
                      className="download-item__link"
                      onClick={() => reveal(item)}
                    >
                      Show in folder
                    </button>
                  )}
                </div>
              </div>
              {item.state === "progressing" ? (
                <button
                  className="download-item__action"
                  onClick={() => cancel(item)}
                  aria-label="Cancel download"
                  title="Cancel"
                >
                  <Ban size={14} />
                </button>
              ) : (
                <button
                  className="download-item__action"
                  onClick={() => removeItem(item.id)}
                  aria-label="Remove from list"
                  title="Remove"
                >
                  <X size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
