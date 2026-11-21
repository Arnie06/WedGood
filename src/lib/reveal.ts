/**
 * Scrolls a just-created or just-changed element into view and marks it with
 * `data-just-added` for a moment. The element may not be in the DOM yet (the
 * server re-renders after an action), so this waits briefly for it. Focus is
 * deliberately not moved, so someone adding several items keeps their place.
 */
export function revealElement(id: string, options: { timeoutMs?: number } = {}): void {
  if (typeof window === "undefined") return;
  const deadline = performance.now() + (options.timeoutMs ?? 3000);
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const attempt = () => {
    const el = document.getElementById(id);
    if (el) {
      // Items past the fold of a collapsed group live inside a closed <details>.
      for (let d = el.closest("details"); d; d = d.parentElement?.closest("details") ?? null)
        d.open = true;
      el.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
      el.setAttribute("data-just-added", "");
      window.setTimeout(() => el.removeAttribute("data-just-added"), 2500);
      return;
    }
    if (performance.now() < deadline) window.requestAnimationFrame(attempt);
  };
  window.requestAnimationFrame(attempt);
}
