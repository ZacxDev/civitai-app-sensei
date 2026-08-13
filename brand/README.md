# Civitai Sensei — brand kit

> **Ask. It reads the catalog.**

Vector sources are the source of truth. The store assets are derived from these files by
the pipeline below; if you change a mark, regenerate rather than editing a raster.

| | |
|---|---|
| Plate | `#67A63A` (matcha, hue 95°) |
| Mark | stack plus sphere |
| Icon | `icon.svg` — 1024x1024 |
| Cover | `cover.svg` — 1600x900 |

## The mark

A seal: a diamond frame enclosing one solid core. The frame is the corpus the assistant reads; the core is the single distilled answer. Four-fold symmetric, so there is no letterform to collapse into.

Shades are **tonal** — every element is the plate hue at a different lightness
(`-0.13` for bodies, `+0.30` for the hot element). Nothing introduces a second hue, which
is what lets the colour-normalisation step below correct the plate without dragging an
accent off its own value.

## How the store assets are built

Three stages. Each does something the others cannot:

1. **Author** (`icon.svg` / `cover.svg`) — exact geometry, exact hex, exact direction.
2. **Light** — img2img adds studio lighting while preserving composition:
   `civitai generate "<lighting prompt>" --ecosystem NanoBanana --checkpoint 2725610 --image <authored.png> --aspect-ratio 1:1` (covers: `--aspect-ratio 16:9`).
3. **Normalise** — a global modulate computed from the plate's own measured offset lands it
   back on `#67A63A` exactly.

🔴 **Why not generate the mark directly?** It was tried, twice. Text-to-image steers hue
well but cannot be relied on for *meaning*: a "disc with a wedge cut out" renders as a cone,
an "open cylinder" as a cup, and a triangle told to point right pointed up. Authoring
removes that whole class — a drawn triangle cannot render the wrong way.

🔴 **Why not author the whole thing?** A flat vector cannot carry the lit dimensional
grammar the suite uses. Stage 2 is what supplies it.

## 🔴 The COVER is no longer built from `cover.svg`

`cover.svg` here is the superseded rev-5 cover: this app's icon mark tiled on a grid. It is
kept only as the vector record of that design. **The live cover is a photographed scene** —
the app's purpose expressed by analogy — generated rather than derived from a vector, because
a pattern of our own glyph had no soul and was the worst available use of the generator.

- Live cover source + rationale: `claudedocs/brand-assets-rev5-2026-08-13/COVERS-REV5.1.md`
  in the `talos-infra` repo (private).
- **`icon.svg` IS still the source of truth for the icon** — that half is unchanged.

Do not regenerate the cover from `cover.svg`.

## Gates

Every asset is checked before it is attached:

- plate **dE <= 3.0** against `#67A63A` after normalisation
- icon aspect 0.9-1.1, 128-4096 px, <= 1 MiB · cover aspect 1.3-2.4, min width 640, <= 4 MiB
- renders legibly at **128 px** on both store themes (light `#F7F9FC` and dark `#0B0E14`)
- the plate is **edge to edge** — the margin lives inside it. Never a surround: JPEG has no
  alpha, so a baked surround cannot be cropped away and it destroys dual-theme survivability.

## Palette

The suite's seven hues are spaced at least **42°** apart, all at a common lightness, so a
row of them in the store reads as one family while each stays individually identifiable.
The full wheel and the method live in the cross-app brand book.

## Rejected, and why

Kept so the next person does not re-derive them:

- **a thick upright tablet at a three-quarter angle with a small square recess** — dodged the 'I'/'1' letterform as intended but landed on a light-switch plate. The stack-plus-sphere carries the product truth directly: the corpus it reads, and the one distilled answer.
