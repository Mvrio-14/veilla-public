"use client";

import * as React from "react";
import { useRealtimeContext } from "./provider";
import type {
  RealtimeConnectionState,
  RealtimeEvent,
  RealtimeEventType,
} from "./types";

/**
 * Subscribe to a single Realtime event type from inside any component
 * under `<RealtimeProvider>`. The handler fires once per matching
 * event; the subscription is automatically cleaned up on unmount or
 * when `type` / `handler` reference changes.
 *
 * Typing trick: `Extract<RealtimeEvent, { type: T }>` narrows the
 * union to the variant matching the requested type, so callers get
 * the right `row` / `old` fields without casting.
 *
 *     useRealtimeEvent("folders.insert", (event) => {
 *       // event.row is FolderRow here
 *       router.refresh();
 *     });
 */
export function useRealtimeEvent<T extends RealtimeEventType>(
  type: T,
  handler: (event: Extract<RealtimeEvent, { type: T }>) => void,
): void {
  const { subscribe } = useRealtimeContext();

  // Keep the handler in a ref so the effect doesn't re-subscribe on
  // every render — consumers usually pass an inline arrow, which has
  // a fresh identity each time. The ref reads the latest handler at
  // dispatch time.
  const handlerRef = React.useRef(handler);
  React.useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  React.useEffect(() => {
    const unsubscribe = subscribe(type, (event) => {
      handlerRef.current(event as Extract<RealtimeEvent, { type: T }>);
    });
    return unsubscribe;
  }, [type, subscribe]);
}

/** Read the current connection state (idle / connecting / connected /
 *  disconnected). Re-renders the consumer whenever the state flips. */
export function useRealtimeConnectionState(): RealtimeConnectionState {
  return useRealtimeContext().connectionState;
}
