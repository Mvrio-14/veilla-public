"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Minimal toast system — surfaces a transient feedback message at the
 * bottom of the screen. One toast at a time; a new `show()` while one
 * is visible replaces it (with restarted timer).
 *
 * Built for short positive confirmations ("Copied", "Saved") or brief
 * error notices ("Copy failed"). No stacking, no actions, no dismissal
 * buttons — just a flash of text. A richer need (action buttons,
 * multi-toast queue, persistent state) would call for a library such as
 * sonner.
 *
 * `useToast()` is tolerant: it returns a no-op stub when no provider
 * is mounted, so callers can `useToast().show(...)` safely without
 * crashing in tests or routes that haven't wired the provider yet.
 */
type ToastVariant = "default" | "error";

interface ToastState {
  message: string;
  variant: ToastVariant;
  key: number;
}

interface ToastContextValue {
  show: (message: string, variant?: ToastVariant) => void;
}

const ToastContext = React.createContext<ToastContextValue | null>(null);

const NOOP: ToastContextValue = { show: () => {} };

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toast, setToast] = React.useState<ToastState | null>(null);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = React.useCallback(
    (message: string, variant: ToastVariant = "default") => {
      if (timerRef.current) clearTimeout(timerRef.current);
      setToast({ message, variant, key: Date.now() });
      timerRef.current = setTimeout(() => setToast(null), 2500);
    },
    [],
  );

  React.useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      {toast && (
        <div
          key={toast.key}
          role="status"
          aria-live="polite"
          className={cn(
            "fixed bottom-6 left-1/2 -translate-x-1/2 z-[100]",
            "px-3.5 py-2 rounded-md shadow-lg",
            "text-[12.5px] font-medium select-none",
            "animate-in fade-in slide-in-from-bottom-2 duration-150",
            toast.variant === "error"
              ? "bg-red-600 text-white"
              : "bg-text text-bg",
          )}
        >
          {toast.message}
        </div>
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  return React.useContext(ToastContext) ?? NOOP;
}
