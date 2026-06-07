import React, { useState } from "react";
import { useBookmarkStore } from "../stores/bookmarkStore";
import { useTabStore } from "../stores/tabStore";
import { Bookmark } from "../types";
import { ChevronDown, MoreHorizontal, Trash2 } from "lucide-react";

export const BookmarkBar: React.FC = () => {
  const { bookmarks, folders, removeBookmark } = useBookmarkStore();
  const { addTab } = useTabStore();
  const [openFolder, setOpenFolder] = useState<string | null>(null);
  const [contextBookmark, setContextBookmark] = useState<string | null>(null);

  if (bookmarks.length === 0) return null;

  const handleBookmarkClick = (bookmark: Bookmark) => {
    const api = window.browserAPI;
    if (api) {
      api.tabs.create(bookmark.url).catch(() => undefined);
    } else {
      addTab(bookmark.url);
    }
  };

  const handleContextMenu = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    setContextBookmark(id);
  };

  return (
    <div className="bookmark-bar">
      {folders.map((folder) => {
        const folderBookmarks = bookmarks.filter(
          (b) => (b.folder || "default") === folder.id
        );
        if (folderBookmarks.length === 0) return null;

        return (
          <div key={folder.id} className="bookmark-bar__folder">
            <button
              className="bookmark-bar__folder-btn"
              onClick={() =>
                setOpenFolder(openFolder === folder.id ? null : folder.id)
              }
            >
              <span>{folder.name}</span>
              <ChevronDown
                size={12}
                className={`bookmark-bar__folder-arrow ${
                  openFolder === folder.id
                    ? "bookmark-bar__folder-arrow--open"
                    : ""
                }`}
              />
            </button>

            {openFolder === folder.id && (
              <div className="bookmark-bar__dropdown">
                {folderBookmarks.map((bookmark) => (
                  <div
                    key={bookmark.id}
                    className="bookmark-bar__dropdown-item"
                    onClick={() => {
                      handleBookmarkClick(bookmark);
                      setOpenFolder(null);
                    }}
                    onContextMenu={(e) => handleContextMenu(e, bookmark.id)}
                  >
                    <span className="bookmark-bar__dropdown-title">
                      {bookmark.title}
                    </span>
                    <span className="bookmark-bar__dropdown-url">
                      {bookmark.url}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {/* Show first 10 bookmarks directly */}
      {bookmarks.slice(0, 10).map((bookmark) => (
        <button
          key={bookmark.id}
          className="bookmark-bar__item"
          onClick={() => handleBookmarkClick(bookmark)}
          onContextMenu={(e) => handleContextMenu(e, bookmark.id)}
          title={`${bookmark.title}\n${bookmark.url}`}
        >
          <span className="bookmark-bar__item-text">{bookmark.title}</span>
        </button>
      ))}

      {bookmarks.length > 10 && (
        <button
          className="bookmark-bar__more-btn"
          title="More bookmarks"
        >
          <MoreHorizontal size={14} />
        </button>
      )}

      {/* Context menu */}
      {contextBookmark && (
        <div
          className="bookmark-bar__context-menu"
          style={{ position: "fixed", top: "auto", left: "auto" }}
          onClick={() => setContextBookmark(null)}
        >
          <button
            onClick={() => {
              removeBookmark(contextBookmark);
              setContextBookmark(null);
            }}
          >
            <Trash2 size={14} />
            <span>Delete</span>
          </button>
        </div>
      )}
    </div>
  );
};
