import { readableOn } from "@/domain/design/board";

/** Colour chips that always show the hex code as text, so colour is never the only signal. */
export function Swatches({
  colors,
  size = "md",
}: {
  colors: readonly string[];
  size?: "sm" | "md";
}) {
  if (colors.length === 0) return null;
  return (
    <ul aria-label="Palette" className="flex flex-wrap gap-2">
      {colors.map((hex) => (
        <li
          key={hex}
          style={{ backgroundColor: hex, color: readableOn(hex) }}
          className={
            size === "sm"
              ? "h-6 w-6 rounded-full border border-border-hairline"
              : "rounded-control border border-border-hairline px-3 py-2 text-label-md font-semibold"
          }
          title={hex}
        >
          {size === "sm" ? <span className="sr-only">{hex}</span> : hex}
        </li>
      ))}
    </ul>
  );
}
