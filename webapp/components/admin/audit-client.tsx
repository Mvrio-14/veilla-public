"use client";

import * as React from "react";
import {
  type AdminAuditRow,
  type AdminUser,
  listAudit,
  listUsers,
} from "@/lib/admin/api";
import { cn } from "@/lib/utils";
import { useChanged } from "@/lib/use-changed";


/**
 * /admin/audit main client.
 *
 * Dev-grade table: every audit row, filterable by actor / action /
 * target_type / target_id. Click a row to inspect its payload as
 * pretty-printed JSON. Cursor pagination via `before_id`.
 *
 * Filters reset the page accumulator — changing any filter restarts the
 * scroll from the most recent matching row.
 */
export function AuditClient() {
  const [actions, setActions]   = React.useState<AdminAuditRow[]>([]);
  const [users, setUsers]       = React.useState<AdminUser[]>([]);
  const [loading, setLoading]   = React.useState(true);
  const [error, setError]       = React.useState<string | null>(null);
  const [hasMore, setHasMore]   = React.useState(false);
  const [selectedRow, setSelectedRow] = React.useState<AdminAuditRow | null>(null);

  // Filter state — string-only so we can serialize directly to the
  // URLSearchParams. Empty string = no filter on that axis.
  const [actorId,    setActorId]    = React.useState("");
  const [actionType, setActionType] = React.useState("");
  const [targetType, setTargetType] = React.useState("");
  const [targetId,   setTargetId]   = React.useState("");

  /** Entering the loading state is a consequence of the filters
   *  changing, so it is decided here rather than announced by the
   *  effect below. `loading` already starts true, which covers the
   *  first load; this covers every later one. */
  const filterKey = [actorId, actionType, targetType, targetId].join("|");
  if (useChanged(filterKey)) {
    setLoading(true);
    setError(null);
  }



  /** Append next page using `before_id` from the last visible row. */
  const loadMore = React.useCallback(async () => {
    if (actions.length === 0) return;
    const lastId = actions[actions.length - 1].id;
    setLoading(true);
    setError(null);
    try {
      const r = await listAudit({
        actor_user_id: actorId    || undefined,
        action:        actionType || undefined,
        target_type:   targetType || undefined,
        target_id:     targetId   || undefined,
        before_id:     lastId,
        limit:         100,
      });
      setActions((prev) => [...prev, ...r.actions]);
      setHasMore(r.has_more);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load more");
    } finally {
      setLoading(false);
    }
  }, [actions, actorId, actionType, targetType, targetId]);

  /** Load page 1 on arrival, and again whenever a filter changes.
   *
   *  Written inline rather than delegated to a callback: this is the
   *  only caller, and keeping the request here means state is only ever
   *  updated from a promise callback, never on the way in. */
  React.useEffect(() => {
    let alive = true;
    listAudit({
      actor_user_id: actorId    || undefined,
      action:        actionType || undefined,
      target_type:   targetType || undefined,
      target_id:     targetId   || undefined,
      limit:         100,
    })
      .then((r) => {
        if (!alive) return;
        setActions(r.actions);
        setHasMore(r.has_more);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : "Failed to load");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    // Typing in a filter fires a request per keystroke; without this,
    // an early response could land after a later one and show stale rows.
    return () => {
      alive = false;
    };
  }, [actorId, actionType, targetType, targetId]);

  // Refresh user list once so the actor filter dropdown has friendly names.
  React.useEffect(() => {
    void listUsers().then(setUsers).catch(() => { /* fail silently */ });
  }, []);

  // Distinct action verbs / target types seen in the current page —
  // dropdown options. Recomputed when the dataset changes; small set so
  // O(N) is fine.
  const distinctActions = React.useMemo(() => {
    const set = new Set<string>();
    for (const a of actions) set.add(a.action);
    return [...set].sort();
  }, [actions]);

  const distinctTargetTypes = React.useMemo(() => {
    const set = new Set<string>();
    for (const a of actions) set.add(a.target_type);
    return [...set].sort();
  }, [actions]);

  const actorOptions = React.useMemo(() => {
    // Build from the users list (covers actors not yet present in the
    // visible page). Only show users who have actually done something
    // to keep the dropdown short — fall back to "all users" when the
    // audit log filter is empty (= first paint).
    const actorsInPage = new Set<string>();
    for (const a of actions) if (a.actor_user_id) actorsInPage.add(a.actor_user_id);
    const candidates = users.filter((u) => actorsInPage.has(u.id));
    if (candidates.length === 0) return users;
    return candidates;
  }, [actions, users]);

  return (
    <div className="space-y-3">
      <header>
        <h1 className="text-[16px] font-bold uppercase tracking-wider">
          Audit log
        </h1>
        <p className="text-text-3 text-[12px]">
          Every admin mutation, newest first. Click a row to inspect the payload.
          {loading && " · loading…"}
          {error && <span className="text-bad ml-2">· {error}</span>}
        </p>
      </header>

      {/* Filter bar — sticky-ish at the top of the page */}
      <div className="border border-border rounded p-2 bg-bg-sub flex flex-wrap gap-2 items-end text-[12px]">
        <FilterField label="Actor">
          <select
            value={actorId}
            onChange={(e) => setActorId(e.target.value)}
            className="px-2 py-1 rounded border border-border bg-bg text-text font-mono text-[11.5px]"
          >
            <option value="">all</option>
            {actorOptions.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name || u.slug} ({u.email})
              </option>
            ))}
          </select>
        </FilterField>

        <FilterField label="Action">
          <select
            value={actionType}
            onChange={(e) => setActionType(e.target.value)}
            className="px-2 py-1 rounded border border-border bg-bg text-text font-mono text-[11.5px]"
          >
            <option value="">all</option>
            {distinctActions.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
        </FilterField>

        <FilterField label="Target type">
          <select
            value={targetType}
            onChange={(e) => setTargetType(e.target.value)}
            className="px-2 py-1 rounded border border-border bg-bg text-text font-mono text-[11.5px]"
          >
            <option value="">all</option>
            {/* Static options + whatever's in the page. Static covers
             *  filter-from-nothing cases. */}
            {["feed", "source", "user"]
              .concat(distinctTargetTypes.filter((t) => !["feed", "source", "user"].includes(t)))
              .map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
          </select>
        </FilterField>

        <FilterField label="Target ID">
          <input
            type="text"
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
            placeholder="e.g. 42"
            className="px-2 py-1 rounded border border-border bg-bg text-text font-mono text-[11.5px] w-32"
          />
        </FilterField>

        <button
          type="button"
          onClick={() => {
            setActorId(""); setActionType(""); setTargetType(""); setTargetId("");
          }}
          className="px-2 py-1 rounded border border-border uppercase tracking-wider text-[11px]"
        >
          Clear
        </button>
      </div>

      {/* Table — fills the remaining viewport height with its own scroll */}
      <div className="border border-border rounded overflow-auto" style={{ maxHeight: "calc(100vh - 260px)" }}>
        <table className="w-full text-[12px]">
          <thead className="bg-bg-sub border-b border-border sticky top-0">
            <tr className="text-left uppercase tracking-wider text-[10.5px] text-text-3">
              <th className="px-2 py-1.5 w-44">Time</th>
              <th className="px-2 py-1.5 w-44">Actor</th>
              <th className="px-2 py-1.5 w-56">Action</th>
              <th className="px-2 py-1.5 w-32">Target</th>
              <th className="px-2 py-1.5">Payload preview</th>
            </tr>
          </thead>
          <tbody>
            {actions.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-text-3 text-center italic">
                  {loading ? "Loading…" : "No audit rows match these filters."}
                </td>
              </tr>
            ) : actions.map((a) => (
              <AuditRow
                key={a.id}
                row={a}
                onClick={() => setSelectedRow(a)}
              />
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-[12px]">
        <span className="text-text-3">{actions.length} rows loaded</span>
        {hasMore && (
          <button
            type="button"
            onClick={loadMore}
            disabled={loading}
            className="px-3 py-1 rounded border border-border uppercase tracking-wider text-[11.5px] disabled:opacity-50"
          >
            {loading ? "Loading…" : "Load more"}
          </button>
        )}
      </div>

      {selectedRow && (
        <PayloadModal row={selectedRow} onClose={() => setSelectedRow(null)} />
      )}
    </div>
  );
}


function FilterField({
  label, children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="text-[9.5px] uppercase tracking-wider text-text-3 block mb-0.5">
        {label}
      </label>
      {children}
    </div>
  );
}


function AuditRow({
  row, onClick,
}: {
  row: AdminAuditRow;
  onClick: () => void;
}) {
  // "5m ago" style relative time + an absolute on hover (title attribute).
  const when = formatWhen(row.created_at);
  const actorLabel = row.actor_name || row.actor_slug || row.actor_email || "(unknown)";

  // Preview = single-line summary of the payload. We pick the most
  // informative key by convention: `added`+`removed` for diffs,
  // `before/after` for updates, `data` for creates/deletes.
  const preview = describePayload(row.payload);

  return (
    <tr
      className="border-b border-border/30 hover:bg-bg-hover cursor-pointer"
      onClick={onClick}
    >
      <td className="px-2 py-1 text-text-3 tabular-nums" title={row.created_at ?? ""}>
        {when}
      </td>
      <td className="px-2 py-1 truncate" title={row.actor_email ?? ""}>
        {actorLabel}
      </td>
      <td className="px-2 py-1 font-mono text-[11px]">
        <ActionBadge action={row.action} />
      </td>
      <td className="px-2 py-1 text-text-3 font-mono text-[11px]">
        {row.target_type}
        {row.target_id && (
          <span className="text-text-4"> · {row.target_id}</span>
        )}
      </td>
      <td className="px-2 py-1 text-text-3 truncate max-w-[600px]" title={preview}>
        {preview}
      </td>
    </tr>
  );
}


function ActionBadge({ action }: { action: string }) {
  // Colour by verb family so the table is scannable. Soft-delete / kill
  // verbs in red, create in green, update / set in default.
  const family =
    action.startsWith("create_")        ? "create" :
    action.startsWith("soft_delete_")
      || action.startsWith("hard_delete_")
      || action.startsWith("remove_")    ? "delete" :
    action.startsWith("resurrect_")     ? "resurrect" :
    action.startsWith("update_")        ? "update" :
    action.startsWith("set_")           ? "set"    :
    action.startsWith("add_")           ? "add"    :
                                          "other";
  const cls = {
    create:    "text-good",
    delete:    "text-bad",
    resurrect: "text-good",
    update:    "text-text",
    set:       "text-text-2",
    add:       "text-good",
    other:     "text-text-3",
  }[family];
  return <span className={cn("font-bold", cls)}>{action}</span>;
}


function PayloadModal({
  row, onClose,
}: {
  row: AdminAuditRow;
  onClose: () => void;
}) {
  const pretty = JSON.stringify(row.payload ?? {}, null, 2);
  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-bg border border-border rounded w-[820px] max-h-[80vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-4 py-3 border-b border-border flex justify-between items-center">
          <div>
            <h2 className="font-bold uppercase tracking-wider">
              {row.action}
            </h2>
            <div className="text-text-3 text-[11.5px] mt-0.5">
              {row.target_type}{row.target_id ? ` · ${row.target_id}` : ""}
              {" · by "}
              {row.actor_name || row.actor_slug || "(unknown)"}
              {row.actor_email ? ` (${row.actor_email})` : ""}
              {" · "}
              {row.created_at ? new Date(row.created_at).toLocaleString() : "—"}
            </div>
          </div>
          <button type="button" onClick={onClose} className="text-text-3 hover:text-text">✕</button>
        </header>
        <div className="p-4 text-[11.5px]">
          {pretty === "{}" ? (
            <div className="italic text-text-3">(no payload)</div>
          ) : (
            <pre className="font-mono whitespace-pre-wrap break-all bg-bg-sub p-3 rounded border border-border">
              {pretty}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}


// ── Formatters ──────────────────────────────────────────────────────────
function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const diffMs = Date.now() - d.getTime();
  const min = Math.round(diffMs / 60000);
  if (min < 1)  return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.round(hr / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString();
}


function describePayload(payload: Record<string, unknown>): string {
  if (!payload || Object.keys(payload).length === 0) return "(no payload)";
  const keys = Object.keys(payload);

  // Diff: { added: [...], removed: [...] } → "+5 −2"
  if ("added" in payload || "removed" in payload) {
    const added   = Array.isArray((payload as { added?: unknown }).added)
      ? ((payload as { added: unknown[] }).added).length : 0;
    const removed = Array.isArray((payload as { removed?: unknown }).removed)
      ? ((payload as { removed: unknown[] }).removed).length : 0;
    return `+${added} −${removed}`;
  }

  // Update: { before, after } → diff of changed top-level keys
  if ("before" in payload && "after" in payload) {
    const before = (payload as { before?: Record<string, unknown> }).before ?? {};
    const after  = (payload as { after?:  Record<string, unknown> }).after  ?? {};
    const changes: string[] = [];
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) {
        changes.push(`${k}: ${shortValue(before[k])} → ${shortValue(after[k])}`);
      }
    }
    return changes.length > 0 ? changes.join(", ") : "(no field changed)";
  }

  // Create: { data: {...} } → first identifying field
  if ("data" in payload) {
    const data = (payload as { data?: Record<string, unknown> }).data ?? {};
    const id    = (data as { id?: unknown }).id;
    const name  = (data as { name?: unknown }).name;
    const slug  = (data as { slug?: unknown }).slug;
    return [id, name, slug].filter(Boolean).map(String).join(" · ");
  }

  // Fallback: comma-joined top keys
  return keys.join(", ");
}


function shortValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v.length > 30 ? v.slice(0, 30) + "…" : v;
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  return Array.isArray(v) ? `[${v.length}]` : "{…}";
}
