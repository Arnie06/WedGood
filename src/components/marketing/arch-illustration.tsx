/** Original decorative line art: a garden arch with sprigs. Presentational only. */
export function ArchIllustration({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 320 400"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M40 380V160a120 120 0 0 1 240 0v220Z" className="fill-surface" />
      <path
        d="M40 380V160a120 120 0 0 1 240 0v220"
        className="stroke-action-secondary"
        strokeWidth="1.25"
      />
      <path
        d="M56 380V164a104 104 0 0 1 208 0v216"
        className="stroke-accent-gold"
        strokeWidth="0.75"
      />
      <g className="stroke-action-secondary" strokeWidth="1">
        <path d="M70 380c10-60 6-120-8-170" />
        <path d="M66 300c-14-6-22-16-24-30 14 4 22 14 24 30Z" />
        <path d="M68 262c12-8 18-20 18-34-12 8-18 20-18 34Z" />
        <path d="M64 228c-12-4-20-14-22-26 12 2 20 12 22 26Z" />
        <path d="M250 380c-10-60-6-120 8-170" />
        <path d="M254 300c14-6 22-16 24-30-14 4-22 14-24 30Z" />
        <path d="M252 262c-12-8-18-20-18-34 12 8 18 20 18 34Z" />
        <path d="M256 228c12-4 20-14 22-26-12 2-20 12-22 26Z" />
      </g>
      <g className="fill-action-primary">
        <circle cx="160" cy="58" r="7" />
        <circle cx="128" cy="66" r="4" />
        <circle cx="192" cy="66" r="4" />
        <circle cx="62" cy="206" r="4" />
        <circle cx="258" cy="206" r="4" />
      </g>
      <path d="M100 380h120" className="stroke-accent-gold" strokeWidth="0.75" />
      <path
        d="M160 300c-14-16-30-24-30-40a15 15 0 0 1 30-6 15 15 0 0 1 30 6c0 16-16 24-30 40Z"
        className="stroke-action-emphasis"
        strokeWidth="1"
      />
    </svg>
  );
}
