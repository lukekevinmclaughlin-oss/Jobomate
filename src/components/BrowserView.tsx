import React, { useEffect, useRef } from "react";
import { useTabStore } from "../stores/tabStore";
import logoWebp from "../assets/logo.webp";
import logoPng from "../assets/logo.png";

interface BrowserViewProps {
  suspended?: boolean;
}

export const BrowserView: React.FC<BrowserViewProps> = ({ suspended = false }) => {
  const { activeTabId, tabs, addTab } = useTabStore();
  const containerRef = useRef<HTMLDivElement>(null);
  const createdInitialLocalTab = useRef(false);
  const isElectron = Boolean(window.browserAPI);

  // Ensure there's always at least one local tab when the UI is run in a browser.
  useEffect(() => {
    if (!isElectron && tabs.length === 0 && !createdInitialLocalTab.current) {
      createdInitialLocalTab.current = true;
      addTab();
    }
  }, [tabs.length, addTab, isElectron]);

  useEffect(() => {
    const api = window.browserAPI;
    const container = containerRef.current;
    if (!api || !container) return;

    const sendBounds = () => {
      if (suspended) {
        api.window.setBrowserBounds({ x: 0, y: 0, width: 0, height: 0 });
        return;
      }
      const rect = container.getBoundingClientRect();
      api.window.setBrowserBounds({
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      });
    };

    sendBounds();
    const resizeObserver = new ResizeObserver(sendBounds);
    resizeObserver.observe(container);
    window.addEventListener("resize", sendBounds);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", sendBounds);
    };
  }, [activeTabId, tabs.length, suspended]);

  const activeTab = tabs.find((t) => t.id === activeTabId);

  if (!activeTab || activeTab.url === "about:blank") {
    return (
      <div ref={containerRef} className="browser-view browser-view--new-tab">
        <div className="new-tab-page">
          <div className="new-tab-page__logo">
            <picture>
              <source srcSet={logoWebp} type="image/webp" />
              <img src={logoPng} alt="Jobomate logo" width="96" height="96" />
            </picture>
          </div>
          <h1 className="new-tab-page__title">Jobomate</h1>
          <div className="new-tab-page__llm-info">
            <p>
              Jobomate browser control:{" "}
              <code className="llm-server-badge">
                http://127.0.0.1:9222
              </code>
            </p>
          </div>
        </div>
      </div>
    );
  }

  // The BrowserView from Electron overlays this area
  return (
    <div
      ref={containerRef}
      className={`browser-view ${activeTab.isLoading ? "browser-view--loading" : ""}`}
    >
      {activeTab.isLoading && (
        <div className="browser-view__loading-bar" />
      )}
      {!isElectron && (
        <iframe
          className="browser-view__iframe"
          src={activeTab.url}
          title={activeTab.title}
          sandbox="allow-forms allow-popups allow-same-origin allow-scripts"
        />
      )}
    </div>
  );
};
