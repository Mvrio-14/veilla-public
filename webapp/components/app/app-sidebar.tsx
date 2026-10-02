"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowLeft,
  ChartNoAxesGantt,
  ChevronRight,
  Eye,
  Newspaper,
  Radar,
  Radio,
  Settings,
  Sparkles,
  Split,
  SquareLibrary,
  type LucideIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { Logo } from "@/components/watch/logo";
import { useSidebar } from "@/lib/sidebar-context";
import { cn } from "@/lib/utils";

/**
 * The one navigation surface of the app — a single collapsible sidebar.
 *
 * Collapsed it is 52px and shows icons only, their label in a tooltip;
 * expanded, 256px with labels. The brand sits at its top, level with the
 * topbar, whose first control is the toggle beside it.
 *
 * ## Two tools
 *
 * Veilla is two tools over the same monitors. Desk is where a person
 * reads: the Watch and the library of what they kept. Signal is where agents read
 * for them: every decision they made, what each is asked, and the
 * context they share. The switch under the brand moves between them.
 *
 * Each tool's entries fall in two groups: **Browse**, what you read, and
 * **Configure**, what you set up. Monitors is configuration for both, so
 * it closes the Configure group of each. Settings is detached at the
 * bottom: it is not a surface of either tool.
 *
 * Switching tool opens Monitors, the configuration both share. The tool
 * is then the one chosen, not one read from the route; elsewhere it
 * follows the route, and a shared route keeps the tool you came from.
 *
 * ## Icons do not move
 *
 * Collapsing changes nothing's height. The group headings stay in the
 * DOM, hidden with `visibility` rather than removed, and the switch keeps
 * the height of one row: otherwise every icon below shifts on each
 * toggle, and the column visibly jumps.
 *
 * ## The second level
 *
 * On the Watch, in the library and on Decisions, the sidebar becomes
 * that screen's own navigation — views and facets, bookmarks and
 * folders, verdicts and agents. It REPLACES the main
 * entries rather than nesting under them: a stack of screens, not a
 * panel that opens. The level entering slides from the right, the one
 * returning from the left. A back row at its top brings the main entries
 * back without leaving the screen; leaving and returning, or clicking
 * the screen's entry again, re-opens it.
 *
 * Only when expanded. Collapsed, the sidebar is an icon rail, and a
 * second level of unlabelled icons would be unreadable.
 *
 * The screen renders that level itself, through `<SidebarLevel>`, into
 * the node this component lends. While the sidebar is expanded the node
 * stays mounted, hidden when the main entries show, so the screen's
 * navigation keeps its state (open sections, scroll) across a trip to
 * the main level.
 */

type Tool = "desk" | "signal";

type NavEntry = {
  href: string;
  key:
    | "watch" | "library"
    | "decisions" | "agents" | "context"
    | "monitors" | "settings";
  icon: LucideIcon;
  /** The screen has a navigation of its own, shown as a second level. */
  hasLevel?: boolean;
  /** Extra classes on the glyph: Split is drawn vertically and reads as
   *  a fork only once turned on its side. */
  iconClassName?: string;
};

type Group = { key: "consult" | "configure"; entries: NavEntry[] };

const MONITORS: NavEntry = { href: "/monitors", key: "monitors", icon: Radio };

const TOOLS: Record<Tool, { icon: LucideIcon; home: string; groups: Group[] }> = {
  desk: {
    icon: Newspaper,
    home: "/watch",
    groups: [
      {
        key: "consult",
        entries: [
          { href: "/watch", key: "watch", icon: Eye, hasLevel: true },
          { href: "/library", key: "library", icon: SquareLibrary, hasLevel: true },
        ],
      },
      { key: "configure", entries: [MONITORS] },
    ],
  },
  signal: {
    icon: Radar,
    home: "/signal/decisions",
    groups: [
      {
        key: "consult",
        entries: [
          { href: "/signal/decisions", key: "decisions", icon: ChartNoAxesGantt, hasLevel: true },
        ],
      },
      {
        key: "configure",
        entries: [
          { href: "/signal/agents", key: "agents", icon: Split, iconClassName: "rotate-90" },
          { href: "/signal/context", key: "context", icon: Sparkles },
          MONITORS,
        ],
      },
    ],
  },
};

const TOOL_KEYS = Object.keys(TOOLS) as Tool[];

/** Where switching tool lands: the configuration both tools share. */
const SWITCH_TARGET = MONITORS.href;

const isUnder = (pathname: string, href: string) =>
  pathname === href || pathname.startsWith(`${href}/`);

