import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { contrastRatio } from "./contrast";

const css = readFileSync(fileURLToPath(new URL("./tokens.css", import.meta.url)), "utf8");
const designSpec = readFileSync(
  fileURLToPath(new URL("../../docs/03-DESIGN.md", import.meta.url)),
  "utf8",
);

function tokenDeclarations(source: string): Map<string, string> {
  const declarations = new Map<string, string>();
  for (const selector of [":root", "@theme static"]) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const block = new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(source)?.[1];
    if (!block) throw new Error(`tokens.css has no ${selector} block`);
    for (const match of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      const [, name, value] = match;
      if (!name || !value) continue;
      if (declarations.has(name)) throw new Error(`${name} is declared more than once`);
      declarations.set(name, value.trim());
    }
  }
  return declarations;
}

const tokens = tokenDeclarations(css);

function resolve(name: string, seen = new Set<string>()): string {
  if (seen.has(name)) throw new Error(`Circular token reference at ${name}`);
  seen.add(name);
  const value = tokens.get(name);
  if (value === undefined) throw new Error(`Unknown token ${name}`);
  const reference = /^var\((--[\w-]+)\)$/.exec(value)?.[1];
  return reference ? resolve(reference, seen) : value.toLowerCase();
}

describe("Stitch tokens", () => {
  const yamlColors = /^colors:\n([\s\S]*?)^typography:/m.exec(designSpec)?.[1] ?? "";
  const specColors = [...yamlColors.matchAll(/^\s+([\w-]+):\s*'(#[0-9a-fA-F]{6})'/gm)];

  it("defines exactly the colour tokens listed in docs/03-DESIGN.md", () => {
    const specNames = specColors.map(([, name]) => `--stitch-${name}`).sort();
    const cssNames = [...tokens.keys()].filter((name) => name.startsWith("--stitch-")).sort();
    expect(specNames.length).toBeGreaterThan(40);
    expect(cssNames).toEqual(specNames);
  });

  it.each(specColors.map(([, name, hex]) => [name, hex] as const))(
    "--stitch-%s is preserved verbatim",
    (name, hex) => {
      expect(resolve(`--stitch-${name}`)).toBe(hex?.toLowerCase());
    },
  );
});

describe("approved ADR-014 roles", () => {
  it.each([
    ["--color-action-primary", "#d88c9a"],
    ["--color-on-action-primary", "#1b1c1a"],
    ["--color-action-emphasis", "#8b4b58"],
    ["--color-on-action-emphasis", "#ffffff"],
    ["--color-action-secondary", "#3d5a50"],
    ["--color-on-action-secondary", "#ffffff"],
    ["--color-accent-gold", "#d4af37"],
    ["--color-nav-selected", "#8b4b58"],
    ["--color-progress-fill", "#3d5a50"],
    ["--color-focus", "#3d5a50"],
  ])("%s resolves to %s", (token, hex) => {
    expect(resolve(token)).toBe(hex);
  });
});

// [foreground, background, minimum ratio, purpose]
const TEXT = 4.5;
const NON_TEXT = 3;
const pairs: Array<[string, string, number, string]> = [
  ["--color-ink", "--color-canvas", TEXT, "body text"],
  ["--color-ink", "--color-surface", TEXT, "card text"],
  ["--color-ink", "--color-surface-sunken", TEXT, "input text"],
  ["--color-ink-muted", "--color-canvas", TEXT, "secondary text"],
  ["--color-ink-muted", "--color-surface", TEXT, "secondary card text"],
  ["--color-ink-muted", "--color-surface-sunken", TEXT, "placeholder/hint text"],
  ["--color-ink-muted", "--color-surface-muted", TEXT, "muted panel text"],
  ["--color-on-action-primary", "--color-action-primary", TEXT, "primary button"],
  ["--color-on-action-primary", "--color-action-primary-hover", TEXT, "primary hover"],
  ["--color-on-action-primary", "--color-action-primary-pressed", TEXT, "primary pressed"],
  ["--color-on-action-emphasis", "--color-action-emphasis", TEXT, "emphasis button"],
  ["--color-on-action-emphasis", "--color-action-emphasis-hover", TEXT, "emphasis hover"],
  ["--color-on-action-emphasis", "--color-action-emphasis-pressed", TEXT, "emphasis pressed"],
  ["--color-on-action-secondary", "--color-action-secondary", TEXT, "secondary button"],
  ["--color-on-action-secondary", "--color-action-secondary-hover", TEXT, "secondary hover"],
  ["--color-on-action-secondary", "--color-action-secondary-pressed", TEXT, "secondary pressed"],
  ["--color-action-secondary", "--color-canvas", TEXT, "outline button text/border"],
  ["--color-action-secondary", "--color-surface", TEXT, "outline button on card"],
  ["--color-action-secondary", "--color-action-secondary-subtle", TEXT, "outline hover"],
  ["--color-action-emphasis", "--color-canvas", TEXT, "text link"],
  ["--color-action-emphasis", "--color-surface", TEXT, "text link on card"],
  ["--color-nav-selected", "--color-nav-selected-bg", TEXT, "selected nav item"],
  ["--color-nav-selected", "--color-canvas", TEXT, "selected nav indicator"],
  ["--color-status-confirmed-fg", "--color-status-confirmed-bg", TEXT, "confirmed badge"],
  ["--color-status-pending-fg", "--color-status-pending-bg", TEXT, "pending badge"],
  ["--color-status-ceremony-fg", "--color-status-ceremony-bg", TEXT, "ceremony badge"],
  ["--color-status-neutral-fg", "--color-status-neutral-bg", TEXT, "neutral badge"],
  ["--color-danger", "--color-canvas", TEXT, "error text"],
  ["--color-danger", "--color-surface", TEXT, "error text on card"],
  ["--color-on-danger-bg", "--color-danger-bg", TEXT, "error banner"],
  ["--color-focus", "--color-canvas", NON_TEXT, "focus ring on canvas"],
  ["--color-focus", "--color-surface", NON_TEXT, "focus ring on card"],
  ["--color-focus", "--color-surface-sunken", NON_TEXT, "focus ring on linen"],
  ["--color-border-control", "--color-canvas", NON_TEXT, "input boundary"],
  ["--color-border-control", "--color-surface", NON_TEXT, "input boundary on card"],
  ["--color-border-control", "--color-surface-sunken", NON_TEXT, "input boundary vs fill"],
  ["--color-progress-fill", "--color-progress-track", NON_TEXT, "progress value"],
];

describe("WCAG 2.2 AA contrast for semantic pairs", () => {
  it.each(pairs)("%s on %s ≥ %d:1 (%s)", (fg, bg, min) => {
    expect(contrastRatio(resolve(fg), resolve(bg))).toBeGreaterThanOrEqual(min);
  });

  it("rejects white text on the light blush primary", () => {
    expect(contrastRatio("#ffffff", resolve("--color-action-primary"))).toBeLessThan(TEXT);
    expect(resolve("--color-on-action-primary")).not.toBe("#ffffff");
  });
});

describe("contrastRatio", () => {
  it("matches known reference values", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
  });

  it("rejects malformed colours", () => {
    expect(() => contrastRatio("red", "#ffffff")).toThrow();
  });
});
