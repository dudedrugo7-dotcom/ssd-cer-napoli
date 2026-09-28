#!/usr/bin/env python3
"""
SSD v8 — Aggiunge la Municipalità (1-10) a ogni sezione censuaria.

Il codice sta nel campo COM_ASC1 delle sezioni ISTAT (formato 63049NNN, dove NNN
è il numero di Municipalità). La cabina primaria è il perimetro tecnico-legale
della condivisione, la Municipalità è l'unità della governance urbana: averle
entrambe permette di leggere gli stessi risultati nei due linguaggi.

USO:  python add_municipalita.py
"""
import json, sys
from pathlib import Path

try: sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception: pass

HERE = Path(__file__).resolve().parent
SRC  = Path(r'C:\Progetti_GIS\GIS_lisbona\napoli\Geodatabase\ERP_sezioni_final_FeaturesToJSO.geojson')
DATASET = HERE / 'dataset.json'

NOMI = {
    1: 'Chiaia · Posillipo · San Ferdinando',
    2: 'Avvocata · Montecalvario · Mercato · Pendino · Porto · San Giuseppe',
    3: "Stella · San Carlo all'Arena",
    4: 'San Lorenzo · Vicaria · Poggioreale · Zona Industriale',
    5: 'Arenella · Vomero',
    6: 'Barra · Ponticelli · San Giovanni a Teduccio',
    7: 'Miano · Secondigliano · San Pietro a Patierno',
    8: 'Chiaiano · Piscinola · Marianella · Scampia',
    9: 'Pianura · Soccavo',
    10: 'Bagnoli · Fuorigrotta',
}

def main():
    ds = json.loads(DATASET.read_text(encoding='utf-8'))
    by_id = {s['id']: s for s in ds['sezioni']}
    gj = json.loads(SRC.read_text(encoding='utf-8'))

    ok, miss = 0, 0
    for f in gj.get('features', []):
        p = f.get('properties', {})
        try: sid = int(float(p.get('SEZ21')))
        except (TypeError, ValueError): continue
        s = by_id.get(sid)
        if s is None: continue
        code = str(p.get('COM_ASC1') or '')
        if len(code) >= 3 and code[-3:].isdigit():
            s['mun'] = int(code[-3:]); ok += 1
        else:
            miss += 1
    print(f'municipalità assegnata a {ok} sezioni ({miss} senza codice)')

    ds['meta']['municipalita'] = {str(k): v for k, v in NOMI.items()}

    # quadro di sintesi: quanto le due geografie si sovrappongono
    from collections import defaultdict
    per_mun = defaultdict(lambda: defaultdict(int))
    for s in ds['sezioni']:
        m = s.get('mun')
        if m: per_mun[m][s['cab']] += 1
    print('\nMunicipalità → cabine primarie che la attraversano')
    for m in sorted(per_mun):
        cabs = sorted(per_mun[m].items(), key=lambda x: -x[1])
        tot = sum(per_mun[m].values())
        top = ' · '.join(f"{c.replace('AC001E00','')} ({n})" for c, n in cabs[:4])
        print(f'  {m:>2}  {tot:>4} sez. su {len(cabs)} cabine → {top}')

    DATASET.write_text(json.dumps(ds, separators=(',', ':'), ensure_ascii=False), encoding='utf-8')
    print(f'\nscritto {DATASET.name}: {DATASET.stat().st_size/1024/1024:.1f} MB')

if __name__ == '__main__':
    main()
