"use client";

import type { ReactNode } from "react";
import { AppSidebar } from "./app-sidebar";
import { AppTopbar } from "./app-topbar";
import { SidebarProvider } from "@/lib/sidebar-context";

/**
 * Client-side shell wrapping every authenticated route: the sidebar on
 * the left, full height, and to its right the topbar above the screen.
 * The provider shares the sidebar's state with the topbar's toggle and
 * with the screens that render a level of their own into it.
 *
 * The actual `requireSession()` auth gate stays in the server-side
 * layout — this shell is purely about layout and client state.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <SidebarProvider>
      <div className="h-screen flex bg-bg text-text">
        <AppSidebar />
        <div className="flex-1 flex flex-col min-w-0">
          <AppTopbar />
          <div className="flex-1 flex min-h-0">{children}</div>
        </div>
      </div>
    </SidebarProvider>
  );
}
