import React, {
  useCallback,
  useRef,
  useState,
  KeyboardEvent,
  useEffect,
} from "react";
import { useTabStore } from "../stores/tabStore";
import { useBookmarkStore } from "../stores/bookmarkStore";
import { useSettingsStore } from "../stores/settingsStore";
import {
  ArrowLeft,
  ArrowRight,
  RefreshCw,
  Home,
  X,
  Star,
  Copy,
  ExternalLink,
  Search,
  Globe,
  Clock,
} from "lucide-react";

interface Suggestion {
  type: "history" | "bookmark" | "search" | "url";
  title: string;
  url: string;
}

export const AddressBar: React.FC = () => {
  const { activeTabId, getActiveTab, updateTab } = useTabStore();
  const { isBookmarked, addBookmark, removeBookmark, getBookmark } =
    useBookmarkStore();
  const { settings } = useSettingsStore();

  const [value, setValue] = useState("");
  const [isFocused, setIsFocused] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [selectedSuggestion, setSelectedSuggestion] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);

  const activeTab = getActiveTab();

  // Sync input when tab changes
  useEffect(() => {
    if (activeTab) {
      setValue(activeTab.url === "about:blank" ? "" : activeTab.url);
    }
  }, [activeTab?.id, activeTab?.url]);

  const normalizeUrl = useCallback(
    (input: string): string => {
      const trimmed = input.trim();
      if (!trimmed) return "";

      // Already a valid URL
      if (
        /^https?:\/\//i.test(trimmed) ||
        /^file:\/\//i.test(trimmed) ||
        trimmed === "about:blank"
      ) {
        return trimmed;
      }

      // localhost
      if (/^localhost(:\d+)?/.test(trimmed)) {
        return "http://" + trimmed;
      }

      // IPv4
      if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?$/.test(trimmed)) {
        return "http://" + trimmed;
      }

      // Domain-like
      if (trimmed.includes(".") && !trimmed.includes(" ")) {
        return "https://" + trimmed;
      }

      // Search query
      const searchUrls: Record<string, string> = {
        google: "https://www.google.com/search?q=",
        bing: "https://www.bing.com/search?q=",
        duckduckgo: "https://duckduckgo.com/?q=",
      };
      const engine = settings.searchEngine || "google";
      const base = searchUrls[engine] || searchUrls.google;
      return base + encodeURIComponent(trimmed);
    },
    [settings.searchEngine]
  );

  const handleNavigate = useCallback(
    (url?: string) => {
      const targetUrl = normalizeUrl(url || value);
      if (!targetUrl || !activeTabId) return;

      updateTab(activeTabId, {
        url: targetUrl,
        title: targetUrl,
        isLoading: true,
      });
      setValue(targetUrl);

      // Check if browserAPI is available (Electron context)
      const api = window.browserAPI;
      if (api) {
        api.tabs.update(activeTabId, targetUrl).catch(() => {
          updateTab(activeTabId, { isLoading: false });
        });
      }
    },
    [value, activeTabId, updateTab, normalizeUrl]
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        if (selectedSuggestion >= 0 && suggestions[selectedSuggestion]) {
          handleNavigate(suggestions[selectedSuggestion].url);
        } else {
          handleNavigate();
        }
        inputRef.current?.blur();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedSuggestion((prev) =>
          Math.min(prev + 1, suggestions.length - 1)
        );
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedSuggestion((prev) => Math.max(prev - 1, -1));
      } else if (e.key === "Escape") {
        inputRef.current?.blur();
      }
    },
    [handleNavigate, selectedSuggestion, suggestions]
  );

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      setValue(val);
      setSelectedSuggestion(-1);

      // Generate suggestions
      if (val.trim()) {
        const q = val.toLowerCase();
        const historySuggestions: Suggestion[] = [];
        const bookmarkSuggestions: Suggestion[] = [];

        // Search through tabs for history
        const { tabs } = useTabStore.getState();
        for (const tab of tabs) {
          if (
            tab.url.toLowerCase().includes(q) ||
            tab.title.toLowerCase().includes(q)
          ) {
            historySuggestions.push({
              type: "history",
              title: tab.title,
              url: tab.url,
            });
          }
        }

        // Search bookmarks
        const { searchBookmarks } = useBookmarkStore.getState();
        const matches = searchBookmarks(val);
        for (const bm of matches) {
          bookmarkSuggestions.push({
            type: "bookmark",
            title: bm.title,
            url: bm.url,
          });
        }

        const allSuggestions: Suggestion[] = [
          ...bookmarkSuggestions.slice(0, 3),
          ...historySuggestions.slice(0, 5),
          { type: "search", title: `Search for "${val}"`, url: val },
        ];

        if (/^https?:\/\//i.test(val) || val.includes(".")) {
          allSuggestions.unshift({
            type: "url",
            title: `Go to ${normalizeUrl(val)}`,
            url: val,
          });
        }

        setSuggestions(allSuggestions.slice(0, 8));
      } else {
        setSuggestions([]);
      }
    },
    [normalizeUrl]
  );

  const handleFocus = useCallback(() => {
    setIsFocused(true);
    inputRef.current?.select();
    if (value) {
      handleInputChange({
        target: { value },
      } as React.ChangeEvent<HTMLInputElement>);
    }
  }, [value, handleInputChange]);

  const handleBlur = useCallback(() => {
    // Delay to allow click on suggestion
    setTimeout(() => {
      setIsFocused(false);
      setSuggestions([]);
    }, 150);
  }, []);

  const handleSuggestionClick = useCallback(
    (suggestion: Suggestion) => {
      handleNavigate(suggestion.url);
      setIsFocused(false);
      setSuggestions([]);
    },
    [handleNavigate]
  );

  const handleGoBack = useCallback(() => {
    window.browserAPI?.navigation.goBack(activeTabId || undefined).catch(() => undefined);
  }, [activeTabId]);

  const handleGoForward = useCallback(() => {
    window.browserAPI?.navigation.goForward(activeTabId || undefined).catch(() => undefined);
  }, [activeTabId]);

  const handleReload = useCallback(() => {
    window.browserAPI?.navigation.reload(activeTabId || undefined).catch(() => undefined);
  }, [activeTabId]);

  const handleHome = useCallback(() => {
    handleNavigate(settings.homepage || "https://www.google.com");
  }, [handleNavigate, settings.homepage]);

  const isCurrentUrlBookmarked = activeTab ? isBookmarked(activeTab.url) : false;

  const toggleBookmark = useCallback(() => {
    if (!activeTab) return;
    if (isCurrentUrlBookmarked) {
      const bm = getBookmark(activeTab.url);
      if (bm) removeBookmark(bm.id);
    } else {
      addBookmark(activeTab.title, activeTab.url);
    }
  }, [
    activeTab,
    isCurrentUrlBookmarked,
    addBookmark,
    removeBookmark,
    getBookmark,
  ]);

  const handleCopyUrl = useCallback(() => {
    if (activeTab?.url) {
      navigator.clipboard.writeText(activeTab.url);
    }
  }, [activeTab]);

  const handleOpenExternal = useCallback(() => {
    if (activeTab?.url) {
      window.browserAPI?.shell.openExternal(activeTab.url).catch(() => undefined);
    }
  }, [activeTab]);

  const renderSuggestionIcon = (type: Suggestion["type"]) => {
    if (type === "bookmark") return <Star size={15} fill="currentColor" />;
    if (type === "url") return <Globe size={15} />;
    if (type === "search") return <Search size={15} />;
    return <Clock size={15} />;
  };

  return (
    <div className="address-bar">
      {/* Navigation buttons */}
      <div className="address-bar__nav-buttons">
        <button
          className="address-bar__nav-btn"
          onClick={handleGoBack}
          disabled={!activeTab?.canGoBack}
          aria-label="Go back"
          title="Go back"
        >
          <ArrowLeft size={18} />
        </button>
        <button
          className="address-bar__nav-btn"
          onClick={handleGoForward}
          disabled={!activeTab?.canGoForward}
          aria-label="Go forward"
          title="Go forward"
        >
          <ArrowRight size={18} />
        </button>
        <button
          className="address-bar__nav-btn"
          onClick={handleReload}
          aria-label="Reload"
          title="Reload (⌘R)"
        >
          <RefreshCw size={16} />
        </button>
        <button
          className="address-bar__nav-btn"
          onClick={handleHome}
          aria-label="Home"
          title="Home"
        >
          <Home size={16} />
        </button>
      </div>

      {/* URL Input */}
      <div className="address-bar__input-wrapper">
        <div
          className={`address-bar__input-container ${
            isFocused ? "address-bar__input-container--focused" : ""
          }`}
        >
          {activeTab?.url && isCurrentUrlBookmarked && (
            <Star
              size={14}
              className="address-bar__bookmark-indicator"
              fill="currentColor"
            />
          )}
          <input
            ref={inputRef}
            className="address-bar__input"
            type="text"
            value={value}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onFocus={handleFocus}
            onBlur={handleBlur}
            placeholder="Search or enter URL"
            aria-label="Address bar"
            spellCheck={false}
          />
          {value && (
            <button
              className="address-bar__clear-btn"
              onClick={() => {
                setValue("");
                inputRef.current?.focus();
              }}
              aria-label="Clear address"
            >
              <X size={14} />
            </button>
          )}
        </div>

        {/* Suggestions dropdown */}
        {isFocused && suggestions.length > 0 && (
          <div className="address-bar__suggestions" role="listbox">
            {suggestions.map((suggestion, i) => (
              <div
                key={`${suggestion.type}-${i}`}
                className={`address-bar__suggestion ${
                  i === selectedSuggestion
                    ? "address-bar__suggestion--selected"
                    : ""
                }`}
                role="option"
                aria-selected={i === selectedSuggestion}
                onMouseDown={() => handleSuggestionClick(suggestion)}
                onMouseEnter={() => setSelectedSuggestion(i)}
              >
                <span className="address-bar__suggestion-icon">
                  {renderSuggestionIcon(suggestion.type)}
                </span>
                <div className="address-bar__suggestion-content">
                  <span className="address-bar__suggestion-title">
                    {suggestion.title}
                  </span>
                  <span className="address-bar__suggestion-url">
                    {suggestion.url}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Action buttons */}
      <div className="address-bar__actions">
        <button
          className="address-bar__action-btn"
          onClick={toggleBookmark}
          aria-label={
            isCurrentUrlBookmarked ? "Remove bookmark" : "Add bookmark"
          }
          title={isCurrentUrlBookmarked ? "Remove bookmark" : "Bookmark this page"}
        >
          <Star
            size={16}
            fill={isCurrentUrlBookmarked ? "currentColor" : "none"}
          />
        </button>
        <button
          className="address-bar__action-btn"
          onClick={handleCopyUrl}
          aria-label="Copy URL"
          title="Copy URL"
        >
          <Copy size={16} />
        </button>
        <button
          className="address-bar__action-btn"
          onClick={handleOpenExternal}
          aria-label="Open in default browser"
          title="Open in default browser"
        >
          <ExternalLink size={16} />
        </button>
      </div>
    </div>
  );
};
