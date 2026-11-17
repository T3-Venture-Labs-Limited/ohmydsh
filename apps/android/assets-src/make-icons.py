#!/usr/bin/env python3
"""Regenerate the Android launcher icon layers from the brand mark (assets/logo.svg). Needs rsvg-convert."""
import re, subprocess, sys, pathlib
root = pathlib.Path(__file__).resolve().parent
res = root.parent / 'app/src/main/res'
src = (root / 'logo.svg').read_text()
inner = re.search(r'<defs>.*</svg>', src, re.S).group(0)[:-len('</svg>')].strip()
SIZES = {'mdpi': 108, 'hdpi': 162, 'xhdpi': 216, 'xxhdpi': 324, 'xxxhdpi': 432}

def layer(size, mono):
    scale = (size * 60 / 108) / 448  # the mark's circle (r=224) fills the 60dp safe zone of the 108dp layer
    off = size / 2 - 256 * scale
    body = inner.replace('#4D6BFE', '#FFFFFF') if mono else inner
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 {size} {size}"><g transform="translate({off} {off}) scale({scale})">{body}</g></svg>'

for density, size in SIZES.items():
    for mono, name in ((False, 'ic_launcher_foreground'), (True, 'ic_launcher_monochrome')):
        out = res / f'mipmap-{density}' / f'{name}.png'
        out.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(['rsvg-convert', '-o', str(out)], input=layer(size, mono).encode(), check=True)
    # legacy (pre-8.0) full icon: the dark tile with the mark, 48dp base
    legacy = {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}[density]
    for name in ('ic_launcher', 'ic_launcher_round'):
        subprocess.run(['rsvg-convert', '-w', str(legacy), '-h', str(legacy), '-o', str(res / f'mipmap-{density}' / f'{name}.png'), str(root / 'app-icon.svg')], check=True)
subprocess.run(['rsvg-convert', '-w', '1000', '-o', str(res / 'drawable-nodpi/lockup.png'), str(root / 'lockup.svg')], check=True)
(res / 'drawable-night-nodpi').mkdir(exist_ok=True)
subprocess.run(['rsvg-convert', '-w', '1000', '-o', str(res / 'drawable-night-nodpi/lockup.png'), str(root / 'lockup-dark.svg')], check=True)
print('icons written')
