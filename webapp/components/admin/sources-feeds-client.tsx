"use client";

import * as React from "react";
import {
  type AdminFeed,
  type AdminSource,
  type FieldCoverage,
  type ProbeResult,
  type SampleEntry,
  createFeed,
  listFeeds,
  listSources,
  probeFeed,
  setFeedStatus,
  updateFeed,
} from "@/lib/admin/api";
import { cn } from "@/lib/utils";

/**
 * Master-detail UI:
 *
 *  ┌─────────┐ ┌─────────────────────────────────────────────────┐
 *  │ Sources │ │ Feeds of {selected source}                       │
 *  │ ──────  │ │ ┌─ status badge ─ name ─ url ─ failures ─ ─ ─  │
 *  │ ─ Le M. │ │ │  ...                                          │
 *  │ ─ AFP   │ │ └─────────────────────────────────────────────  │
 *  │ ─ ...   │ │ [+ Add feed]                                    │
 *  └─────────┘ └─────────────────────────────────────────────────┘
 *
 * Toggles: "Show dead feeds" / "Show empty sources". State of these
 * doesn't go to URL (dev tool — fine to lose on nav).
 */
export function SourcesFeedsClient() {
  const [sources, setSources]             = React.useState<AdminSource[]>([]);
  const [feeds, setFeeds]                 = React.useState<AdminFeed[]>([]);
  const [selectedId, setSelectedId]       = React.useState<number | null>(null);
  const [includeDead, setIncludeDead]     = React.useState(false);
  const [loading, setLoading]             = React.useState(true);
  const [error, setError]                 = React.useState<string | null>(null);
  const [showAddDialog, setShowAddDialog] = React.useState(false);
  // Two independent searches: one filters the sources list (left pane),
  // the other filters the feeds table (right pane). Lowercased once per
  // change; matching is on substring across name/slug/url/domain.
  const [sourceQuery, setSourceQuery]     = React.useState("");
  const [feedQuery, setFeedQuery]         = React.useState("");

  /** Fetch both lists. Touches no React state — which is what lets the
   *  effect below update state only from inside a promise callback. */
  const fetchAll = React.useCallback(
    () =>
      Promise.all([
        listSources({ include_dead: includeDead }),
        listFeeds({ include_dead: includeDead }),
      ]),
    [includeDead],
  );

  /** Load on mount, and again whenever the dead-feeds filter changes. */
  React.useEffect(() => {
    let alive = true;
    fetchAll()
      .then(([s, f]) => {
        if (!alive) return;
        setSources(s);
        setFeeds(f);
        setError(null);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : "Failed to load");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    // Toggling the filter twice quickly must not let the first response
    // land after the second.
    return () => {
      alive = false;
    };
  }, [fetchAll]);

  /** Reload after a mutation. Called from event handlers, where setting
   *  state up front is exactly right — the click is the trigger. */
  const refresh = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, f] = await fetchAll();
      setSources(s);
      setFeeds(f);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [fetchAll]);

  // Sources filtered by the source-search query (name / domain).
  const filteredSources = React.useMemo(() => {
    if (!sourceQuery.trim()) return sources;
    const q = sourceQuery.trim().toLowerCase();
    return sources.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.domain ?? "").toLowerCase().includes(q),
    );
  }, [sources, sourceQuery]);

  // Selected source (for the right-pane title).
  const selectedSource =
    selectedId === null
      ? null
      : sources.find((s) => s.id === selectedId) ?? null;

  // Feeds filtered by both the source picker and the feed-search query.
  const filteredFeeds = React.useMemo(() => {
    const base =
      selectedId === null
        ? feeds
        : feeds.filter((f) => f.source_id === selectedId);
    if (!feedQuery.trim()) return base;
    const q = feedQuery.trim().toLowerCase();
    return base.filter(
      (f) =>
        f.name.toLowerCase().includes(q) ||
        f.slug.toLowerCase().includes(q) ||
        f.url.toLowerCase().includes(q) ||
        (f.source_name ?? "").toLowerCase().includes(q),
    );
  }, [feeds, selectedId, feedQuery]);

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-[16px] font-bold uppercase tracking-wider">
            Sources & Feeds
          </h1>
          <p className="text-text-3 text-[12px]">
            {sources.length} sources · {feeds.length} feeds
            {loading && " · loading…"}
            {error && (
              <span className="text-bad ml-2">· error: {error}</span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="text-[12px] flex items-center gap-1.5 select-none cursor-pointer">
            <input
              type="checkbox"
              checked={includeDead}
              onChange={(e) => setIncludeDead(e.target.checked)}
            />
            Show dead
          </label>
          <button
            type="button"
            onClick={() => setShowAddDialog(true)}
            className="px-3 py-1 rounded bg-text text-bg uppercase tracking-wider text-[12px] font-bold hover:opacity-90"
          >
            + Add feed
          </button>
        </div>
      </header>

      <div className="grid grid-cols-[280px,1fr] gap-3 h-[calc(100vh-180px)]">
        <SourcesPane
          sources={filteredSources}
          totalSources={sources.length}
          selectedId={selectedId}
          onSelect={setSelectedId}
          query={sourceQuery}
          onQueryChange={setSourceQuery}
        />
        <FeedsPane
          feeds={filteredFeeds}
          totalForScope={
            selectedId === null
              ? feeds.length
              : feeds.filter((f) => f.source_id === selectedId).length
          }
          sources={sources}
          selectedSource={selectedSource}
          query={feedQuery}
          onQueryChange={setFeedQuery}
          onChanged={refresh}
        />
      </div>

      {showAddDialog && (
        <AddFeedDialog
          existingSources={sources}
          onClose={() => setShowAddDialog(false)}
          onSaved={() => {
            setShowAddDialog(false);
            void refresh();
          }}
        />
      )}
    </div>
  );
}