/** The tool a route belongs to; null on the routes both share. */
function toolOf(pathname: string): Tool | null {
  if (isUnder(pathname, "/signal")) return "signal";
  if (TOOLS.desk.groups[0].entries.some((e) => isUnder(pathname, e.href))) return "desk";
  return null;
}

export function AppSidebar() {
  const t = useTranslations("nav");
  const pathname = usePathname();
  const { collapsed, setSlot } = useSidebar();
  const open = !collapsed;

  const [tool, setTool] = React.useState<Tool>(toolOf(pathname) ?? "desk");
  // The back row hides the screen's level without leaving the screen.
  const [dismissed, setDismissed] = React.useState(false);

  // Both follow the route only when it changes, compared during render
  // rather than in an effect, which would paint one frame of the wrong
  // tool or level on every navigation. Only on a change: the switch sets
  // the tool while the route is still the previous tool's, and syncing
  // on every render would take the choice straight back.
  const [lastPath, setLastPath] = React.useState(pathname);
  if (pathname !== lastPath) {
    setLastPath(pathname);
    const routeTool = toolOf(pathname);
    if (routeTool && routeTool !== tool) setTool(routeTool);
    // Leaving and returning re-opens the screen's level.
    if (dismissed) setDismissed(false);
  }

  const { groups, home } = TOOLS[tool];
  const current = groups
    .flatMap((g) => g.entries)
    .find((e) => e.hasLevel && isUnder(pathname, e.href));

  const showLevel = Boolean(current) && open && !dismissed;

  return (
    <nav
      aria-label={t("primaryAriaLabel")}
      data-open={open}
      className={cn(
        "group/sb shrink-0 flex flex-col items-stretch px-2 pb-2.5",
        // Clipped only when expanded: the sliding level must not show
        // outside the sidebar. Collapsed, the tooltips render at
        // `left-full` and clipping would swallow every one of them.
        open && "overflow-hidden",
        "border-r border-border bg-bg-sub",
        "transition-[width] duration-150 ease-out",
        open ? "w-[256px]" : "w-[52px]",
      )}
    >
      {/* Same height as the topbar, so the mark lines up with the toggle
       *  beside it. */}
      <div className="h-11 shrink-0 flex items-center pl-[5px] overflow-hidden">
        <Link href={home} aria-label="Veilla" className="flex items-center">
          <Logo size={29} showWordmark={open} />
        </Link>
      </div>

      <ToolSwitch value={tool} open={open} onSwitch={setTool} />

      {!showLevel && (
        // Mounted anew each time it returns, which replays its slide.
        <div className={cn("flex-1 min-h-0 flex flex-col", open && "animate-sidebar-out")}>
          {groups.map((group) => (
            <div key={group.key} className="flex flex-col">
              <Heading>{t(`groups.${group.key}`)}</Heading>
              {group.entries.map((entry) => (
                <SidebarLink
                  key={entry.href}
                  entry={entry}
                  label={t(entry.key)}
                  open={open}
                  active={isUnder(pathname, entry.href)}
                  // Clicking the screen's entry while on it re-opens its
                  // level — the route does not change, so nothing else would.
                  onClick={() => {
                    if (entry === current) setDismissed(false);
                  }}
                />
              ))}
            </div>
          ))}

          <div className="flex-1" />

          <SidebarLink
            entry={{ href: "/settings", key: "settings", icon: Settings }}
            label={t("settings")}
            open={open}
            active={isUnder(pathname, "/settings")}
          />
        </div>
      )}

      {current && open && (
        <div
          className={cn(
            "flex-1 min-h-0 flex-col",
            showLevel ? "flex animate-sidebar-in" : "hidden",
          )}
        >
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className={cn(
              "flex items-center gap-2 h-8 px-2 mt-1 rounded-md cursor-pointer shrink-0",
              "text-[12.5px] text-text-2 hover:bg-bg-hover hover:text-text",
              "transition-colors duration-100",
            )}
          >
            <ArrowLeft size={14} strokeWidth={1.7} className="shrink-0 text-text-3" aria-hidden />
            {t(current.key)}
          </button>
          <div ref={setSlot} className="flex-1 min-h-0 overflow-y-auto pb-4" />
        </div>
      )}
    </nav>
  );
}

/** A group heading. Hidden, not removed, when collapsed: removing it
 *  would move every icon below it up. */
function Heading({ children }: { children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "font-mono text-[9px] tracking-[0.16em] uppercase text-text-4",
        "px-2 mt-3.5 mb-[5px] whitespace-nowrap",
        "group-data-[open=false]/sb:invisible",
      )}
    >
      {children}
    </div>
  );
}

