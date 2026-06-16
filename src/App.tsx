import React, { useState, useEffect, useCallback, useRef } from "react";
import { TabBar } from "./components/TabBar";
import { AddressBar } from "./components/AddressBar";
import { BrowserView } from "./components/BrowserView";
import { BookmarkBar } from "./components/BookmarkBar";
import { LLMStatus } from "./components/LLMStatus";
import { SettingsPanel } from "./components/SettingsPanel";
import { AcademySidebar } from "./components/AcademySidebar";
import { JobomatePanel } from "./jobomate/JobomatePanel";
import { HistoryPanel } from "./components/HistoryPanel";
import { DownloadsPanel } from "./components/DownloadsPanel";
import { useTabStore } from "./stores/tabStore";
import { useSettingsStore } from "./stores/settingsStore";
import { useBookmarkStore } from "./stores/bookmarkStore";
import { useHistoryStore } from "./stores/historyStore";
import { useDownloadStore } from "./stores/downloadStore";
import {
  Settings,
  BookOpen,
  History,
  Download,
} from "lucide-react";

const App: React.FC = () => {
  const [showSettings, setShowSettings] = useState(false);
  const [showSidebar, setShowSidebar] = useState(false);
  const [sidebarView, setSidebarView] = useState<
    "bookmarks" | "history" | "downloads"
  >("bookmarks");

  // User-resizable Jobomate pane (drag the divider between the browser and the panel).
  const [paneWidth, setPaneWidth] = useState(() => {
    const saved = Number(localStorage.getItem("jbm_pane_w"));
    return saved >= 300 && saved <= 1000 ? saved : 400;
  });
  const [draggingPane, setDraggingPane] = useState(false);
  const paneWidthRef = useRef(paneWidth);
  paneWidthRef.current = paneWidth;

  const startPaneDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setDraggingPane(true);
    const startX = e.clientX;
    const startW = paneWidthRef.current;
    const onMove = (ev: MouseEvent) => {
      const max = Math.min(window.innerWidth - 360, 1000);
      setPaneWidth(Math.min(Math.max(startW + (startX - ev.clientX), 300), max));
    };
    const onUp = () => {
      setDraggingPane(false);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      localStorage.setItem("jbm_pane_w", String(paneWidthRef.current));
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, []);

  const { addTab, removeTab, setActiveTab, syncTabs, upsertTab, getActiveTab } =
    useTabStore();
  const { settings } = useSettingsStore();
  const { bookmarks, folders } = useBookmarkStore();
  const addVisit = useHistoryStore((s) => s.addVisit);
  const upsertDownload = useDownloadStore((s) => s.upsert);
  const syncDownloads = useDownloadStore((s) => s.syncActive);
  const lastVisitRef = useRef<Map<string, string>>(new Map());

  const createNewTab = useCallback(() => {
    const api = window.browserAPI;
    if (api) {
      api.tabs.create().then(upsertTab).catch(() => undefined);
    } else {
      addTab();
    }
  }, [addTab, upsertTab]);

  const closeActiveTab = useCallback(() => {
    const activeTab = getActiveTab();
    const api = window.browserAPI;
    if (api) {
      api.tabs.close(activeTab?.id).catch(() => undefined);
    } else if (activeTab) {
      removeTab(activeTab.id);
    }
  }, [getActiveTab, removeTab]);

  // Keep renderer tab state synchronized with Electron's BrowserViews.
  useEffect(() => {
    const api = window.browserAPI;
    if (!api) return;

    // Record a history entry once per committed page load (deduped per tab).
    const recordVisit = (tab: { id: string; url: string; title: string; isLoading: boolean }) => {
      if (tab.isLoading || !/^https?:\/\//i.test(tab.url)) return;
      if (lastVisitRef.current.get(tab.id) === tab.url) return;
      lastVisitRef.current.set(tab.id, tab.url);
      addVisit(tab.url, tab.title);
    };

    let cancelled = false;
    const disposers = [
      api.onTabCreated((tab) => upsertTab(tab)),
      api.onTabUpdated((tab) => {
        upsertTab(tab);
        recordVisit(tab);
      }),
      api.onTabSwitched((tab) => {
        upsertTab(tab);
        setActiveTab(tab.id);
      }),
      api.onTabClosed(({ tabId, newActiveTabId }) => {
        removeTab(tabId);
        lastVisitRef.current.delete(tabId);
        if (newActiveTabId) setActiveTab(newActiveTabId);
      }),
    ];

    api.tabs
      .list()
      .then((tabs) => {
        if (!cancelled) syncTabs(tabs);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      disposers.forEach((dispose) => dispose());
    };
  }, [removeTab, setActiveTab, syncTabs, upsertTab, addVisit]);

  // Track downloads from the main process.
  useEffect(() => {
    const api = window.browserAPI;
    if (!api?.downloads) return;

    let cancelled = false;
    api.downloads
      .list()
      .then((items) => {
        if (!cancelled) syncDownloads(items);
      })
      .catch(() => undefined);

    const disposers = [
      api.onDownloadStarted((item) => upsertDownload(item)),
      api.onDownloadUpdated((item) => upsertDownload(item)),
    ];
    return () => {
      cancelled = true;
      disposers.forEach((dispose) => dispose());
    };
  }, [syncDownloads, upsertDownload]);

  // Listen for keyboard shortcuts from main process
  useEffect(() => {
    const handleShortcut = (shortcut: string) => {
      switch (shortcut) {
        case "shortcut:new-tab":
          createNewTab();
          break;
        case "shortcut:close-tab":
          closeActiveTab();
          break;
        case "shortcut:focus-address-bar": {
          const input = document.querySelector(
            ".address-bar__input"
          ) as HTMLInputElement;
          input?.focus();
          break;
        }
        case "shortcut:toggle-settings":
          setShowSettings((prev) => !prev);
          break;
        case "shortcut:toggle-sidebar":
          setShowSidebar((prev) => !prev);
          break;
      }
    };

    const api = window.browserAPI;
    if (!api?.onShortcut) return;
    return api.onShortcut(handleShortcut);
  }, [closeActiveTab, createNewTab]);

  // Tag the root with the host platform so the UI can reserve space for the
  // macOS traffic-light window controls (which overlay the tab bar).
  useEffect(() => {
    const platform = window.browserAPI?.platform;
    document.documentElement.dataset.platform = platform ?? "web";
  }, []);

  // Apply theme
  useEffect(() => {
    const root = document.documentElement;
    if (settings.theme === "dark") {
      root.classList.add("dark");
      root.classList.remove("light");
    } else if (settings.theme === "light") {
      root.classList.add("light");
      root.classList.remove("dark");
    } else {
      root.classList.remove("dark", "light");
      // System preference
      if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
        root.classList.add("dark");
      }
    }
  }, [settings.theme]);

  const handleSidebarToggle = useCallback(
    (view: "bookmarks" | "history" | "downloads") => {
      if (showSidebar && sidebarView === view) {
        setShowSidebar(false);
      } else {
        setSidebarView(view);
        setShowSidebar(true);
      }
    },
    [showSidebar, sidebarView]
  );

  return (
    <div className="academy-shell">
      <AcademySidebar
        brandName="Jobomate"
        brandInitials="J"
        onNewTab={createNewTab}
        onBookmarks={() => handleSidebarToggle("bookmarks")}
        onHistory={() => handleSidebarToggle("history")}
        onDownloads={() => handleSidebarToggle("downloads")}
        onSettings={() => setShowSettings(true)}
        activeView={showSidebar ? sidebarView : null}
      />
    <div className="app">
      {/* Tab Bar */}
      <div className="app__tab-bar">
        <TabBar />
      </div>

      {/* Toolbar */}
      <div className="app__toolbar">
        <div className="app__toolbar-left">
          <AddressBar />
        </div>
        <div className="app__toolbar-right">
          <LLMStatus />
          <button
            className="toolbar-btn"
            onClick={() => handleSidebarToggle("bookmarks")}
            title="Bookmarks"
          >
            <BookOpen size={18} />
          </button>
          <button
            className="toolbar-btn"
            onClick={() => handleSidebarToggle("history")}
            title="History"
          >
            <History size={18} />
          </button>
          <button
            className="toolbar-btn"
            onClick={() => handleSidebarToggle("downloads")}
            title="Downloads"
          >
            <Download size={18} />
          </button>
          <button
            className="toolbar-btn"
            onClick={() => setShowSettings((prev) => !prev)}
            title="Settings"
          >
            <Settings size={18} />
          </button>
        </div>
      </div>

      {/* Bookmark Bar */}
      {settings.showBookmarkBar && (
        <div className="app__bookmark-bar">
          <BookmarkBar />
        </div>
      )}

      {/* Main Content */}
      <div className="app__content">
        <div className="app__main-stack">
          {/* Hide the native browser while dragging so the cursor keeps tracking over it. */}
          <BrowserView suspended={showSettings || draggingPane} />
        </div>

        {/* Drag this divider to resize the Jobomate panel ↔ browser, like a window edge. */}
        <div
          className={`app__resizer-h ${draggingPane ? "is-dragging" : ""}`}
          onMouseDown={startPaneDrag}
          title="Drag to resize"
        />

        {/* Jobomate workspace — the job-automation copilot, always docked on the right */}
        <div className="app__jbm-pane" style={{ width: paneWidth }}>
          <JobomatePanel />
        </div>

        {/* Sidebar */}
        {showSidebar && (
          <div className="app__sidebar">
            {sidebarView === "bookmarks" && (
              <div className="sidebar-panel">
                <h3>Bookmarks</h3>
                {folders.map((folder) => (
                  <div key={folder.id} className="sidebar-folder">
                    <h4>{folder.name}</h4>
                    {bookmarks
                      .filter((b) => (b.folder || "default") === folder.id)
                      .map((b) => (
                        <button
                          key={b.id}
                          className="sidebar-bookmark"
                          onClick={() => {
                            const api = window.browserAPI;
                            if (api) {
                              api.tabs.create(b.url).then(upsertTab).catch(() => undefined);
                            } else {
                              addTab(b.url);
                            }
                          }}
                          title={b.url}
                        >
                          <span>{b.title}</span>
                        </button>
                      ))}
                  </div>
                ))}
              </div>
            )}
            {sidebarView === "history" && <HistoryPanel />}
            {sidebarView === "downloads" && <DownloadsPanel />}
          </div>
        )}
      </div>

      {/* Settings Modal */}
      {showSettings && (
        <div className="app__settings-overlay">
          <SettingsPanel onClose={() => setShowSettings(false)} />
        </div>
      )}
    </div>
    </div>
  );
};

export default App;
