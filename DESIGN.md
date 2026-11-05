# OutSystems MCP design direction

Utility-first desktop companion dashboard. Declared dials:
**ENERGY 1 / RHYTHM 1 / MOTION 1** (a config tool, not a marketing page).

Reasons for the decisions that need one (R-31):

- **Palette**: near-black blue-gray neutrals plus one teal accent
  (`#2dd4bf`) for the primary action and selected state; semantic
  ok/warn/bad colors appear only on status LEDs and errors. One accent,
  used at the key moments.
- **Mono type for paths and identifiers**: registry paths, URLs, config
  paths and step numbers are machine strings users must copy or compare
  exactly; monospace keeps them unambiguous. Everything human-readable
  is system sans.
- **LED status dots**: each LED marks a real endpoint-check state and is
  always paired with a text label; the pulse marks work-in-progress and
  stops under reduced motion.
- **Mark gradient** (`.mark`): a single 36px brand tile uses a subtle
  dark-teal gradient to separate the mark from the flat background; it
  appears nowhere else.
- **Dark only**: this tool lives next to terminals and IDEs on Windows;
  a light theme would serve no user of this window. `color-scheme` is
  declared so native controls match.