/**
 * Desk | Signal. Each opens Monitors in that tool: links rather than a
 * toggle, so the browser's back button returns to where you were.
 *
 * One row tall in both states, so nothing below it moves. Collapsed,
 * there is room for one icon only: the current tool's, which leads to
 * the other.
 */
function ToolSwitch({
  value,
  open,
  onSwitch,
}: {
  value: Tool;
  open: boolean;
  onSwitch: (tool: Tool) => void;
}) {
  const t = useTranslations("nav");

  if (!open) {
    const other = TOOL_KEYS.find((key) => key !== value)!;
    const Icon = TOOLS[value].icon;
    return (
      <Link
        href={SWITCH_TARGET}
        onClick={() => onSwitch(other)}
        aria-label={t("switchTo", { tool: t(other) })}
        className={cn(
          "group/link relative shrink-0 grid place-items-center w-9 h-8 mx-auto mt-1 rounded-md",
          "bg-bg-hover text-text hover:bg-bg-active transition-colors duration-100",
        )}
      >
        <Icon size={16} strokeWidth={1.6} aria-hidden />
        <Tooltip label={t("switchTo", { tool: t(other) })} />
      </Link>
    );
  }

  return (
    <div
      role="group"
      aria-label={t("toolSwitchAriaLabel")}
      className="shrink-0 grid grid-cols-2 gap-0.5 h-8 mt-1 p-0.5 rounded-md bg-bg-hover"
    >
      {TOOL_KEYS.map((key) => {
        const { icon: Icon } = TOOLS[key];
        const active = key === value;
        return (
          <Link
            key={key}
            href={SWITCH_TARGET}
            onClick={() => onSwitch(key)}
            aria-current={active ? "true" : undefined}
            className={cn(
              "flex items-center justify-center gap-1.5 rounded-[5px]",
              "text-[12px] transition-colors duration-100",
              active ? "bg-bg-elev text-text font-medium shadow-sm" : "text-text-3 hover:text-text",
            )}
          >
            <Icon size={13} strokeWidth={1.7} aria-hidden className="shrink-0" />
            {t(key)}
          </Link>
        );
      })}
    </div>
  );
}

function SidebarLink({
  entry,
  label,
  open,
  active,
  onClick,
}: {
  entry: NavEntry;
  label: string;
  open: boolean;
  active: boolean;
  onClick?: () => void;
}) {
  const Icon = entry.icon;
  return (
    <Link
      href={entry.href}
      onClick={onClick}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group/link relative flex items-center gap-2.5 h-8 rounded-md",
        "whitespace-nowrap transition-colors duration-100",
        // The icon sits at the same x in both states: 10px in from the
        // link, which is also where centring puts it in the 36px rail.
        open ? "px-2.5" : "w-9 justify-center px-0",
        active
          ? "bg-bg-active text-text font-medium"
          : "text-text-2 hover:bg-bg-hover hover:text-text",
      )}
    >
      <Icon
        size={16}
        strokeWidth={1.6}
        aria-hidden
        className={cn("shrink-0", active ? "text-text" : "text-text-3", entry.iconClassName)}
      />
      {open && (
        <span className="min-w-0 flex-1 overflow-hidden text-ellipsis text-[12.5px]">
          {label}
        </span>
      )}
      {/* Always drawn, never only on hover: it says the entry opens a
       *  level of its own BEFORE you touch it. Faint enough not to
       *  compete with the label. */}
      {open && entry.hasLevel && (
        <ChevronRight
          size={13}
          strokeWidth={1.8}
          aria-hidden
          className={cn(
            "shrink-0 transition-colors duration-100",
            active ? "text-text-3" : "text-text-4 group-hover/link:text-text-3",
          )}
        />
      )}
      {/* The tooltip exists only collapsed, where the label is the one
       *  thing missing. */}
      {!open && <Tooltip label={label} />}
    </Link>
  );
}

/** A label beside an icon-only link, shown on hover and keyboard focus.
 *  The link carries `group/link`. */
function Tooltip({ label }: { label: string }) {
  return (
    <span
      role="tooltip"
      className={cn(
        "pointer-events-none absolute left-full top-1/2 -translate-y-1/2 ml-2.5 z-50",
        "px-[7px] py-[3px] rounded-md whitespace-nowrap",
        "bg-text text-bg text-[11.5px] font-semibold",
        "opacity-0 transition-opacity duration-100",
        "group-hover/link:opacity-100 group-focus-visible/link:opacity-100",
      )}
    >
      {label}
    </span>
  );
}
