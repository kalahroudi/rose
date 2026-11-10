# Rose brand assets

| File | Use |
|---|---|
| `logo-mark.svg` | App icon / avatar. Square, works from 16 px |
| `logo-wordmark.svg` | Mark + name for light backgrounds |
| `logo-wordmark-dark.svg` | Mark + name for dark backgrounds |

The mark is two open rings around a bud: a rose seen from above, drawn with round-capped
strokes on a rounded tile so it stays legible as a favicon. Its geometry is defined once
in [`scripts/icons.mjs`](../scripts/icons.mjs) and rendered to SVG and PNG from there.

## Colour

| Token | Light | Dark | Use |
|---|---|---|---|
| Accent | `#e11d48` | `#fb7185` | Primary buttons, links, active navigation, focus |
| On accent | `#ffffff` | `#0b0b0f` | Text and icons on the accent |

The accent is used sparingly; surfaces are neutral. Status colours (success, warning,
danger) are separate tokens in `packages/ui/src/styles.css`.

## Usage

- Keep clear space of at least a quarter of the mark's width around it.
- Do not stretch, rotate, outline or recolour parts of the mark separately.
- On photos or busy backgrounds use the tile version, never the bare glyph.
- The wordmark uses the system UI font stack at weight 650. For print, convert the text
  to outlines in your design tool.

## Making it yours

```sh
pnpm brand --name "Acme" --color "#2563eb"          # recolour the default mark
pnpm brand --name "Acme" --color "#2563eb" --logo ./acme-mark.svg
```

See [docs/branding.md](../docs/branding.md). The assets are Apache-2.0 like the rest of
the repository; you are free to replace them entirely.
