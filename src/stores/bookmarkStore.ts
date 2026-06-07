import { create } from "zustand";
import { Bookmark, BookmarkFolder } from "../types";
import { v4 as uuidv4 } from "uuid";

interface BookmarkState {
  bookmarks: Bookmark[];
  folders: BookmarkFolder[];
  addBookmark: (title: string, url: string, folder?: string) => string;
  removeBookmark: (id: string) => void;
  updateBookmark: (id: string, updates: Partial<Bookmark>) => void;
  moveBookmark: (id: string, folder: string) => void;
  addFolder: (name: string) => string;
  removeFolder: (id: string) => void;
  renameFolder: (id: string, name: string) => void;
  isBookmarked: (url: string) => boolean;
  getBookmark: (url: string) => Bookmark | undefined;
  searchBookmarks: (query: string) => Bookmark[];
  importBookmarks: (bookmarks: Bookmark[]) => void;
  exportBookmarks: () => Bookmark[];
}

export const useBookmarkStore = create<BookmarkState>((set, get) => ({
  bookmarks: [],
  folders: [
    { id: "default", name: "Bookmarks", bookmarks: [] },
  ],

  addBookmark: (title: string, url: string, folder?: string) => {
    const id = uuidv4();
    const bookmark: Bookmark = {
      id,
      title,
      url,
      folder: folder || "default",
      createdAt: Date.now(),
    };
    set((state) => ({
      bookmarks: [...state.bookmarks, bookmark],
      folders: state.folders.map((f) =>
        f.id === (folder || "default")
          ? { ...f, bookmarks: [...f.bookmarks, bookmark] }
          : f
      ),
    }));
    return id;
  },

  removeBookmark: (id: string) => {
    set((state) => ({
      bookmarks: state.bookmarks.filter((b) => b.id !== id),
      folders: state.folders.map((f) => ({
        ...f,
        bookmarks: f.bookmarks.filter((b) => b.id !== id),
      })),
    }));
  },

  updateBookmark: (id: string, updates: Partial<Bookmark>) => {
    set((state) => ({
      bookmarks: state.bookmarks.map((b) =>
        b.id === id ? { ...b, ...updates } : b
      ),
      folders: state.folders.map((f) => ({
        ...f,
        bookmarks: f.bookmarks.map((b) =>
          b.id === id ? { ...b, ...updates } : b
        ),
      })),
    }));
  },

  moveBookmark: (id: string, folder: string) => {
    set((state) => {
      const bookmark = state.bookmarks.find((b) => b.id === id);
      if (!bookmark) return state;
      const oldFolder = bookmark.folder || "default";
      return {
        bookmarks: state.bookmarks.map((b) =>
          b.id === id ? { ...b, folder } : b
        ),
        folders: state.folders.map((f) => {
          if (f.id === oldFolder) {
            return { ...f, bookmarks: f.bookmarks.filter((b) => b.id !== id) };
          }
          if (f.id === folder) {
            return { ...f, bookmarks: [...f.bookmarks, { ...bookmark, folder }] };
          }
          return f;
        }),
      };
    });
  },

  addFolder: (name: string) => {
    const id = uuidv4();
    set((state) => ({
      folders: [...state.folders, { id, name, bookmarks: [] }],
    }));
    return id;
  },

  removeFolder: (id: string) => {
    if (id === "default") return; // Cannot remove default folder
    set((state) => {
      const folderToRemove = state.folders.find((f) => f.id === id);
      const orphaned = folderToRemove?.bookmarks || [];
      return {
        folders: state.folders.filter((f) => f.id !== id).map((f) =>
          f.id === "default"
            ? { ...f, bookmarks: [...f.bookmarks, ...orphaned] }
            : f
        ),
        bookmarks: state.bookmarks.map((b) =>
          b.folder === id ? { ...b, folder: "default" } : b
        ),
      };
    });
  },

  renameFolder: (id: string, name: string) => {
    set((state) => ({
      folders: state.folders.map((f) =>
        f.id === id ? { ...f, name } : f
      ),
    }));
  },

  isBookmarked: (url: string) => {
    return get().bookmarks.some((b) => b.url === url);
  },

  getBookmark: (url: string) => {
    return get().bookmarks.find((b) => b.url === url);
  },

  searchBookmarks: (query: string) => {
    const q = query.toLowerCase();
    return get().bookmarks.filter(
      (b) =>
        b.title.toLowerCase().includes(q) || b.url.toLowerCase().includes(q)
    );
  },

  importBookmarks: (bookmarks: Bookmark[]) => {
    set((state) => ({
      bookmarks: [...state.bookmarks, ...bookmarks],
    }));
  },

  exportBookmarks: () => {
    return get().bookmarks;
  },
}));
