#!/usr/bin/env python3
"""
Genera i confini delle 10 Municipalità di Napoli DISSOLVENDO le sezioni censuarie.

Risponde all'osservazione in revisione: usando un file di municipalità di fonte
diversa, i due perimetri non coincidono e in Fig.2 si vedono disallineamenti.
Derivandoli dalle stesse sezioni che compongono la mappa, la coincidenza è esatta
per costruzione.

Nota: il campo con il codice di Municipalità (COM_ASC1, formato 63049NNN) è già
presente nelle sezioni ISTAT, quindi lo spatial join non serve: basta il dissolve.

USO:  python crea_municipalita.py
OUT:  Municipalita_da_sezioni.geojson  (WGS84, 10 poligoni)
"""
import json, sys
from pathlib import Path
from collections import defaultdict

try: sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception: pass

from shapely.geometry import shape, mapping
from shapely.ops import unary_union

SRC = Path(r'C:\Progetti_GIS\GIS_lisbona\napoli\Geodatabase\ERP_sezioni_final_FeaturesToJSO.geojson')
OUT = Path(__file__).resolve().parent / 'Municipalita_da_sezioni.geojson'

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
    gj = json.loads(SRC.read_text(encoding='utf-8'))
    per_mun = defaultdict(list)
    pop = defaultdict(int)
    scartate = 0

    for f in gj.get('features', []):
        p = f.get('properties', {})
        code = str(p.get('COM_ASC1') or '')
        if len(code) < 3 or not code[-3:].isdigit():
            scartate += 1; continue
        m = int(code[-3:])
        try:
            g = shape(f['geometry']).buffer(0)      # buffer(0) ripara auto-intersezioni
        except Exception:
            scartate += 1; continue
        if g.is_empty: continue
        per_mun[m].append(g)
        try: pop[m] += int(float(p.get('POP21') or 0))
        except (TypeError, ValueError): pass

    print(f'sezioni lette: {sum(len(v) for v in per_mun.values())} ({scartate} scartate)')

    feats = []
    for m in sorted(per_mun):
        u = unary_union(per_mun[m])
        # una piccola chiusura morfologica salda le fessure fra poligoni adiacenti
        u = u.buffer(0.000002).buffer(-0.000002)
        area_km2 = 0.0
        try:
            # area approssimata in km² alla latitudine di Napoli
            area_km2 = u.area * (111.32 ** 2) * 0.757
        except Exception:
            pass
        feats.append({
            'type': 'Feature',
            'properties': {'MUN': m, 'NOME': NOMI.get(m, f'Municipalità {m}'),
                           'SEZIONI': len(per_mun[m]), 'POP21': pop[m],
                           'AREA_KM2': round(area_km2, 2)},
            'geometry': mapping(u),
        })
        print(f"  Municipalità {m:>2}: {len(per_mun[m]):>4} sezioni · "
              f"{pop[m]:>7,} ab. · {area_km2:>6.2f} km² · "
              f"{'MultiPolygon' if u.geom_type=='MultiPolygon' else 'Polygon'}"
              f"{' (' + str(len(u.geoms)) + ' parti)' if u.geom_type=='MultiPolygon' else ''}")

    # --- GeoJSON per ArcGIS: tipo geometrico UNICO e proprietà ASCII ---
    # ArcGIS rifiuta i file che mescolano Polygon e MultiPolygon (la Municipalità 4
    # è in due parti) e può inciampare sui caratteri non ASCII negli attributi.
    for f in feats:
        g = f['geometry']
        if g['type'] == 'Polygon':
            g['type'] = 'MultiPolygon'; g['coordinates'] = [g['coordinates']]
        f['properties']['NOME'] = (f['properties']['NOME']
                                   .replace('·', '-').encode('ascii', 'ignore').decode())
    OUT.write_text(json.dumps({'type': 'FeatureCollection',
                               'crs': {'type': 'name',
                                       'properties': {'name': 'urn:ogc:def:crs:OGC:1.3:CRS84'}},
                               'features': feats}, ensure_ascii=True), encoding='utf-8')
    print(f'\nscritto {OUT.name}: {OUT.stat().st_size/1024/1024:.2f} MB · {len(feats)} municipalità '
          f'(tutte MultiPolygon, attributi ASCII)')

    # --- Shapefile: il formato che ArcGIS apre senza alcuna conversione ---
    try:
        import shapefile
        base = OUT.parent / 'Municipalita_da_sezioni'
        w = shapefile.Writer(str(base), shapeType=shapefile.POLYGON)
        w.field('MUN', 'N', 3); w.field('NOME', 'C', 80)
        w.field('SEZIONI', 'N', 6); w.field('POP21', 'N', 9); w.field('AREA_KM2', 'F', 10, 2)
        for f in feats:
            parti = []
            for poly in f['geometry']['coordinates']:
                for anello in poly:
                    parti.append([[float(x), float(y)] for x, y in anello])
            w.poly(parti)
            pr = f['properties']
            w.record(pr['MUN'], pr['NOME'], pr['SEZIONI'], pr['POP21'], pr['AREA_KM2'])
        w.close()
        # sistema di riferimento WGS84, richiesto da ArcGIS per posizionare il layer
        (base.with_suffix('.prj')).write_text(
            'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],'
            'PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]', encoding='utf-8')
        mb = sum((base.with_suffix(e)).stat().st_size for e in ('.shp', '.dbf', '.shx')) / 1024 / 1024
        print(f'scritto {base.name}.shp (+ .dbf .shx .prj): {mb:.2f} MB')
    except ImportError:
        print('pyshp non disponibile: shapefile non generato')

    # verifica: l'unione delle municipalità deve coincidere col comune
    tutte = unary_union([shape(f['geometry']) for f in feats])
    print(f"perimetro comunale ricostruito: {tutte.area*(111.32**2)*0.757:.2f} km² "
          f"({'contiguo' if tutte.geom_type=='Polygon' else str(len(tutte.geoms))+' parti (isole/enclave)'})")

if __name__ == '__main__':
    main()
