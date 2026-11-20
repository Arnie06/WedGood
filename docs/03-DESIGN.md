---
name: Vow & Bloom
colors:
  surface: '#fbf9f6'
  surface-dim: '#dbdad7'
  surface-bright: '#fbf9f6'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f5f3f0'
  surface-container: '#efeeeb'
  surface-container-high: '#eae8e5'
  surface-container-highest: '#e4e2df'
  on-surface: '#1b1c1a'
  on-surface-variant: '#524345'
  inverse-surface: '#30312f'
  inverse-on-surface: '#f2f0ed'
  outline: '#847375'
  outline-variant: '#d7c1c4'
  surface-tint: '#8b4b58'
  primary: '#8b4b58'
  on-primary: '#ffffff'
  primary-container: '#d88c9a'
  on-primary-container: '#5d2633'
  inverse-primary: '#ffb2bf'
  secondary: '#47645a'
  on-secondary: '#ffffff'
  secondary-container: '#c9eadc'
  on-secondary-container: '#4d6a60'
  tertiary: '#735c00'
  on-tertiary: '#ffffff'
  tertiary-container: '#c19d25'
  on-tertiary-container: '#453600'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#ffd9de'
  primary-fixed-dim: '#ffb2bf'
  on-primary-fixed: '#390917'
  on-primary-fixed-variant: '#6f3441'
  secondary-fixed: '#c9eadc'
  secondary-fixed-dim: '#aecdc1'
  on-secondary-fixed: '#022018'
  on-secondary-fixed-variant: '#304c43'
  tertiary-fixed: '#ffe088'
  tertiary-fixed-dim: '#e9c349'
  on-tertiary-fixed: '#241a00'
  on-tertiary-fixed-variant: '#574500'
  background: '#fbf9f6'
  on-background: '#1b1c1a'
  surface-variant: '#e4e2df'
typography:
  display-lg:
    fontFamily: EB Garamond
    fontSize: 3.5rem
    fontWeight: '400'
    lineHeight: 4rem
    letterSpacing: -0.01em
  display-lg-mobile:
    fontFamily: EB Garamond
    fontSize: 2.5rem
    fontWeight: '400'
    lineHeight: 3rem
    letterSpacing: -0.01em
  headline-lg:
    fontFamily: EB Garamond
    fontSize: 2.25rem
    fontWeight: '400'
    lineHeight: 2.75rem
  headline-lg-mobile:
    fontFamily: EB Garamond
    fontSize: 1.75rem
    fontWeight: '400'
    lineHeight: 2.25rem
  headline-md:
    fontFamily: EB Garamond
    fontSize: 1.5rem
    fontWeight: '500'
    lineHeight: 2rem
  headline-sm:
    fontFamily: EB Garamond
    fontSize: 1.25rem
    fontWeight: '600'
    lineHeight: 1.75rem
  body-lg:
    fontFamily: Manrope
    fontSize: 1.125rem
    fontWeight: '400'
    lineHeight: 1.75rem
  body-md:
    fontFamily: Manrope
    fontSize: 0.9375rem
    fontWeight: '400'
    lineHeight: 1.5rem
  body-sm:
    fontFamily: Manrope
    fontSize: 0.8125rem
    fontWeight: '400'
    lineHeight: 1.25rem
  label-lg:
    fontFamily: Manrope
    fontSize: 0.875rem
    fontWeight: '600'
    lineHeight: 1.25rem
    letterSpacing: 0.04em
  label-md:
    fontFamily: Manrope
    fontSize: 0.75rem
    fontWeight: '600'
    lineHeight: 1rem
    letterSpacing: 0.06em
  label-sm:
    fontFamily: Manrope
    fontSize: 0.6875rem
    fontWeight: '600'
    lineHeight: 0.875rem
    letterSpacing: 0.08em
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  gutter: 1.5rem
  gutter-mobile: 1rem
  margin: 3rem
  margin-mobile: 1.25rem
  space-xs: 0.25rem
  space-sm: 0.5rem
  space-md: 1rem
  space-lg: 1.5rem
  space-xl: 2.5rem
  space-2xl: 4rem
---

## Brand & Style

This design system embodies the intimacy, composure, and timeless beauty of bespoke editorial stationery. Designed for high-end wedding curation, the aesthetic balances warm classical refinement with contemporary operational clarity. 

The visual style merges **Couture Editorial Minimalism** with tactile, heirloom-grade digital craft. Whitespace is treated as breathing room to dissipate planning anxiety, replaced with warm champagne tones rather than sterile stark whites. Typography honors literary tradition through delicate Roman proportions while maintaining crisp modern legibility for intricate logistics. Every surface conveys quiet confidence, grace, and deliberate intentionality.

