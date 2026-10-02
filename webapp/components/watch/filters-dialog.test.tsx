import { describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";

import { render, screen } from "@/test/render";
import { emptyAggs } from "@/test/fixtures";
import { emptyAdvanced, type Advanced } from "@/lib/filter";
import { FiltersDialog } from "./filters-dialog";

function setup(over: Partial<React.ComponentProps<typeof FiltersDialog>> = {}) {
  const onApply = vi.fn();
  const onOpenChange = vi.fn();
  const props = {
    open: true,
    onOpenChange,
    advanced: emptyAdvanced,
    aggs: emptyAggs(),
    onApply,
    ...over,
  };
  const view = render(<FiltersDialog {...props} />);
  return { ...view, onApply, onOpenChange, props };
}

/**
 * The dialog holds a *draft*: edits are local until Apply, and a fresh
 * opening must show what is currently active rather than whatever was
 * abandoned last time.
 *
 * That contract is implemented today by an effect that re-seeds the
 * draft whenever `open` flips. These tests describe the contract, not
 * the effect, so the implementation can change underneath them.
 */
describe("FiltersDialog", () => {
  it("opens seeded with the filters currently in force", () => {
    const active: Advanced = { ...emptyAdvanced, langs: ["fr"], categories: ["Politics"] };
    setup({ advanced: active });

    // The badge counts values, so two active filters read as "2".
    expect(screen.getByText(/2 filtres avancés/i)).toBeInTheDocument();
  });

  it("shows no filters when none are in force", () => {
    setup();
    expect(screen.getByText(/aucun filtre avancé/i)).toBeInTheDocument();
  });

  it("hands the draft to onApply and closes", async () => {
    const user = userEvent.setup();
    const active: Advanced = { ...emptyAdvanced, langs: ["fr"] };
    const { onApply, onOpenChange } = setup({ advanced: active });

    await user.click(screen.getByRole("button", { name: /appliquer/i }));

    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ langs: ["fr"] }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("clears every filter but keeps the search query", async () => {
    // The query belongs to the list header, not to this dialog. Wiping
    // it from here would clear an input the person can still see, which
    // reads as the app losing their text.
    const user = userEvent.setup();
    const active: Advanced = { ...emptyAdvanced, langs: ["fr"], query: "macron" };
    const { onApply } = setup({ advanced: active });

    await user.click(screen.getByRole("button", { name: /tout effacer/i }));
    await user.click(screen.getByRole("button", { name: /appliquer/i }));

    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({ langs: [], query: "macron" }),
    );
  });

  it("re-seeds from the active filters when reopened, discarding an abandoned draft", async () => {
    // Someone opens the dialog, clears everything, changes their mind and
    // closes without applying. The next opening must show the filters
    // that are actually in force — not the abandoned empty draft.
    const user = userEvent.setup();
    const active: Advanced = { ...emptyAdvanced, langs: ["fr"], categories: ["Politics"] };
    const { rerender, onApply, props } = setup({ advanced: active });

    await user.click(screen.getByRole("button", { name: /tout effacer/i }));
    expect(screen.getByText(/aucun filtre avancé/i)).toBeInTheDocument();

    rerender(<FiltersDialog {...props} open={false} />);
    rerender(<FiltersDialog {...props} open={true} />);

    expect(screen.getByText(/2 filtres avancés/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /appliquer/i }));
    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({ langs: ["fr"], categories: ["Politics"] }),
    );
  });

  it("offers to restore saved preferences only when they differ from the draft", async () => {
    const user = userEvent.setup();
    const prefs: Advanced = { ...emptyAdvanced, langs: ["en"] };
    setup({ advanced: emptyAdvanced, userPrefs: prefs });

    const restore = screen.getByRole("button", { name: /mes préférences/i });
    expect(restore).toBeEnabled();

    await user.click(restore);

    // Now the draft matches the preferences, so restoring again would do
    // nothing — the button stays visible but goes inert.
    expect(screen.getByRole("button", { name: /mes préférences/i })).toBeDisabled();
  });

  it("hides the restore button when there are no saved preferences", () => {
    setup({ userPrefs: emptyAdvanced });
    expect(
      screen.queryByRole("button", { name: /mes préférences/i }),
    ).not.toBeInTheDocument();
  });
});
