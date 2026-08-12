# Civitai Sensei — brand

> *Ask. It reads the catalog.*

Store assets for this app's Civitai App listing. **These files are the source of truth for
this app's identity** — the listing images are exported from them, not the other way round.

## Identity

**Voice.** The patient teacher. Knows the catalog cold and never makes you feel small for asking. It does not perform expertise — it answers, and it shows what it read. Calm and declarative, never chatty: *"Nine checkpoints match. Three are worth your Buzz."*

**Motif.** **The seal.** One thick diamond outline enclosing a single solid core. The frame is the corpus the assistant reads; the core is the one distilled answer. Two elements only, which makes it the most legible mark in the suite at the 128px the `/apps` grid actually renders.

## Palette

| Role | Hex | |
|---|---|---|
| Plate / dominant | `#7CB342` | matcha — the icon background, edge to edge |
| Secondary | `#C8E6A0` | the frame |
| Accent | `#E8503A` | cinnabar — the answer; used sparingly, one element only |
| Cover ground | `#0B0E14` | |

The dominant was chosen by **measuring the free arc** on the suite's palette wheel, not by
taste: `33°→172°` was the widest gap left, and matcha's `89°` sits `54°` from its nearest
neighbour (App Requests) against a `40°` bar. Do the same if you ever move it.

## Files

| File | Purpose |
|---|---|
| `icon.svg` | listing icon, 1024×1024 — hand-authored |
| `cover.svg` | listing cover, 1600×900 — **generated, do not hand-edit** |
| `gen-cover.sh` | regenerates `cover.svg`; deterministic, byte-reproducible |

`cover.svg` is emitted by the script — edit `gen-cover.sh` and re-run it, or your change is
lost the next time anyone regenerates:

```bash
bash brand/gen-cover.sh brand/cover.svg
```

Export with `rsvg-convert`:

```bash
rsvg-convert -w 1024 -h 1024 brand/icon.svg  -o /tmp/icon.png
rsvg-convert -w 1600 -h 900  brand/cover.svg -o /tmp/cover.png
```

🔴 **Flatten the icon's corners onto the plate colour before uploading** — do not upload it
with transparency:

```bash
magick /tmp/icon.png -background '#7CB342' -alpha remove -alpha off PNG24:/tmp/icon-upload.png
```

The listing pipeline transcodes every asset to JPEG, which has no alpha channel, and the
transparency is flattened to **black**. The store then clips the icon with a CSS avatar mask
that is slightly *less* rounded than the plate, so a thin dark rim survives along the curve.
Filling the corners with the plate colour removes the whole class — there is no transparency
left to flatten. Verified on the live asset: all four corners of the served 320×320 icon read
`srgb(125,179,67)`, the plate, not black.

Attach with:

```bash
civitai app listing set-icon  /tmp/icon-upload.png
civitai app listing set-cover /tmp/cover.png
```

On a live listing this opens a revision for moderator re-review; the current assets stay
visible until it is approved. Setting the icon and cover in the same session puts both on one
revision, so they are reviewed together.

> On a listing that is **below the publish floor** (no icon *and* no cover yet), `set-icon`
> alone used to fail with a 400 and a non-zero exit even though it had stored the icon —
> `civitai/cli#400`, fixed in `#403`, shipping in **v0.1.94**. On an older binary, set the
> icon, ignore that specific 400, then set the cover.

## Shared construction grammar

This app is one of **six** first-party apps drawn to a common grammar, so a row of them reads
as a suite while each stays individually memorable. Keep to it when changing anything here:

- Flat vector. Solid fills only — no gradients, shading, bevel, glow or 3D.
- Geometric primitives only: squares, triangles, circles, arcs, rings.
- Thick, uniform stroke weight. This is the strongest family signal at thumbnail size.
- Three colours maximum: one dominant, one accent, one neutral.
- The plate fills the whole canvas **edge to edge**; the margin lives *inside* it, around the
  mark. Never ask for margin *around* the plate — that bakes in a surround the store cannot
  crop past the rounded corners.
- **No lettering anywhere** — and that includes motifs whose skeleton *constructs* a letter or
  digit. Before locking a shape, ask what character it resembles.
- Never name a direction with a noun that already implies one. Say the geometry.

## App-specific notes

**The accent is sized against the suite, not by eye.** The first draft's core was half-diagonal
190, which is **6.89%** of the plate — the five sibling accents measure 0.13 / 1.18 / 1.69 /
1.78 / 2.79%, so it was 4.1× the median and 2.5× the max. It looked fine in isolation and only
read as an outlier once all six were rendered in one row *and* the siblings were measured.
Shipped at half-diagonal **140** = 3.71%. If you change the core, measure it again.

**Four motifs were rejected, all on priors the suite had already paid for:** a quincunx of five
diamonds reads as `+` or `×`; radial rays around a warm dot is the sun-rays prior that killed
Panorama's third revision twice out of two; a magnifier is both a letterform risk (`Q`) and the
most generic search cliché in the category; centred text-lines collide with Custom Generators'
taper.

**Three accents were rejected, on both store themes at 300px and 128px:** magenta `#E14BC8`
vibrates against the green at equal chroma; gold `#FFD166` is L\*86 against the frame's L\*87,
so core and frame **merge into one pale mass** at thumbnail size — predicted from the L\*
numbers, then confirmed on screen; coral `#FF6B57` sits closest to Playable Collections'
dominant.

**The cover ramps per COLUMN, never per diamond.** The first cut thresholded each diamond on
its radial distance to the seal, which produced a jagged tint/matcha boundary mid-lattice — it
read as a rendering fault rather than a decision.

## If you regenerate these

These were drawn as vector rather than generated, after three measured rounds established that
the constraints above and diffusion are structurally mismatched: across 42 generated images,
flat solid fills held 0/20, exact palette 1/10, and the alpha channel 0/20. Generation is
useful for *finding* a composition and poor at *meeting* a spec. If you use it, treat the
output as a sketch and redraw the winner in vector — and judge a candidate by what a stranger
would say it depicts, not by whether it matches the prompt.
