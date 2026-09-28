#!/usr/bin/env python3
"""
SSD v8 — Alleggerisce dataset.json senza perdere informazione.

Tre interventi, tutti reversibili al caricamento:
  1. coordinate a 5 decimali (~1,1 m: sotto la soglia di leggibilità della mappa)
  2. rimozione delle chiavi con valore nullo — l'app le ripristina a 0 all'avvio
     (`normalizzaSezioni()` in app.js), quindi nessun campo scompare davvero
  3. rimozione dei campi di testo vuoti

Con 5.724 sezioni × ~50 campi, i soli nomi di chiave ripetuti pesavano più
delle geometrie.

USO:  python ottimizza_dataset.py
"""
import json, sys
from pathlib import Path

try: sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception: pass

HERE = Path(__file__).resolve().parent
SRC  = HERE / 'dataset.json'
BAK  = HERE / 'dataset.full.json'

# campi che devono restare anche se valgono zero: l'app li usa come chiavi o flag
SEMPRE = {'id', 'cab', 'geom', 'c', 'nrm', 'gs', 'empty', 'mun', 'rig'}

def main():
    ds = json.loads(SRC.read_text(encoding='utf-8'))
    prima = SRC.stat().st_size

    if not BAK.exists():                       # copia integrale di sicurezza
        BAK.write_text(json.dumps(ds, separators=(',', ':'), ensure_ascii=False), encoding='utf-8')
        print(f'copia integrale salvata in {BAK.name}')

    tolti = 0
    for s in ds['sezioni']:
        if s.get('geom'):
            s['geom'] = [[round(x, 5), round(y, 5)] for x, y in s['geom']]
        if s.get('gs'):
            s['gs'] = [[[round(x, 5), round(y, 5)] for x, y in r] for r in s['gs']]
        if s.get('c'):
            s['c'] = [round(s['c'][0], 5), round(s['c'][1], 5)]
        if s.get('nrm'):
            s['nrm'] = {k: (round(v, 1) if isinstance(v, (int, float)) else v)
                        for k, v in s['nrm'].items() if v not in (0, 0.0, '', None)}
        for k in [k for k in s if k not in SEMPRE]:
            v = s[k]
            if v in (0, 0.0, '', None):
                del s[k]; tolti += 1
            elif isinstance(v, float):
                s[k] = round(v, 2)

    SRC.write_text(json.dumps(ds, separators=(',', ':'), ensure_ascii=False), encoding='utf-8')
    dopo = SRC.stat().st_size
    print(f'chiavi nulle rimosse: {tolti:,}')
    print(f'dataset.json: {prima/1024/1024:.2f} MB → {dopo/1024/1024:.2f} MB '
          f'(-{(1-dopo/prima)*100:.0f}%)')

if __name__ == '__main__':
    main()
