import { EyeMark } from "@/components/eye-mark";

/**
 * Veilla brand mark + wordmark — kept in sync with the landing header.
 * The mark is drawn inline in `currentColor`, so it follows the enclosing
 * text colour in both themes. In the app the wordmark is set in Jost
 * (`font-display`), small and wide-tracked, so it labels the sidebar
 * without competing with it; the landing keeps its own, larger Poppins
 * wordmark.
 *
 * `size` is the mark's width in px — the mark is wider than it is tall.
 * Pass `showWordmark={false}` for tight spots where the mark alone is
 * enough; the mark then carries the accessible name itself.
 */
export function Logo({
  size = 24,
  showWordmark = true,
}: {
  size?: number;
  showWordmark?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-[7px] text-text">
      <EyeMark size={size} decorative={showWordmark} />
      {showWordmark && (
        <span
          className="font-display font-medium tracking-[0.24em] uppercase pl-[2px]"
          style={{ fontSize: Math.round(size * 0.42) }}
        >
          Veilla
        </span>
      )}
    </span>
  );
}
