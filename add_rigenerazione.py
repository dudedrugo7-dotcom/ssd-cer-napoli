#!/usr/bin/env python3
"""
SSD v8 — Attribuisce a ogni sezione il TIPO DI RIGENERAZIONE abilitato dall'area idonea
su cui ricade, letto dal codice Corine Land Cover 2018 dei perimetri della Piattaforma
Aree Idonee.

Le aree idonee del DM 21/06/2024 non sono superfici omogenee: una cava dismessa, un'area
produttiva, una fascia ferroviaria o un sedime portuale abilitano trasformazioni urbane
diverse. Distinguerle permette di dire non solo dove installare, ma quale rigenerazione
l'impianto accompagna.

USO:  python add_rigenerazione.py
"""
import json, sys
from pathlib import Path

try: sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception: pass

HERE = Path(__file__).resolve().parent
IDONEE = Path(r'C:\Progetti_GIS\GIS_lisbona\napoli\Geodatabase\Aree_idonee.geojson')
DATASET = HERE / 'dataset.json'

# Corine Land Cover 2018 → categoria di rigenerazione urbana
TIPI = {
    'cava': {'n':'Cava o area estrattiva', 'col':'#b45309',
             'd':'Sito estrattivo cessato o in dismissione. Il recupero ambientale è un obbligo di legge: '
                 'il fotovoltaico può finanziarlo e dare una destinazione stabile a un vuoto altrimenti inerte.'},
    '121':  {'n':'Area produttiva e dei servizi', 'col':'#e3b341',
             'd':'Insediamenti industriali, commerciali e di servizio. Riuso di coperture esistenti senza '
                 'consumo di nuovo suolo, con possibilità di riqualificare comparti in dismissione.'},
    '122':  {'n':'Fascia infrastrutturale', 'col':'#94a3b8',
             'd':'Sedimi stradali e ferroviari con relative pertinenze. Superfici residuali già compromesse: '
                 'alto valore energetico, scarso ritorno in qualità urbana.'},
    '123':  {'n':'Ambito portuale', 'col':'#38bdf8',
             'd':'Sedime del porto. Grandi superfici e utenze energivore contigue, ma governance separata '
                 '(Autorità di Sistema Portuale): richiede un accordo dedicato.'},
    '124':  {'n':'Ambito aeroportuale', 'col':'#a78bfa',
             'd':'Sedime aeroportuale di Capodichino. Vincoli aeronautici su riflessioni e ostacoli: '
                 'attivabile solo con il gestore e l\'ENAC.'},
}

def rings_of(g):
    t, co = g.get('type'), g.get('coordinates') or []
    if t == 'Polygon': return [co[0]] if co else []
    if t == 'MultiPolygon': return [p[0] for p in co if p]
    return []

def inside(x, y, ring):
    c = False; n = len(ring)
    for k in range(n):
        x1, y1 = ring[k][0], ring[k][1]; x2, y2 = ring[(k+1) % n][0], ring[(k+1) % n][1]
        if ((y1 > y) != (y2 > y)) and (x < (x2-x1)*(y-y1)/((y2-y1) or 1e-12) + x1):
            c = not c
    return c

def main():
    ds = json.loads(DATASET.read_text(encoding='utf-8'))
    gj = json.loads(IDONEE.read_text(encoding='utf-8'))

    polys = []
    for f in gj.get('features', []):
        p = f.get('properties', {})
        definizione = str(p.get('definition') or '')
        code = str(p.get('Code_18') or '').strip()
        key = 'cava' if 'estrattiv' in definizione.lower() else (code if code in TIPI else None)
        if key is None: continue
        for r in rings_of(f.get('geometry') or {}):
            xs = [q[0] for q in r]; ys = [q[1] for q in r]
            polys.append((key, r, (min(xs), min(ys), max(xs), max(ys)),
                          float(p.get('Area_Ha') or 0)))
    print(f'perimetri idonei classificati: {len(polys)}')

    from collections import Counter
    cnt, assigned = Counter(), 0
    for s in ds['sezioni']:
        s.pop('rig', None)
        if normStatusIsFac(s) is False: continue
        c = s.get('c')
        if not c: continue
        x, y = c[0], c[1]
        for key, ring, bb, ha in polys:
            if bb[0] <= x <= bb[2] and bb[1] <= y <= bb[3] and inside(x, y, ring):
                s['rig'] = key; cnt[key] += 1; assigned += 1
                break
    print(f'sezioni idonee con tipo di rigenerazione: {assigned}')
    for k, v in cnt.most_common():
        print(f'  {TIPI[k]["n"]}: {v} sezioni')

    ds['meta']['rigenerazione'] = {k: {'n': v['n'], 'col': v['col'], 'd': v['d']} for k, v in TIPI.items()}
    DATASET.write_text(json.dumps(ds, separators=(',', ':'), ensure_ascii=False), encoding='utf-8')
    print(f'\nscritto {DATASET.name}: {DATASET.stat().st_size/1024/1024:.1f} MB')

def normStatusIsFac(s):
    """Solo le sezioni a prevalenza idonea: le altre non abilitano rigenerazione via FER."""
    n = s.get('nrm')
    if not n: return False
    i, o, nn = n.get('i', 0), n.get('o', 0), n.get('n', 0)
    if nn >= i and nn >= o: return False
    return i > o

if __name__ == '__main__':
    main()
