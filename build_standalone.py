#!/usr/bin/env python3
"""
SSD v8 — Genera lo standalone unico (SSD-v8-Napoli-standalone.html):
index.html + app.js + dataset.json + aree_overlay.json + footprints.json in un solo file.
Leaflet viene incorporato, così l'SSD si apre anche senza connessione.
"""
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
html = (HERE / 'index.html').read_text(encoding='utf-8')
app  = (HERE / 'app.js').read_text(encoding='utf-8')
ds   = (HERE / 'dataset.json').read_text(encoding='utf-8')
ov_p = HERE / 'aree_overlay.json'
ov   = ov_p.read_text(encoding='utf-8') if ov_p.exists() else 'null'
fp_p = HERE / 'footprints.json'
fp   = fp_p.read_text(encoding='utf-8') if fp_p.exists() else 'null'

# Sostituisce il loader fetch(...) con l'assegnazione dei dati embedded
app = re.sub(
    r"fetch\('dataset\.json'\).*?initApp\(\); \}\);",
    ("DATA = __EMBEDDED_DATASET__; OVERLAY = __EMBEDDED_OVERLAY__; FOOTPRINTS = __EMBEDDED_FOOTPRINTS__; "
     "document.readyState==='loading' ? document.addEventListener('DOMContentLoaded', initApp) : initApp();"),
    app, count=1, flags=re.S)
assert '__EMBEDDED_DATASET__' in app, 'loader fetch non trovato in app.js'

# Leaflet incorporato: senza CDN la pagina resterebbe bianca su un PC offline
lj, lc = HERE / 'leaflet.js', HERE / 'leaflet.css'
if lj.exists() and lc.exists():
    html = html.replace('<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">',
                        f'<style>\n{lc.read_text(encoding="utf-8")}\n</style>')
    html = html.replace('<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>',
                        f'<script>\n{lj.read_text(encoding="utf-8")}\n</script>')
    print("Leaflet incorporato (nessuna dipendenza da internet per avviare l'app)")
else:
    print('ATTENZIONE: leaflet.js/leaflet.css assenti, resta il collegamento al CDN')

# I font Google sono decorativi: senza rete il browser usa i fallback di sistema
html = html.replace('<link rel="preconnect" href="https://fonts.googleapis.com">', '')
html = html.replace('<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>', '')

MARK = '<script src="app.js"></script>'
assert MARK in html, 'tag <script src="app.js"> non trovato in index.html'
head, tail = html.split(MARK, 1)

# Scrittura a blocchi: i dati sono decine di MB, concatenarli in un'unica
# stringa esaurirebbe la memoria del processo.
dst = HERE / 'SSD-v8-Napoli-standalone.html'
with dst.open('w', encoding='utf-8') as f:
    f.write(head)
    f.write('<script>\nconst __EMBEDDED_DATASET__ = ');   f.write(ds)
    f.write(';\nconst __EMBEDDED_OVERLAY__ = ');          f.write(ov)
    f.write(';\nconst __EMBEDDED_FOOTPRINTS__ = ');       f.write(fp)
    f.write(';\n</script>\n<script>\n');                  f.write(app)
    f.write('\n</script>')
    f.write(tail)
print(f'scritto {dst.name}: {dst.stat().st_size/1024/1024:.1f} MB')
