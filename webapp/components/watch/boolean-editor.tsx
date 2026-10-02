"use client";

/**
 * Boolean query editor for saved views.
 *
 * A TipTap-based editor that lets the user type a Lucene-syntax query
 * with inline `@Entity` mentions. Two distinct concepts live in the
 * document:
 *
 *   1. **Free text** — operators (AND/OR/NOT), parens, quoted phrases,
 *      wildcards. The user types them as-is.
 *   2. **Entity mentions** — typing `@` opens an autocomplete dropdown
 *      that searches our canonical `entities` table. Selecting a hit
 *      inserts an inline chip rendered as "@Renault" but serialized
 *      to plain Lucene as `entity:Q22687`.
 *
 * The serialized output is what gets sent to /me/query/compile and
 * stored in `views.criteria_text`. Copy-paste preserves the
 * `entity:Q...` Lucene form so users can share queries across
 * installations.
 *
 * # Layout
 *
 *   ┌──────────────────────────────────────────────────────┐
 *   │ [@Renault] AND (rappel OR défaut) AND lang:fr        │
 *   │                                                      │
 *   │ <syntax error display, if any>                       │
 *   └──────────────────────────────────────────────────────┘
 *   ┌─────────────────────────────────┬─────────────────────────┐
 *   │ 23 matches · max window (14d)   │ Sample articles preview… │
 *   └─────────────────────────────────┴─────────────────────────┘
 */

