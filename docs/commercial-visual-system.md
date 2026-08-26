# Commercial Visual System

The commercial surface should read as infrastructure software: operational,
quiet, inspectable, and controlled.

## Tokens and components

- Warm paper background: `#f2efe6`
- Near-black ink: `#171915`
- Dark proof panel: `#101a14`
- Primary accent: `#e84b21`
- Muted text: `#64685f`
- UI labels: system monospace, uppercase, restrained tracking
- Headings: system sans; italic serif is reserved for the human-control phrase
- Buttons: rectangular, high contrast, minimum 44px target
- Panels: one-pixel boundaries, minimal radius, no decorative glass effects

Core components are the coordination diagram, workflow cards, phase list,
boundary table, synthetic Console proof, captioned walkthrough, and structured
workflow form.

## Responsive and accessible behavior

Semantic source order is content order. Desktop grids collapse to one column
below 760px. The coordination chain becomes vertical; Console regions stack;
wide responsibility tables receive their own horizontal scroll container rather
than overflowing the page. Navigation remains keyboard reachable through a
native `details` menu.

Every interactive control has a visible focus ring. Text and controls maintain
high contrast against their surfaces. Diagrams include text labels and do not
depend on color, motion, hover, or pointer precision. `prefers-reduced-motion`
removes smooth scrolling and transition duration.

Do not use robots, avatars, glowing brains, customer logos, stock-office
photography, decorative AI imagery, or unsupported dashboard screenshots.
