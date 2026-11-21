#!/usr/bin/env python3
"""Genera ../index.html (un solo archivo con todo el código) a partir de src/."""
from pathlib import Path

root = Path(__file__).resolve().parent
tpl = (root / 'src' / 'index.template.html').read_text(encoding='utf-8')
parts = {'SBCORE': 'sbcore.js', 'SCENE': 'scene.js', 'VIDEO': 'video.js', 'APP': 'app.js'}
html = tpl
for key, name in parts.items():
    code = (root / 'src' / name).read_text(encoding='utf-8')
    if '</script' in code.lower():
        raise SystemExit(f'{name}: contiene </script>')
    mark = f'/*__{key}__*/'
    if html.count(mark) != 1:
        raise SystemExit(f'falta el marcador {mark}')
    html = html.replace(mark, code)
out = root.parent / 'index.html'
out.write_text(html, encoding='utf-8')
print(out, len(html.encode('utf-8')), 'bytes')
