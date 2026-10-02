"use client";

import {
  createContext,
  useCallback,
  useContext,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

/**
 * The app sidebar's shared state: is it collapsed, and where a screen
 * renders its own navigation into it.
 *
 * ## Collapsed
 *
 * In localStorage, and nowhere else. React subscribes to it rather than
 * keeping a copy: the preference is owned by the browser, survives
 * reloads on its own, and is shared by every tab — collapsing the
 * sidebar in one tab collapses it in the others, because they all read
 * the same value.
 *
 * The server has no localStorage, so it renders the expanded default
 * and React re-reads after hydration — one frame, invisible, and
 * declared explicitly rather than arranged by an effect.
 *
 * ## The screen's level
 *
 * The Watch and Folders screens have a navigation of their own (views,
 * facets, folders), which replaces the app's main entries in the sidebar
 * while you are on them. That navigation belongs to the screen — it
 * reads and writes the screen's state — so the screen renders it, and
 * the sidebar only lends it a place: a DOM node, `slot`, that
 * `<SidebarLevel>` portals into.
 */
const STORAGE_KEY = "veilla-sidebar-collapsed";

/** Same-tab listeners. The browser's own `storage` event fires only in
 *  *other* tabs, so a toggle here has to notify this one by hand. */
const listeners = new Set<() => void>();

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

function getSnapshot(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    // localStorage throws in privacy modes and when the quota is gone.
    // Expanded is the safe answer: a sidebar that will not collapse is
    // a nuisance, one that will not open hides navigation.
    return false;
  }
}

/** The server cannot know the preference; it renders it expanded. */
function getServerSnapshot(): boolean {
  return false;
}

function write(next: boolean) {
  try {
    window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
  } catch {
    // Same defensive reasoning as on the read side. The toggle then
    // lasts for the session only, which beats throwing at a click.
  }
  for (const listener of listeners) listener();
}

type SidebarContextType = {
  collapsed: boolean;
  toggle: () => void;
  /** Where a screen's own navigation goes. `undefined` outside the app
   *  shell (a component rendered alone, in a test), `null` until the
   *  sidebar has mounted the node. */
  slot: HTMLElement | null | undefined;
  setSlot: (node: HTMLElement | null) => void;
};

const SidebarContext = createContext<SidebarContextType>({
  collapsed: false,
  toggle: () => {},
  slot: undefined,
  setSlot: () => {},
});

export function SidebarProvider({ children }: { children: ReactNode }) {
  const collapsed = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );
  const toggle = useCallback(() => write(!getSnapshot()), []);
  // A callback ref's setter: set when the node mounts, not in an effect.
  const [slot, setSlot] = useState<HTMLElement | null>(null);

  return (
    <SidebarContext.Provider value={{ collapsed, toggle, slot, setSlot }}>
      {children}
    </SidebarContext.Provider>
  );
}

export function useSidebar() {
  return useContext(SidebarContext);
}
