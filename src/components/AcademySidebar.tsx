import React from "react";
import {
  BarChart3,
  BookOpen,
  Download,
  Globe2,
  History,
  Home,
  ListChecks,
  Paperclip,
  Plus,
  Settings,
  Sparkles,
} from "lucide-react";

export type AcademySidebarView =
  | "workspace"
  | "browser"
  | "pipeline"
  | "tracker"
  | "bookmarks"
  | "history"
  | "downloads"
  | null;

interface AcademySidebarProps {
  brandName?: string;
  brandInitials?: string;
  onWorkspace?: () => void;
  onBrowser?: () => void;
  onPipeline?: () => void;
  onTracker?: () => void;
  onAttach?: () => void;
  onNewTab: () => void;
  onBookmarks: () => void;
  onHistory: () => void;
  onDownloads: () => void;
  onAssistant?: () => void;
  onSettings: () => void;
  activeView: AcademySidebarView;
}

/**
 * Left navigation column styled after LLM Academy (white surface, rounded pill
 * nav items, section labels, profile footer). Presentational only -- all
 * actions are delegated to the existing browser handlers, so behaviour is
 * unchanged; only the look + placement of the menu changes.
 */
export const AcademySidebar: React.FC<AcademySidebarProps> = ({
  brandName = "LLM Browser",
  brandInitials = "LB",
  onWorkspace,
  onBrowser,
  onPipeline,
  onTracker,
  onAttach,
  onNewTab,
  onBookmarks,
  onHistory,
  onDownloads,
  onAssistant,
  onSettings,
  activeView,
}) => {
  const item = (
    label: string,
    Icon: typeof Plus,
    onClick: () => void,
    active = false,
  ) => (
    <button
      type="button"
      className={`academy-nav-item${active ? " academy-nav-item--active" : ""}`}
      onClick={onClick}
    >
      <Icon strokeWidth={1.75} />
      <span>{label}</span>
    </button>
  );

  return (
    <aside className="academy-sidebar">
      <div className="academy-sidebar__brand">
        <div className="academy-sidebar__avatar" style={{ borderRadius: 10 }}>
          {brandInitials}
        </div>
        <span className="academy-sidebar__brand-name">{brandName}</span>
        <span className="academy-sidebar__badge">Beta</span>
      </div>

      <div className="academy-sidebar__section">Workspace</div>
      {item("Workspace", Home, onWorkspace ?? onNewTab, activeView === "workspace")}
      {item("Browser", Globe2, onBrowser ?? onNewTab, activeView === "browser")}
      {item("Pipeline", ListChecks, onPipeline ?? onNewTab, activeView === "pipeline")}
      {item("Tracker", BarChart3, onTracker ?? onNewTab, activeView === "tracker")}
      {onAssistant ? item("Assistant", Sparkles, onAssistant) : null}

      <div className="academy-sidebar__section">Browser tools</div>
      {item("New tab", Plus, onNewTab)}
      {item("Bookmarks", BookOpen, onBookmarks, activeView === "bookmarks")}
      {item("History", History, onHistory, activeView === "history")}
      {item("Downloads", Download, onDownloads, activeView === "downloads")}

      <div className="academy-sidebar__spacer" />

      <button
        type="button"
        className="academy-sidebar__attachment"
        onClick={onAttach}
        disabled={!onAttach}
        title="Attach a CV or role brief"
      >
        <span className="academy-sidebar__attachment-icon">
          <Paperclip size={15} />
        </span>
        <span>
          <span className="academy-sidebar__attachment-title">Attachments</span>
          <span className="academy-sidebar__attachment-sub">CV / role brief</span>
        </span>
      </button>

      {item("Settings", Settings, onSettings)}
      <button
        type="button"
        className="academy-sidebar__footer"
        onClick={onSettings}
      >
        <div className="academy-sidebar__avatar">{brandInitials}</div>
        <div style={{ textAlign: "left" }}>
          <div className="academy-sidebar__footer-name">{brandName}</div>
          <div className="academy-sidebar__footer-sub">Local</div>
        </div>
      </button>
    </aside>
  );
};