## Colors

The palette draws inspiration from fine pressed floral paper, vintage silk ribbons, and formal garden architecture:

- **Primary (`#D88C9A`)**: Soft dusty blush rose. Primary button fill, key celebrations and delicate interactive gestures. Text on blush is always warm charcoal `#1B1C1A` (6.63:1), never white (2.58:1).
- **High-emphasis primary (`#8B4B58`)**: Deep dusty rose (the Stitch `primary` token) with white text (6.47:1). Reserved for high-emphasis actions and selected navigation states.
- **Secondary (`#3D5A50`)**: Deep eucalyptus. Organizational controls, progress indicators, confirmed statuses and focus indicators. Filled buttons use white text (7.56:1); outlined buttons use eucalyptus text and border.
- **Tertiary (`#D4AF37`)**: Antique leaf gold. Decorative accent only: ornaments, ceremonial milestones and VIP markers. It is too light for text or for a component boundary (2.0:1 on ivory), so any gold-marked status also needs a text label in an accessible colour.
- **Neutrals (`#FAF8F5` to `#2D2B2A`)**: The canvas is grounded in layered champagne and warm linen tints (`#FAF8F5`, `#F5F0EA`), complemented by warm alabaster hairlines (`#EAE3D9`) for decorative separation only. Text avoids pure black, using warm charcoal (`#1B1C1A` body, `#524345` secondary text).

### Semantic application aliases (ADR-014)

The YAML tokens above are the original Google Stitch Vow & Bloom tokens. They are preserved verbatim as `--stitch-*` custom properties in `src/styles/tokens.css`. Application code uses only the semantic aliases defined in that file, never raw hex values or the raw tokens. Key aliases:

| Alias | Value | Use |
|---|---|---|
| `canvas` / `surface` / `surface-sunken` | `#fbf9f6` / `#ffffff` / `#f5f3f0` | page, cards, inputs and quiet panels |
| `ink` / `ink-muted` | `#1b1c1a` / `#524345` | body and secondary text |
| `action-primary` / `on-action-primary` | `#d88c9a` / `#1b1c1a` | primary buttons (hover `#cc8090`, pressed `#c07080`) |
| `action-emphasis` / `on-action-emphasis` | `#8b4b58` / `#ffffff` | high-emphasis actions, selected navigation (hover `#6f3441`) |
| `action-secondary` / `on-action-secondary` | `#3d5a50` / `#ffffff` | filled organizational controls (hover `#304c43`) |
| `focus` | `#3d5a50` | 2px focus outline, 2px offset (7.2:1 on canvas) |
| `border-control` | `#847375` | functional boundaries such as inputs and checkboxes (≥4:1 on canvas, white and linen) |
| `border-hairline` | `#eae3d9` | decorative card and section separation only |
| `accent-gold` | `#d4af37` | decoration only |

Every text, focus and functional-boundary pair is checked by `src/styles/tokens.test.ts` against WCAG 2.2 AA (4.5:1 text, 3:1 non-text). Disabled controls are exempt from contrast requirements, but they must still be identifiable and announced as disabled.

## Typography

The typography couples the graceful historic cadence of **EB Garamond** with the architectural balance and legibility of **Manrope**.

- **Editorial Serifs (EB Garamond)**: Expressive, poetic, and dignified. Used exclusively for overarching titles, section introductions, date counters, and editorial narrative. Never condensed or heavily tracked out.
- **Modern Grotesque (Manrope)**: Employed across dashboards, schedule timelines, guest lists, budgets, and interactive buttons. Medium to semi-bold weights maintain crisp readability in compact data contexts.
- **Labels & Micro-copy**: Set in uppercase or small caps with gentle letter spacing (`0.04em`–`0.08em`) to mirror luxury house cataloguing and bespoke invitation engravings.

## Layout & Spacing

The layout operates on a generous 12-column grid designed for airy visual cadence and structured data alignment. 

- **Outer Margins**: Expansive outer margins (`margin`: `3rem` on desktop, tapering to `1.25rem` on mobile) create a matted frame reminiscent of fine archival prints.
- **Rhythm**: Internal spacing defaults to multiples of `0.5rem` (`8px`), with expanded structural gaps (`space-xl` and `space-2xl`) between high-level milestones and editorial vignettes to prevent visual crowding during complex management workflows.
- **Breakpoints**: 
  - **Mobile (< 768px)**: Single-column flows with unified horizontal padding (`1.25rem`) and edge-pinned bottom sheets.
  - **Tablet (768px - 1024px)**: 6-column arrangements with collapsible planning sidebars.
  - **Desktop (> 1024px)**: 12-column layouts allowing side-by-side seating floorplans, vendor portfolios, and master checklists.

