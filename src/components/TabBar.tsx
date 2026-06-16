import React, { useCallback, useRef, useState } from "react";
import { useTabStore } from "../stores/tabStore";
import { Plus, X } from "lucide-react";
import logoWebp from "../assets/logo.webp";
import logoPng from "../assets/logo.png";

interface TabContextMenu {
  x: number;
  y: number;
  tabId: string;
}

export const TabBar: React.FC = () => {
  const {
    tabs,
    activeTabId,
    addTab,
    removeTab,
    setActiveTab,
    closeOtherTabs,
    closeTabsToRight,
    closeAllTabs,
    duplicateTab,
  } = useTabStore();

  const [contextMenu, setContextMenu] = useState<TabContextMenu | null>(null);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const tabRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const handleTabClick = useCallback(
    (tabId: string) => {
      const api = window.browserAPI;
      if (api) {
        api.tabs.switch(tabId).catch(() => setActiveTab(tabId));
      } else {
        setActiveTab(tabId);
      }
    },
    [setActiveTab]
  );

  const handleTabClose = useCallback(
    (e: React.MouseEvent, tabId: string) => {
      e.stopPropagation();
      const api = window.browserAPI;
      if (api) {
        api.tabs.close(tabId).catch(() => removeTab(tabId));
      } else {
        removeTab(tabId);
      }
    },
    [removeTab]
  );

  const handleNewTab = useCallback(() => {
    const api = window.browserAPI;
    if (api) {
      api.tabs.create().catch(() => addTab());
    } else {
      addTab();
    }
  }, [addTab]);

  const duplicateTabById = useCallback(
    (tabId: string) => {
      const tab = tabs.find((item) => item.id === tabId);
      const api = window.browserAPI;
      if (api) {
        api.tabs.create(tab?.url).catch(() => duplicateTab(tabId));
      } else {
        duplicateTab(tabId);
      }
    },
    [duplicateTab, tabs]
  );

  const closeTabIds = useCallback(
    (tabIds: string[]) => {
      const api = window.browserAPI;
      if (api) {
        tabIds.forEach((tabId) => {
          api.tabs.close(tabId).catch(() => undefined);
        });
        return;
      }
      tabIds.forEach(removeTab);
    },
    [removeTab]
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, tabId: string) => {
      e.preventDefault();
      setContextMenu({ x: e.clientX, y: e.clientY, tabId });
    },
    []
  );

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  // Close context menu on click outside
  React.useEffect(() => {
    const handler = () => closeContextMenu();
    if (contextMenu) {
      document.addEventListener("click", handler);
      return () => document.removeEventListener("click", handler);
    }
  }, [contextMenu, closeContextMenu]);

  // Drag and drop
  const handleDragStart = useCallback(
    (e: React.DragEvent, index: number) => {
      setDraggingIndex(index);
      e.dataTransfer.effectAllowed = "move";
    },
    []
  );

  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverIndex(index);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent, toIndex: number) => {
      e.preventDefault();
      const { moveTab } = useTabStore.getState();
      if (draggingIndex !== null && draggingIndex !== toIndex) {
        moveTab(draggingIndex, toIndex);
      }
      setDraggingIndex(null);
      setDragOverIndex(null);
    },
    [draggingIndex]
  );

  const handleDragEnd = useCallback(() => {
    setDraggingIndex(null);
    setDragOverIndex(null);
  }, []);

  if (tabs.length === 0) {
    return (
      <div className="tab-bar tab-bar--empty">
        <div className="tab-bar__brand" title="Jobomate">
          <picture>
            <source srcSet={logoWebp} type="image/webp" />
            <img src={logoPng} alt="Jobomate logo" width="20" height="20" />
          </picture>
        </div>
        <button className="tab-bar__new-tab-btn" onClick={handleNewTab}>
          <Plus size={16} />
        </button>
      </div>
    );
  }

  return (
    <div className="tab-bar" role="tablist" aria-label="Browser tabs">
      <div className="tab-bar__brand" title="Jobomate">
        <picture>
          <source srcSet={logoWebp} type="image/webp" />
          <img src={logoPng} alt="Jobomate logo" width="20" height="20" />
        </picture>
      </div>
      <div className="tab-bar__tabs">
        {tabs.map((tab, index) => {
          const isActive = tab.id === activeTabId;
          const isDragOver = dragOverIndex === index;

          return (
            <div
              key={tab.id}
              ref={(el) => el && tabRefs.current.set(tab.id, el)}
              className={`tab ${isActive ? "tab--active" : ""} ${
                isDragOver ? "tab--drag-over" : ""
              }`}
              role="tab"
              aria-selected={isActive}
              aria-label={tab.title}
              draggable
              onClick={() => handleTabClick(tab.id)}
              onContextMenu={(e) => handleContextMenu(e, tab.id)}
              onDragStart={(e) => handleDragStart(e, index)}
              onDragOver={(e) => handleDragOver(e, index)}
              onDrop={(e) => handleDrop(e, index)}
              onDragEnd={handleDragEnd}
            >
              {tab.favicon ? (
                <img
                  className="tab__favicon"
                  src={tab.favicon}
                  alt=""
                  width={16}
                  height={16}
                />
              ) : (
                <div className="tab__favicon tab__favicon--placeholder" />
              )}
              <span className="tab__title">{tab.title || "New Tab"}</span>
              {tab.isLoading && (
                <div className="tab__spinner" aria-label="Loading" />
              )}
              <button
                className="tab__close"
                onClick={(e) => handleTabClose(e, tab.id)}
                aria-label={`Close ${tab.title}`}
                title="Close tab"
              >
                <X size={14} />
              </button>
            </div>
          );
        })}
      </div>

      <button
        className="tab-bar__new-tab-btn"
        onClick={handleNewTab}
        aria-label="New tab"
        title="New tab (⌘T)"
      >
        <Plus size={16} />
      </button>

      {/* Context Menu */}
      {contextMenu && (
        <div
          className="tab-context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          role="menu"
        >
          <button
            className="tab-context-menu__item"
            role="menuitem"
            onClick={() => {
              duplicateTabById(contextMenu.tabId);
              closeContextMenu();
            }}
          >
            Duplicate
          </button>
          <button
            className="tab-context-menu__item"
            role="menuitem"
            onClick={() => {
              const api = window.browserAPI;
              if (api) {
                closeTabIds(
                  tabs
                    .filter((tab) => tab.id !== contextMenu.tabId)
                    .map((tab) => tab.id)
                );
              } else {
                closeOtherTabs(contextMenu.tabId);
              }
              closeContextMenu();
            }}
          >
            Close other tabs
          </button>
          <button
            className="tab-context-menu__item"
            role="menuitem"
            onClick={() => {
              const index = tabs.findIndex((tab) => tab.id === contextMenu.tabId);
              const api = window.browserAPI;
              if (api && index >= 0) {
                closeTabIds(tabs.slice(index + 1).map((tab) => tab.id));
              } else {
                closeTabsToRight(contextMenu.tabId);
              }
              closeContextMenu();
            }}
          >
            Close tabs to the right
          </button>
          <div className="tab-context-menu__divider" />
          <button
            className="tab-context-menu__item"
            role="menuitem"
            onClick={() => {
              const api = window.browserAPI;
              if (api) {
                closeTabIds(tabs.map((tab) => tab.id));
              } else {
                closeAllTabs();
              }
              closeContextMenu();
            }}
          >
            Close all tabs
          </button>
        </div>
      )}
    </div>
  );
};