import * as React from "react";
import { useEditor, EditorContent, ReactRenderer, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Mention from "@tiptap/extension-mention";
import tippy, { Instance as TippyInstance } from "tippy.js";

import {
  compileBooleanQuery,
  testBooleanQuery,
  searchEntities,
  type BooleanTestSample,
  type EntitySearchHit,
} from "@/lib/boolean-query";
import { cn } from "@/lib/utils";
import { useChanged } from "@/lib/use-changed";

/* ─────────── Local types ─────────────────────────────────────────────
 *
 * TipTap ships types for its document and its suggestion plugin, but
 * they live in packages this project does not depend on directly
 * (`@tiptap/core`, `@tiptap/suggestion` arrive transitively). Importing
 * from a transitive dependency ties this file to someone else's
 * hoisting. These describe the handful of fields the editor actually
 * reads instead — narrower than the upstream types, and they fail loudly
 * if the shape ever changes.
 */

/** A node of the TipTap/ProseMirror document JSON, as walked below. */
interface DocNode {
  type?: string;
  text?: string;
  attrs?: { id?: string | null; label?: string | null };
  content?: DocNode[];
}

/** What TipTap hands the suggestion renderer on start and update.
 *
 *  `clientRect` can be absent, and can return null once the caret it
 *  tracked is gone — tippy's own type admits neither, which is what the
 *  `anchorRect` adapter below reconciles. */
interface SuggestionRenderProps {
  editor: Editor;
  clientRect?: (() => DOMRect | null) | null;
}

/** Adapt TipTap's nullable caret rect to the non-null one tippy wants.
 *
 *  A null rect means the caret has moved on and the popup is about to
 *  be torn down anyway; positioning it at the origin for that last
 *  frame is invisible, and safer than a cast hiding the mismatch. */
function anchorRect(rect: () => DOMRect | null): () => DOMRect {
  return () => rect() ?? new DOMRect();
}

/** What it hands the key handler. */
interface SuggestionKeyProps {
  event: KeyboardEvent;
}

/** What `SuggestionList` exposes to the plugin through its ref. */
interface SuggestionListHandle {
  onKeyDown: (props: SuggestionKeyProps) => boolean;
}

/* ─────────── Serialization ───────────────────────────────────────────── */
/**
 * Convert the TipTap document JSON to a Lucene-syntax query string.
 *
 * Strategy: walk the doc in order, emitting:
 *   - text nodes → verbatim
 *   - mention nodes → `entity:<qid>` (with quotes around `qid` only if
 *     it contains non-alphanumeric chars, which Wikidata Q-ids never
 *     do)
 *
 * Whitespace is collapsed so the user can hit Enter mid-query and not
 * generate a stray newline character in the serialized form.
 */
function docToLucene(doc: DocNode | null | undefined): string {
  if (!doc || !Array.isArray(doc.content)) return "";
  let out = "";
  const walk = (node: DocNode | null | undefined) => {
    if (!node) return;
    if (node.type === "text") {
      out += node.text ?? "";
      return;
    }
    if (node.type === "mention") {
      const qid = node.attrs?.id;
      if (qid) out += `entity:${qid}`;
      return;
    }
    if (node.type === "hardBreak") {
      out += " ";
      return;
    }
    if (node.type === "paragraph") {
      if (Array.isArray(node.content)) for (const c of node.content) walk(c);
      out += " ";
      return;
    }
    if (Array.isArray(node.content)) for (const c of node.content) walk(c);
  };
  for (const block of doc.content) walk(block);
  return out.replace(/\s+/g, " ").trim();
}


/* ─────────── @-mention dropdown ──────────────────────────────────────── */
/**
 * Suggestion popup rendered while the user types `@…`. Lists matching
 * entities from the backend, click/Enter selects one and inserts a
 * chip into the editor.
 *
 * Keyboard nav (Up/Down/Enter/Esc) is handled by the parent
 * suggestion plugin, which forwards events via the `command` API.
 */
function SuggestionList({
  items,
  command,
  ref,
}: {
  items: EntitySearchHit[];
  command: (item: { id: string; label: string }) => void;
  /** Supplied by TipTap's ReactRenderer. React 19 passes refs as a
   *  plain prop, so no forwardRef wrapper is needed. */
  ref?: React.Ref<SuggestionListHandle>;
}) {
  const [activeIndex, setActiveIndex] = React.useState(0);

  // Reset selection when the candidate list shifts so the highlighted
  // row doesn't point past the end of a now-shorter list. Done during
  // render rather than in an effect: an effect would paint one frame
  // with the old index, which on a shorter list highlights a row that
  // is no longer there.
  if (useChanged(items)) setActiveIndex(0);

  const select = React.useCallback(
    (i: number) => {
      const item = items[i];
      if (!item?.qid) return;   // unlinked entities aren't insertable
      command({ id: item.qid, label: item.name });
    },
    [items, command],
  );

  // Keyboard handling, exposed to TipTap's suggestion plugin through
  // the ref below. Memoised so the imperative handle can depend on the
  // function itself rather than on a hand-kept list of what it closes
  // over, which could drift apart silently.
  const onKeyDown = React.useCallback(
    ({ event }: SuggestionKeyProps) => {
      if (event.key === "ArrowUp") {
        setActiveIndex((i) => (i + items.length - 1) % Math.max(items.length, 1));
        return true;
      }
      if (event.key === "ArrowDown") {
        setActiveIndex((i) => (i + 1) % Math.max(items.length, 1));
        return true;
      }
      if (event.key === "Enter") {
        select(activeIndex);
        return true;
      }
      return false;
    },
    [items.length, select, activeIndex],
  );

  React.useImperativeHandle(ref, () => ({ onKeyDown }), [onKeyDown]);

  if (items.length === 0) {
    return (
      <div className="bg-bg border border-border rounded-md shadow-lg px-3 py-2 text-[12px] text-text-3">
        No entity match.
      </div>
    );
  }
  return (
    <div className="bg-bg border border-border rounded-md shadow-lg overflow-hidden min-w-[260px] max-w-[420px]">
      {items.map((it, i) => (
        <button
          key={it.entity_id}
          type="button"
          onMouseEnter={() => setActiveIndex(i)}
          onMouseDown={(e) => { e.preventDefault(); select(i); }}
          disabled={!it.qid}
          className={cn(
            "block w-full text-left px-3 py-1.5 text-[12.5px]",
            "border-b border-border/50 last:border-b-0",
            i === activeIndex
              ? "bg-bg-active text-text"
              : "text-text-2 hover:bg-bg-hover",
            !it.qid && "opacity-50 cursor-not-allowed",
          )}
        >
          <div className="font-medium truncate">{it.name}</div>
          <div className="text-[10.5px] text-text-3 truncate">
            {it.kind}
            {it.country && ` · ${it.country}`}
            {it.qid && ` · ${it.qid}`}
            {!it.qid && " · unlinked (not insertable)"}
            {it.description && ` · ${it.description}`}
          </div>
        </button>
      ))}
    </div>
  );
}


/* ─────────── Suggestion plugin config ─────────────────────────────────── */

function makeSuggestionConfig() {
  let renderer: ReactRenderer | null = null;
  let popup:    TippyInstance[] | null = null;
  let lastAbort: AbortController | null = null;

  return {
    items: async ({ query }: { query: string }) => {
      // Debounce + abort the previous in-flight request when the user
      // types fast — we don't want stale results racing in.
      if (lastAbort) lastAbort.abort();
      lastAbort = new AbortController();
      try {
        return await searchEntities(query, { limit: 8, signal: lastAbort.signal });
      } catch {
        return [];
      }
    },

    render: () => {
      return {
        onStart: (props: SuggestionRenderProps) => {
          renderer = new ReactRenderer(SuggestionList, {
            props,
            editor: props.editor,
          });
          if (!props.clientRect) return;
          popup = tippy("body", {
            getReferenceClientRect: anchorRect(props.clientRect),
            appendTo: () => document.body,
            content:  renderer.element,
            showOnCreate: true,
            interactive: true,
            trigger:  "manual",
            placement: "bottom-start",
          });
        },
        onUpdate(props: SuggestionRenderProps) {
          renderer?.updateProps(props);
          if (!props.clientRect) return;
          popup?.[0]?.setProps({
            getReferenceClientRect: anchorRect(props.clientRect),
          });
        },
        onKeyDown(props: SuggestionKeyProps) {
          if (props.event.key === "Escape") {
            popup?.[0]?.hide();
            return true;
          }
          const handle = renderer?.ref as SuggestionListHandle | undefined;
          return handle?.onKeyDown?.(props) ?? false;
        },
        onExit() {
          popup?.[0]?.destroy();
          renderer?.destroy();
        },
      };
    },
  };
}


/* ─────────── Main editor component ─────────────────────────────────────── */

export function BooleanQueryEditor({
  value,
  onChange,
  placeholder = "e.g. @Renault AND (rappel OR défaut) AND lang:fr",
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
}) {
  const [syntaxError, setSyntaxError] = React.useState<string | null>(null);
  const [count, setCount] = React.useState<number | null>(null);
  const [sample, setSample] = React.useState<BooleanTestSample[]>([]);
  const [testing, setTesting] = React.useState(false);

  // Emptying the editor clears the results immediately, during the same
  // render. The alternative — clearing inside the debounce effect —
  // left the previous query's match count under an empty box for a
  // frame, which reads as "0 results for nothing".
  if (useChanged(value) && !value.trim()) {
    setCount(null);
    setSample([]);
    setSyntaxError(null);
  }
  const lastTextRef = React.useRef<string>("");

  // The editor is configured with StarterKit (just paragraphs/text)
  // plus our Mention extension wired to the entity search backend.
  // We DON'T enable history/bold/italic/etc. from StarterKit — this is
  // a query editor, not rich text.
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false, bulletList: false, orderedList: false, blockquote: false,
        codeBlock: false, code: false, horizontalRule: false, bold: false,
        italic: false, strike: false,
      }),
      Mention.configure({
        HTMLAttributes: {
          class: "boolean-mention",
        },
        suggestion: {
          char: "@",
          allowSpaces: false,
          ...makeSuggestionConfig(),
        },
        renderText: ({ node }) => `entity:${node.attrs.id}`,
        renderHTML: ({ node }) => {
          const span = document.createElement("span");
          span.className = "boolean-mention";
          span.setAttribute("data-qid", node.attrs.id);
          span.textContent = `@${node.attrs.label ?? node.attrs.id}`;
          return span;
        },
      }),
    ],
    // Seed from value (Lucene string). We DON'T parse a Lucene
    // string back into TipTap document nodes (= one-way render). The
    // user's edits in the editor become the source of truth from that
    // point on. Switching from Panel → Boolean will populate this
    // textarea with the converted string; switching back will not
    // re-render the panel from custom edits — same caveat as Notion's
    // dual-mode toggles.
    content: value || "",
    immediatelyRender: false,
    onUpdate: ({ editor: ed }) => {
      const text = docToLucene(ed.getJSON());
      lastTextRef.current = text;
      onChange(text);
    },
    editorProps: {
      attributes: {
        class: cn(
          "min-h-[64px] p-3 outline-none",
          "font-mono text-[13px] leading-[1.5]",
          "bg-bg-sub border border-border rounded",
          "focus-within:border-text-3",
        ),
      },
    },
  });

  // Auto-test the query 500ms after the user stops typing. Cancel
  // in-flight requests on each new keystroke so we don't pile up.
  React.useEffect(() => {
    const text = value.trim();
    // Nothing to test, and nothing to clear — the render-time branch
    // above already did that the moment the editor emptied.
    if (!text) return;
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setTesting(true);
      try {
        const compileResult = await compileBooleanQuery(text);
        if (!compileResult.ok) {
          setSyntaxError(compileResult.error);
          setCount(null);
          setSample([]);
          return;
        }
        setSyntaxError(null);
        const testResult = await testBooleanQuery(text, {
          limit: 5,
          signal: ctrl.signal,
        });
        if (testResult.ok) {
          setCount(testResult.count);
          setSample(testResult.sample);
        }
      } catch (e) {
        // Aborts and HTTP errors land here. Aborts are silent (= the
        // next keystroke fired a fresh request); other errors expose
        // a generic message to the user.
        if ((e as Error).name !== "AbortError") {
          setSyntaxError("Preview failed");
        }
      } finally {
        setTesting(false);
      }
    }, 500);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [value]);

  return (
    <div className="space-y-2">
      <div className="relative">
        <EditorContent editor={editor} />
        {!value && (
          <div className="absolute top-3 left-3 pointer-events-none font-mono text-[13px] text-text-4">
            {placeholder}
          </div>
        )}
      </div>

      {syntaxError && (
        <div className="text-[11.5px] text-bad font-mono px-1">
          ⚠ {syntaxError}
        </div>
      )}

      {/* Live preview — count + sample */}
      <div className="border border-border rounded bg-bg-sub p-3 space-y-2">
        <div className="flex items-center justify-between text-[11px] text-text-3 font-mono">
          <span>
            {testing
              ? "Testing…"
              : count === null
                ? "—"
                : `${count} matches · max window (14d)`}
          </span>
          <span className="text-text-4">
            {sample.length > 0 && `${sample.length} shown`}
          </span>
        </div>
        {sample.length > 0 ? (
          <ul className="space-y-1.5 text-[12px]">
            {sample.map((s) => (
              <li key={s.id} className="border-b border-border/50 last:border-b-0 pb-1.5 last:pb-0">
                <div className="text-text font-medium truncate">{s.title}</div>
                <div className="text-[10.5px] text-text-3">
                  {s.feed} {s.lang && ` · ${s.lang}`}
                  {s.published_at && ` · ${new Date(s.published_at).toLocaleString()}`}
                </div>
              </li>
            ))}
          </ul>
        ) : !testing && value.trim() && count === 0 && !syntaxError ? (
          <div className="text-[12px] text-text-3 italic">
            No articles match over the retention window (14 days).
          </div>
        ) : null}
      </div>

      {/* Inline syntax cheat-sheet (collapsible later if it grows). */}
      <details className="text-[11px] text-text-3">
        <summary className="cursor-pointer select-none">Syntax cheat-sheet</summary>
        <div className="pt-2 space-y-0.5 font-mono">
          <div><code>AND OR NOT</code> — booleans (uppercase)</div>
          <div><code>(A OR B)</code> — group</div>
          <div><code>&quot;exact phrase&quot;</code> — phrase match</div>
          <div><code>univer*</code> — suffix wildcard</div>
          <div><code>@Entity</code> — autocomplete a Wikidata entity (becomes <code>entity:Qxxx</code>)</div>
          <div><code>title:X</code>, <code>lang:fr</code>, <code>category:X</code>, <code>country:FR</code>, <code>subject_country:FR</code>, <code>article_type:opinion</code>, <code>feed:&quot;Le Monde&quot;</code> — field filters</div>
        </div>
      </details>
    </div>
  );
}