## Elevation & Depth

Visual hierarchy is crafted through soft physical layering rather than heavy synthetic drop shadows:

- **Tonal Stacking**: Cards and modal surfaces layer white and ultra-pale linen tones (`#FFFFFF` over `#FAF8F5`) complemented by hair-thin, low-contrast ghost borders (`1px solid #EAE3D9`).
- **Warm Ambient Shadows**: Where physical separation is required (such as floating guest cards, active seating tokens, and elevated drawer panels), shadows are ultra-diffused, using warm charcoal with faint rose undertones (`rgba(45, 43, 42, 0.04)` to `rgba(45, 43, 42, 0.08)`) with wide blurs (16px to 32px) and minimal y-axis offsets.
- **Frosted Translucency**: Sticky navigation headers and calendar filters feature a high-blur parchment glass effect (`backdrop-filter: blur(12px); background-color: rgba(250, 248, 245, 0.88)`), sustaining continuity with content underneath.

## Shapes

The shape system honors refined stationery cuts. A base radius (`roundedness: 1`, giving `0.25rem` / `4px` default corners) produces crisp, tailored contours that evoke heavy deckle-edged paper and precision-cut cardstock. 

- **Panels & Containers**: Micro-radii (`0.25rem` base, up to `0.5rem` on large master cards) maintain architectural structure and discipline.
- **Status Markers & Filters**: Pill forms are reserved strictly for contextual status badges (e.g., "RSVP Confirmed", "Floral Deposit Paid") to yield a tactile ribbon feel.

## Components

### Buttons & Interactive Controls
- **Primary Buttons**: Background in soft blush rose (`#D88C9A`) with warm charcoal `#1B1C1A` text (never white), featuring `0.25rem` corner radius, `space-sm` vertical by `space-lg` horizontal padding, a minimum 44px target height (48px default), and an understated hover transition to a deeper rose tint that keeps charcoal text at ≥4.5:1.
- **High-emphasis Buttons**: Deep dusty rose (`#8B4B58`) with white text, for the single most consequential action on a screen.
- **Secondary Buttons**: Filled eucalyptus (`#3D5A50`) with white text for organizational controls, or outlined: a transparent linen surface with a `1px solid #3D5A50` border and eucalyptus text, as an understated, grounding alternative.
- **Focus**: Every interactive element shows a visible 2px eucalyptus outline with a 2px offset on keyboard focus; focus is never removed without a replacement.
- **Tertiary / Text Actions**: Understated links set in Manrope semi-bold with a subtle baseline underline that expands on hover.

### Cards & Planning Modules
- **Master Cards**: Backed with crisp white `#FFFFFF`, bordered with `1px solid #EAE3D9`, using micro-radius `0.375rem`. Interior padding is generous (`space-lg` to `space-xl`).
- **Timeline & Schedule Cards**: Chronological milestone tracks utilize delicate vertical lines in deep eucalyptus sage (`#3D5A50`) with blush circular nodal checkpoints.

### Chips & Badges
- **Status Tags**: Soft pill-shaped badges (`rounded-full`, padding `0.25rem 0.75rem`) using muted tonal pastels: sage mist for confirmed, blush rose for pending, and pale gold for VIP or ceremony focal points.

### Form Inputs & Selectors
- **Input Fields**: Restful linen-tinted inputs with a warm taupe boundary (`#847375`, which meets the 3:1 non-text contrast that the softer `#EAE3D9` does not), transitioning to a crisp eucalyptus outline (`#3D5A50`) on focus. Placeholder text uses `ink-muted` and is never the only label.
- **Checkboxes & Radios**: Square micro-rounded checkboxes (`0.25rem`) and circular radios bordered in `#3D5A50`. When checked, they fill with deep sage green and display an ivory botanical check.

### Specialized Planning Elements
- **Seating & Table Arranger**: Crisp geometric and circular table representations with subtle outline borders, populated by miniature guest chips that snap into place with warm ambient drop shadows.
- **Progress & Budget Gauges**: Slender, elegant 4px-thick progress bars with soft blush tracks filled with deep eucalyptus (5.85:1 against the track). Gold may decorate but never carries the measured value, and the value is always available as text.
- **Navigation Chrome**: Slim top masthead bearing the serif hallmark, accented by a warm champagne border and blur effect.