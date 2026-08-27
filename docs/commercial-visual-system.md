# Commercial Visual System

The commercial surface should read as infrastructure software: operational,
quiet, inspectable, and controlled.

## Tokens and components

- Warm paper background: `#f2efe6`
- Near-black ink: `#171915`
- Dark proof panel: `#101a14`
- Primary accent: `#b63718`
- Muted text: `#5f635a`
- UI labels: system monospace, uppercase, restrained tracking
- Headings: system sans with short, manager-readable sentences
- Buttons: rectangular, high contrast, minimum 44px target
- Panels: one-pixel boundaries, minimal radius, no decorative glass effects

Core components are the plain-language coordination diagram, trust strip,
process cards, phase list, access comparison, synthetic Console proof,
captioned walkthrough, evidence cards, FAQ, and direct booking card.

## Responsive and accessible behavior

Semantic source order is content order. Desktop grids collapse to one column
below 760px. The coordination chain becomes vertical; Console regions stack;
responsibility and evidence grids become cards rather than horizontal tables.
Navigation remains keyboard reachable through a native `details` menu. The
mobile header puts booking inside the menu so the wordmark and navigation never
fight for horizontal space.

Every interactive control has a visible focus ring. Text and controls maintain
high contrast against their surfaces. Diagrams include text labels and do not
depend on color, motion, hover, or pointer precision. `prefers-reduced-motion`
removes smooth scrolling and transition duration.

Do not use robots, avatars, glowing brains, customer logos, stock-office
photography, decorative AI imagery, or unsupported dashboard screenshots.
