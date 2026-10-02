"use client";

import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useSidebar } from "@/lib/sidebar-context";

/**
 * A screen's own navigation, rendered inside the app sidebar.
 *
 * The screen keeps ownership — its state, its handlers — and the content
 * is portalled into the node the sidebar lends (see `sidebar-context`).
 * Outside the app shell there is no sidebar to lend one, and the content
 * renders in place, which is what a component test sees.
 */
export function SidebarLevel({ children }: { children: ReactNode }) {
  const { slot } = useSidebar();
  if (slot === undefined) return <>{children}</>;
  if (slot === null) return null;
  return createPortal(children, slot);
}
