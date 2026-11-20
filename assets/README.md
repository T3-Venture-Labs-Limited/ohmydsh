# Brand assets

| File | Use |
|---|---|
| `logo.svg`, `logo-512.png` | Mark: a DeepSeek-blue circle with a whale cut out of it |
| `mark.svg` | One-colour mark (`currentColor`) |
| `wordmark.svg` | "ohmydsh", outlined (no font needed), `currentColor` |
| `lockup.svg`, `lockup-dark.svg`, `lockup.png` | Mark + wordmark, for light and dark backgrounds |
| `app-icon.svg`, `app-icon-1024.png` | App icon (desktop, Android) |
| `lockup-white.svg` | All-white lockup for dark or photo backgrounds |
| `hero.svg`, `hero.png`, `social-preview.png` | README banner and link preview |
| `wallpaper.svg`, `wallpaper-4k.png`, `wallpaper-1080p.png` | Desktop wallpaper (dark, logo centred) |

Colours: blue `#4D6BFE`, ink `#0A0A0A`, night `#0B0B0D`, paper `#F4F4F2`.

Type: the name is drawn in the style of DeepSeek's own logo lettering: lowercase, geometric, with squared-off curves. `d` and `s` are DeepSeek's letters. `o` is built from their `e`; `h` and `m` from their `p`; `y` is an upside-down `h`. It is always lowercase "ohmydsh" and is not a font, so use the SVGs. The banner tagline is set in Montserrat, which is licensed under the SIL Open Font License 1.1 (see `FONT-LICENSE-Montserrat.txt`).

The app copies are generated from these files. After changing a mark, lockup or app icon, copy it to `apps/android/assets-src/` and run `node apps/desktop/scripts/make-icons.mjs` and `python3 apps/android/assets-src/make-icons.py` (both need `rsvg-convert`; the desktop one also needs ImageMagick).
