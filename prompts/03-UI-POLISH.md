# Master prompt — responsive product design and UI polish

---

Act as a senior product designer and frontend engineer. Improve **[SCREEN_OR_FLOW]** in the existing wedding planning app, working within the current UI framework and `docs/03-DESIGN.md`, `04-UX-FLOWS.md`, `18-UX-COPY-AND-DEMO.md`, and product requirements. Inspect the working tree, component library and screenshots if available. Do not rewrite the app or change domain behavior without an explicit requirement.

Goal: modern romantic luxury — warm ivory background, porcelain surfaces, deep olive text, accessible green primary actions, subtle rose/champagne accents, editorial serif headings and clear sans-serif interface. Calm whitespace, meaningful imagery, purposeful navigation and obvious actions. Avoid clutter, illegible pale text, fake reviews and generic dashboard templates. Use original/licensed imagery, local demo placeholders where appropriate. Do not make all components equally prominent.

Design mobile-first: persistent Home/Discover/Plan/Guests/More navigation in shell, sensible back navigation, safe areas, 44px preferred touch targets, no unintended horizontal scroll, accessible non-drag seat assignment, card comparisons on small screens, clear empty/loading/error/permission states. Preserve all critical desktop capabilities on mobile. Support screen reader, keyboard focus, reduced motion, contrast and text zoom. Maintain semantic tokens, avoid one-off styles.

Implement improvements against real data/services or clearly labeled synthetic demo mode only. Do not display fabricated financial summaries or fake actions. Run at 320, 390, 768, 1280 and 1440 CSS px when feasible, inspect browser screenshots and interaction, axe/keyboard checks. Verify no regression in existing behavior. Run lint/typecheck/relevant tests, document what actually ran and what could not. Update status ledger; summarize specific changes and remaining issues.