// ── Master pane: sources list with title + search ──────────────────────
function SourcesPane({
  sources, totalSources, selectedId, onSelect, query, onQueryChange,
}: {
  sources: AdminSource[];
  totalSources: number;
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  query: string;
  onQueryChange: (q: string) => void;
}) {
  return (
    <aside className="border border-border rounded bg-bg-sub flex flex-col overflow-hidden">
      {/* Title + count + search bar — sticky at the top, scroll lives
       *  below it so the user always knows which pane is which. */}
      <div className="px-3 py-2 border-b border-border bg-bg-sub sticky top-0">
        <div className="flex items-center justify-between mb-1.5">
          <h2 className="text-[12px] uppercase tracking-wider font-bold">
            Sources
          </h2>
          <span className="text-[10.5px] text-text-3 tabular-nums">
            {sources.length === totalSources
              ? totalSources
              : `${sources.length} / ${totalSources}`}
          </span>
        </div>
        <input
          type="text"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search name or domain…"
          className="w-full px-2 py-1 rounded border border-border bg-bg text-text font-mono text-[11.5px]"
        />
      </div>

      <div className="flex-1 overflow-y-auto">
        <button
          type="button"
          onClick={() => onSelect(null)}
          className={cn(
            "block w-full text-left px-3 py-2 text-[12px] uppercase tracking-wider border-b border-border",
            selectedId === null
              ? "bg-bg-active text-text font-bold"
              : "text-text-2 hover:bg-bg-hover",
          )}
        >
          All feeds
        </button>
        {sources.length === 0 ? (
          <div className="px-3 py-4 text-text-3 text-[11.5px] italic">
            No sources match.
          </div>
        ) : sources.map((s) => {
          const active = s.id === selectedId;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => onSelect(s.id)}
              className={cn(
                "block w-full text-left px-3 py-1.5 border-b border-border/50",
                active
                  ? "bg-bg-active text-text font-bold"
                  : "text-text-2 hover:bg-bg-hover",
              )}
            >
              <div className="text-[12px]">{s.name}</div>
              <div className="text-[10.5px] text-text-3">
                {s.domain} · {s.n_feeds_alive} alive
                {s.n_feeds_dead > 0 && (
                  <span className="text-bad"> · {s.n_feeds_dead} dead</span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </aside>
  );
}


// ── Detail pane: feeds table with title + search ────────────────────────
function FeedsPane({
  feeds, totalForScope, sources, selectedSource, query, onQueryChange, onChanged,
}: {
  feeds: AdminFeed[];
  totalForScope: number;
  sources: AdminSource[];
  selectedSource: AdminSource | null;
  query: string;
  onQueryChange: (q: string) => void;
  onChanged: () => void;
}) {
  const [editingFeedId, setEditingFeedId] = React.useState<number | null>(null);

  // Title reflects which scope we're showing: "All feeds" when nothing
  // picked, "Feeds — Le Monde" when a source is selected.
  const titleScope = selectedSource ? `Feeds — ${selectedSource.name}` : "All feeds";

  return (
    <div className="border border-border rounded bg-bg-sub flex flex-col overflow-hidden">
      <div className="px-3 py-2 border-b border-border bg-bg-sub sticky top-0">
        <div className="flex items-center justify-between mb-1.5">
          <h2 className="text-[12px] uppercase tracking-wider font-bold">
            {titleScope}
          </h2>
          <span className="text-[10.5px] text-text-3 tabular-nums">
            {feeds.length === totalForScope
              ? totalForScope
              : `${feeds.length} / ${totalForScope}`}
          </span>
        </div>
        <input
          type="text"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search feed name, slug, URL…"
          className="w-full px-2 py-1 rounded border border-border bg-bg text-text font-mono text-[11.5px]"
        />
      </div>

      {feeds.length === 0 ? (
        <div className="p-6 text-text-3 text-center text-[12px] italic">
          No feeds in this scope.
        </div>
      ) : (
        <div className="flex-1 overflow-auto">
          <table className="w-full text-[12px]">
            <thead className="bg-bg-sub border-b border-border sticky top-0">
              <tr className="text-left uppercase tracking-wider text-[10.5px] text-text-3">
                <th className="px-2 py-1.5">Status</th>
                <th className="px-2 py-1.5">Source</th>
                <th className="px-2 py-1.5">Name / slug</th>
                <th className="px-2 py-1.5">URL</th>
                <th className="px-2 py-1.5">Lang</th>
                <th className="px-2 py-1.5">Fails</th>
                <th
                  className="px-2 py-1.5"
                  title="Subscribed to automatically when an account signs up"
                >
                  Starter
                </th>
                <th className="px-2 py-1.5 w-32">Actions</th>
              </tr>
            </thead>
            <tbody>
              {feeds.map((f) => (
                <FeedRow
                  key={f.id}
                  feed={f}
                  sources={sources}
                  isEditing={editingFeedId === f.id}
                  onEdit={(on) => setEditingFeedId(on ? f.id : null)}
                  onChanged={onChanged}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}


function FeedRow({
  feed, sources, isEditing, onEdit, onChanged,
}: {
  feed: AdminFeed;
  sources: AdminSource[];
  isEditing: boolean;
  onEdit: (open: boolean) => void;
  onChanged: () => void;
}) {
  const setStatus = async (status: "active" | "degraded" | "dead") => {
    try {
      await setFeedStatus(feed.id, status);
      onChanged();
    } catch (e) {
      alert(`Status change failed: ${e instanceof Error ? e.message : e}`);
    }
  };
  const setStarter = async (starter: boolean) => {
    try {
      await updateFeed(feed.id, { starter });
      onChanged();
    } catch (e) {
      alert(`Starter change failed: ${e instanceof Error ? e.message : e}`);
    }
  };
  return (
    <>
      <tr className="border-b border-border/50 hover:bg-bg-hover">
        <td className="px-2 py-1">
          <StatusBadge status={feed.status} />
        </td>
        <td className="px-2 py-1 text-text-3 truncate max-w-[160px]" title={feed.source_name ?? ""}>
          {feed.source_name ?? "(no source)"}
        </td>
        <td className="px-2 py-1">
          <div className="font-bold truncate max-w-[260px]" title={feed.name}>{feed.name}</div>
          <div className="text-text-3 truncate max-w-[260px]" title={feed.slug}>{feed.slug}</div>
        </td>
        <td className="px-2 py-1 max-w-[280px]">
          <a
            href={feed.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent hover:underline truncate block"
            title={feed.url}
          >
            {feed.url}
          </a>
        </td>
        <td className="px-2 py-1 text-text-3">{feed.country ?? ""}</td>
        <td className={cn(
          "px-2 py-1 text-right tabular-nums",
          feed.consecutive_failures > 0 ? "text-bad" : "text-text-3",
        )}>
          {feed.consecutive_failures}
        </td>
        <td className="px-2 py-1 text-center">
          <input
            type="checkbox"
            checked={feed.starter}
            onChange={(e) => void setStarter(e.target.checked)}
            aria-label={`New accounts follow ${feed.name}`}
          />
        </td>
        <td className="px-2 py-1">
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => onEdit(!isEditing)}
              className="px-1.5 py-0.5 rounded border border-border text-[11px] hover:bg-bg-hover"
            >
              {isEditing ? "Cancel" : "Edit"}
            </button>
            {feed.status === "dead" ? (
              <button
                type="button"
                onClick={() => setStatus("active")}
                className="px-1.5 py-0.5 rounded border border-good text-good text-[11px] hover:bg-bg-hover"
                title="Reset status to active + clear failure counter"
              >
                Resurrect
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  if (confirm(`Soft-delete feed "${feed.name}"?`)) void setStatus("dead");
                }}
                className="px-1.5 py-0.5 rounded border border-bad text-bad text-[11px] hover:bg-bg-hover"
                title="Mark dead — worker will skip it"
              >
                Kill
              </button>
            )}
          </div>
        </td>
      </tr>
      {isEditing && (
        <tr>
          <td colSpan={8} className="bg-bg-sub px-3 py-3">
            <EditFeedInline
              feed={feed}
              sources={sources}
              onSaved={() => { onEdit(false); onChanged(); }}
            />
          </td>
        </tr>
      )}
    </>
  );
}


function StatusBadge({ status }: { status: "active" | "degraded" | "dead" }) {
  const styles = {
    active:    "bg-good/20 text-good border-good/30",
    degraded:  "bg-warn/20 text-warn border-warn/30",
    dead:      "bg-bad/20 text-bad border-bad/30",
  }[status];
  return (
    <span className={cn(
      "px-1.5 py-0.5 rounded border text-[10.5px] uppercase tracking-wider font-bold",
      styles,
    )}>
      {status}
    </span>
  );
}


// ── Inline edit form ────────────────────────────────────────────────────
function EditFeedInline({
  feed, sources, onSaved,
}: {
  feed: AdminFeed;
  sources: AdminSource[];
  onSaved: () => void;
}) {
  const [slug,      setSlug]      = React.useState(feed.slug);
  const [name,      setName]      = React.useState(feed.name);
  const [url,       setUrl]       = React.useState(feed.url);
  // The DB column is named `country` but semantically holds the feed
  // CONTENT language (lowercase ISO 639-1). Renamed in the UI to match
  // its actual meaning while we wait on a column-rename migration.
  const [lang,      setLang]      = React.useState(feed.country ?? "");
  const [feedType,  setFeedType]  = React.useState(feed.feed_type ?? "");
  const [sourceId,  setSourceId]  = React.useState<number | null>(feed.source_id);
  const [saving,    setSaving]    = React.useState(false);
  const [errMsg,    setErrMsg]    = React.useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setErrMsg(null);
    try {
      await updateFeed(feed.id, {
        slug,
        name,
        url,
        country:   lang.toLowerCase() || null,
        feed_type: feedType || null,
        source_id: sourceId,
      });
      onSaved();
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid grid-cols-2 gap-2">
      <Field label="Slug"      value={slug}     onChange={setSlug} />
      <Field label="Name"      value={name}     onChange={setName} />
      <Field label="URL"       value={url}      onChange={setUrl} className="col-span-2" />
      <Field
        label="Language (ISO 639-1)"
        value={lang}
        onChange={(v) => setLang(v.toLowerCase())}
      />
      <Field label="Feed type" value={feedType} onChange={setFeedType} />
      <div className="col-span-2">
        <label className="text-[10.5px] uppercase tracking-wider text-text-3 block mb-0.5">
          Source
        </label>
        <select
          value={sourceId ?? ""}
          onChange={(e) => setSourceId(e.target.value ? Number(e.target.value) : null)}
          className="w-full px-2 py-1 rounded border border-border bg-bg text-text"
        >
          <option value="">— (no source)</option>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>{s.name} ({s.domain})</option>
          ))}
        </select>
      </div>
      {errMsg && (
        <div className="col-span-2 text-bad text-[12px]">{errMsg}</div>
      )}
      <div className="col-span-2 flex gap-2 justify-end">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="px-3 py-1 rounded bg-text text-bg uppercase tracking-wider text-[11.5px] font-bold disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}


function Field({
  label, value, onChange, className,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  className?: string;
}) {
  return (
    <div className={className}>
      <label className="text-[10.5px] uppercase tracking-wider text-text-3 block mb-0.5">
        {label}
      </label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-2 py-1 rounded border border-border bg-bg text-text font-mono"
      />
    </div>
  );
}


// ── Add Feed dialog ─────────────────────────────────────────────────────
function AddFeedDialog({
  existingSources, onClose, onSaved,
}: {
  existingSources: AdminSource[];
  onClose: () => void;
  onSaved: () => void;
}) {
  // Stage 1: URL only → probe button
  // Stage 2: preview + editable form → save button
  const [url,        setUrl]        = React.useState("");
  const [probing,    setProbing]    = React.useState(false);
  const [probeError, setProbeError] = React.useState<string | null>(null);
  const [probe,      setProbe]      = React.useState<ProbeResult | null>(null);

  const [name,        setName]       = React.useState("");
  const [slug,        setSlug]       = React.useState("");
  const [lang,        setLang]       = React.useState(""); // feed CONTENT lang (lowercase)
  const [feedType,    setFeedType]   = React.useState("");
  const [sourceMode,  setSourceMode] = React.useState<"auto" | "existing" | "new">("auto");
  const [existingSourceId, setExistingSourceId] = React.useState<number | null>(null);
  // "Create new source" fields — only relevant when sourceMode === "new"
  const [newSourceName,           setNewSourceName]           = React.useState("");
  const [newSourceDomain,         setNewSourceDomain]         = React.useState("");
  const [newSourceCountry,        setNewSourceCountry]        = React.useState(""); // ISO upper

  const [saving,   setSaving]   = React.useState(false);
  const [saveErr,  setSaveErr]  = React.useState<string | null>(null);

  const doProbe = async () => {
    setProbing(true);
    setProbeError(null);
    setProbe(null);
    try {
      const result = await probeFeed(url.trim());
      setProbe(result);
      if (result.ok) {
        // Pre-fill the save form with sensible defaults from probe.
        setName(result.feed_title ?? "");
        // Feed CONTENT lang = lowercase (fr, en) — what we got from the
        // RSS <language> tag, post-normalization in the probe.
        setLang((result.feed_lang ?? "").toLowerCase());
        // Pre-fill the source-creation fields too (only matter when the
        // user lands in the "Create new" branch). Domain is auto-derived
        // from the URL, country is left blank — there's no reliable way
        // to infer publisher country from a feed's content lang.
        setNewSourceDomain(result.suggested_source_domain ?? "");
        // Source-mode auto-detect: if we have an existing source for
        // this domain, default to "existing".
        const matching = result.suggested_source_domain
          ? existingSources.find((s) => s.domain === result.suggested_source_domain)
          : undefined;
        if (matching) {
          setSourceMode("existing");
          setExistingSourceId(matching.id);
        } else if (result.suggested_source_name) {
          setSourceMode("new");
          setNewSourceName(result.suggested_source_name);
        }
      } else {
        setProbeError(result.message);
      }
    } catch (e) {
      setProbeError(e instanceof Error ? e.message : String(e));
    } finally {
      setProbing(false);
    }
  };

  const doSave = async () => {
    setSaving(true);
    setSaveErr(null);
    try {
      await createFeed({
        url:         (probe?.final_url || url).trim(),
        name:        name.trim(),
        slug:        slug.trim() || null,
        feed_type:   feedType.trim() || null,
        country:     lang.trim().toLowerCase() || null,  // feed CONTENT lang
        source_id:   sourceMode === "existing" ? existingSourceId : null,
        source_name: sourceMode === "new" ? newSourceName.trim() : null,
        // Source-creation fields — only sent when we're seeding a new
        // source. Backend ignores them in "existing" / "auto-match" modes.
        source_domain:         sourceMode === "new" ? (newSourceDomain.trim().toLowerCase() || null) : null,
        source_country:        sourceMode === "new" ? (newSourceCountry.trim().toUpperCase() || null) : null,
      });
      onSaved();
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-bg border border-border rounded w-[640px] max-h-[80vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-4 py-3 border-b border-border flex justify-between items-center">
          <h2 className="font-bold uppercase tracking-wider">Add feed</h2>
          <button type="button" onClick={onClose} className="text-text-3 hover:text-text">
            ✕
          </button>
        </header>

        <div className="p-4 space-y-4">
          {/* Stage 1: URL + probe */}
          <div>
            <label className="text-[10.5px] uppercase tracking-wider text-text-3 block mb-0.5">
              Feed URL
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/rss"
                className="flex-1 px-2 py-1 rounded border border-border bg-bg-sub text-text font-mono text-[12px]"
              />
              <button
                type="button"
                onClick={doProbe}
                disabled={!url.trim() || probing}
                className="px-3 py-1 rounded bg-text text-bg uppercase tracking-wider text-[11.5px] font-bold disabled:opacity-50"
              >
                {probing ? "Testing…" : "Test"}
              </button>
            </div>
            {probeError && (
              <div className="mt-2 text-bad text-[12px]">⚠ {probeError}</div>
            )}
          </div>

          {/* Stage 2: preview + form (only when probe succeeded) */}
          {probe?.ok && (
            <>
              <ProbePreview probe={probe} requestedUrl={url} />


              {/* Feed-level fields */}
              <div className="grid grid-cols-2 gap-2">
                <Field label="Feed name" value={name} onChange={setName} />
                <Field label="Slug (optional — auto if empty)" value={slug} onChange={setSlug} />
                <Field
                  label="Language (ISO 639-1, e.g. fr, en)"
                  value={lang}
                  onChange={(v) => setLang(v.toLowerCase())}
                />
                <Field label="Feed type (optional)" value={feedType} onChange={setFeedType} />
              </div>

              {/* Source selector */}
              <div>
                <label className="text-[10.5px] uppercase tracking-wider text-text-3 block mb-1">
                  Source
                </label>
                <div className="flex gap-3 text-[12px]">
                  <label className="flex items-center gap-1">
                    <input
                      type="radio"
                      checked={sourceMode === "auto"}
                      onChange={() => setSourceMode("auto")}
                    />
                    Auto (lookup by domain)
                  </label>
                  <label className="flex items-center gap-1">
                    <input
                      type="radio"
                      checked={sourceMode === "existing"}
                      onChange={() => setSourceMode("existing")}
                    />
                    Pick existing
                  </label>
                  <label className="flex items-center gap-1">
                    <input
                      type="radio"
                      checked={sourceMode === "new"}
                      onChange={() => setSourceMode("new")}
                    />
                    Create new
                  </label>
                </div>
                {sourceMode === "existing" && (
                  <select
                    value={existingSourceId ?? ""}
                    onChange={(e) => setExistingSourceId(e.target.value ? Number(e.target.value) : null)}
                    className="mt-1 w-full px-2 py-1 rounded border border-border bg-bg text-text"
                  >
                    <option value="">— select source —</option>
                    {existingSources.map((s) => (
                      <option key={s.id} value={s.id}>{s.name} ({s.domain})</option>
                    ))}
                  </select>
                )}
                {sourceMode === "new" && (
                  <div className="mt-1 grid grid-cols-2 gap-2 border border-border rounded p-2 bg-bg-sub">
                    <Field
                      label="Source name"
                      value={newSourceName}
                      onChange={setNewSourceName}
                      className="col-span-2"
                    />
                    <Field
                      label="Domain (auto from URL)"
                      value={newSourceDomain}
                      onChange={(v) => setNewSourceDomain(v.toLowerCase())}
                    />
                    <Field
                      label="Country (ISO 3166-1, e.g. FR, US)"
                      value={newSourceCountry}
                      onChange={(v) => setNewSourceCountry(v.toUpperCase())}
                    />
                  </div>
                )}
              </div>

              {saveErr && (
                <div className="text-bad text-[12px]">{saveErr}</div>
              )}

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-3 py-1 rounded border border-border uppercase tracking-wider text-[11.5px]"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={doSave}
                  disabled={!name.trim() || saving}
                  className="px-3 py-1 rounded bg-text text-bg uppercase tracking-wider text-[11.5px] font-bold disabled:opacity-50"
                >
                  {saving ? "Saving…" : "Save feed"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}


// ── Probe preview: field coverage + sample entries ──────────────────────
function ProbePreview({
  probe, requestedUrl,
}: {
  probe: ProbeResult;
  requestedUrl: string;
}) {
  return (
    <div className="border border-good/30 bg-good/10 rounded p-3 text-[12px] space-y-3">
      <div>
        <div className="font-bold uppercase tracking-wider text-good mb-1">
          ✓ {probe.message}
        </div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
          {probe.feed_title    && <div><span className="text-text-3">Title:</span>    <strong>{probe.feed_title}</strong></div>}
          {probe.detected_type && <div><span className="text-text-3">Format:</span>   {probe.detected_type}</div>}
          {probe.feed_lang     && <div><span className="text-text-3">Language:</span> {probe.feed_lang}</div>}
          {probe.suggested_source_domain && (
            <div><span className="text-text-3">Domain:</span> {probe.suggested_source_domain}</div>
          )}
        </div>
        {probe.final_url && probe.final_url !== requestedUrl && (
          <div className="text-warn mt-1">
            <strong>Redirect:</strong> {probe.final_url}
          </div>
        )}
      </div>

      {/* Field coverage — mirrors scripts/test_feed.py output */}
      {probe.field_coverage.length > 0 && (
        <div>
          <div className="text-[10.5px] uppercase tracking-wider text-text-3 mb-1">
            Field coverage ({probe.n_entries} entries)
          </div>
          <table className="text-[11.5px] tabular-nums">
            <tbody>
              {probe.field_coverage.map((c) => (
                <FieldCoverageRow key={c.field} coverage={c} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Unmapped fields — useful to flag unusual feeds early */}
      {probe.unmapped_fields.length > 0 && (
        <details>
          <summary className="cursor-pointer text-text-3 text-[11.5px] uppercase tracking-wider">
            Unmapped fields ({probe.unmapped_fields.length})
          </summary>
          <div className="mt-1 ml-3 grid grid-cols-2 gap-x-4 text-[11px]">
            {probe.unmapped_fields.map((u) => (
              <div key={u.name} className="flex justify-between gap-2 tabular-nums">
                <span className="truncate">{u.name}</span>
                <span className="text-text-3">{u.count}/{probe.n_entries}</span>
              </div>
            ))}
          </div>
        </details>
      )}

      {/* Sample entries — title + date + summary + image */}
      {probe.sample_entries.length > 0 && (
        <div>
          <div className="text-[10.5px] uppercase tracking-wider text-text-3 mb-1">
            Sample ({probe.sample_entries.length} most recent)
          </div>
          <div className="space-y-2">
            {probe.sample_entries.map((e, i) => (
              <SampleEntryCard key={i} entry={e} index={i + 1} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}


function FieldCoverageRow({ coverage }: { coverage: FieldCoverage }) {
  const ratio = coverage.total > 0 ? coverage.present / coverage.total : 0;
  const { icon, color } =
    ratio >= 0.9 ? { icon: "✓", color: "text-good" } :
    ratio >= 0.4 ? { icon: "~", color: "text-warn" } :
                   { icon: "✗", color: "text-bad"  };
  return (
    <tr>
      <td className="pr-3 text-text-3 w-20">{coverage.field}</td>
      <td className="pr-2 text-right w-16">
        {coverage.present}/{coverage.total}
      </td>
      <td className={cn("font-bold", color)}>{icon}</td>
    </tr>
  );
}


function SampleEntryCard({
  entry, index,
}: {
  entry: SampleEntry;
  index: number;
}) {
  return (
    <div className="flex gap-2 border-l-2 border-border pl-2">
      {entry.image_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={entry.image_url}
          alt=""
          className="w-16 h-16 object-cover rounded shrink-0 border border-border"
          loading="lazy"
        />
      ) : (
        <div className="w-16 h-16 rounded shrink-0 border border-border bg-bg-sub flex items-center justify-center text-text-4 text-[10px]">
          no img
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="font-bold text-[11.5px] line-clamp-2">
          {index}. {entry.title}
        </div>
        <div className="text-[10.5px] text-text-3 tabular-nums">
          {entry.published ?? "(no date)"}
          {entry.source && <span> · {entry.source}</span>}
        </div>
        {entry.summary && (
          <div className="text-[11px] text-text-2 mt-0.5 line-clamp-2">
            {entry.summary}
          </div>
        )}
      </div>
    </div>
  );
}
