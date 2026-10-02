"use client";

import { Bookmark, Folder as FolderIcon, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { LevelHeading, LevelRow } from "@/components/app/level-nav";
import { SidebarLevel } from "@/components/app/sidebar-level";
import type { Folder } from "@/lib/types";

/**
 * The library's own navigation, rendered into the app sidebar as its
 * second level (see `components/app/app-sidebar.tsx`).
 *
 * Bookmarks first, then the reader's folders. Bookmarks is not a folder
 * in the database — it is every saved story — but to the reader it is
 * one more list of kept stories, so it sits with the folders, pinned
 * above them, the way a music library keeps its liked songs at the top
 * of the playlists.
 *
 * Every row is a link, so history and deep links work without any
 * client state to keep in sync.
 */
export function LibraryNav({
  folders,
  current,
  bookmarkCount,
  onCreateFolder,
}: {
  folders: Folder[];
  /** `"bookmarks"`, or the id of the folder on screen. */
  current: string;
  /** Unknown on a folder's page, whose payload does not carry it. */
  bookmarkCount?: number;
  onCreateFolder: () => void;
}) {
  const t = useTranslations("libraryNav");

  return (
    <SidebarLevel>
      <div className="flex flex-col pt-1">
        <LevelRow
          href="/library"
          icon={<Bookmark size={14} strokeWidth={1.7} aria-hidden />}
          label={t("bookmarks")}
          count={bookmarkCount}
          active={current === "bookmarks"}
        />

        <LevelHeading
          action={
            <button
              type="button"
              onClick={onCreateFolder}
              aria-label={t("newFolder")}
              title={t("newFolder")}
              className="grid place-items-center w-6 h-6 rounded-md cursor-pointer text-text-3 hover:text-text hover:bg-bg-hover transition-colors"
            >
              <Plus size={13} strokeWidth={1.8} aria-hidden />
            </button>
          }
        >
          {t("folders")}
        </LevelHeading>

        {folders.length === 0 ? (
          <button
            type="button"
            onClick={onCreateFolder}
            className="px-2 py-1.5 text-left text-[12px] text-text-4 hover:text-text-2 cursor-pointer"
          >
            {t("noFolders")}
          </button>
        ) : (
          folders.map((folder) => (
            <LevelRow
              key={folder.id}
              href={`/library/${folder.id}`}
              icon={<FolderIcon size={14} strokeWidth={1.7} aria-hidden />}
              label={folder.name}
              count={folder.story_count || undefined}
              active={folder.id === current}
            />
          ))
        )}
      </div>
    </SidebarLevel>
  );
}
