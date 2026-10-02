"use client";

import { useRouter } from "next/navigation";
import { useRealtimeEvent } from "./use-realtime-event";

/**
 * Listens to the reader's Realtime row-change events and triggers a Next.js
 * `router.refresh()` so the current route's Server Components re-fetch
 * fresh data, so a change made in another tab or on another device
 * shows up here. Mounted once at the (app) layout level.
 *
 * Why router.refresh()? It re-runs the RSC fetch in the background
 * without showing a loading state — the user keeps interacting, scroll
 * position is preserved, and React reconciles only the diffed parts of
 * the DOM. Pattern recommended by Vercel for "external data mutation"
 * scenarios. When the user happens to be viewing a folder that was
 * just deleted, the refresh hits `notFound()` and the centered
 * not-found.tsx page renders — clean, no contortions needed.
 */
export function RealtimeRefresher() {
  const router = useRouter();
  const refresh = () => router.refresh();

  // Folders CRUD — the FolderPickerDialog list, the /library sidebar,
  // and folder_count badges everywhere stay accurate.
  useRealtimeEvent("folders.insert", refresh);
  useRealtimeEvent("folders.update", refresh);
  useRealtimeEvent("folders.delete", refresh);

  // Views CRUD — the Watch sidebar's saved-views section stays in sync
  // across the reader's tabs and devices.
  useRealtimeEvent("views.insert", refresh);
  useRealtimeEvent("views.update", refresh);
  useRealtimeEvent("views.delete", refresh);

  // folder_stories — story added to or removed from a folder.
  // On /library/{id} the cluster list updates live; everywhere else
  // the folder's story_count badge stays accurate.
  useRealtimeEvent("folder_stories.insert", refresh);
  useRealtimeEvent("folder_stories.delete", refresh);

  return null;
}
