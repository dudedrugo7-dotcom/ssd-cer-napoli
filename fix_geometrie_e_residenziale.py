#!/usr/bin/env python3
"""
SSD v8 — Due correzioni sui dati:

1. GEOMETRIE — riscrive il contorno di TUTTE le sezioni dalla fonte, con
   semplificazione fine (~2 m) e tutti gli anelli, e aggiunge le sezioni mancanti.
   Elimina i buchi neri fra le sezioni causati dalla vecchia semplificazione a 12 m.

2. FOTOVOLTAICO RESIDENZIALE — stima la producibilità dei tetti residenziali privati
   (finora assente) dalle impronte in footprints.json:
        MWh = superficie · R · c·η·PR / 1000
   con R = radiazione media annua sui tetti di Napoli e c·η·PR = 0,085, gli stessi
   coefficienti usati per ERP, pubblico e industriale. Aggiunge `fv_res`, `sup_res`,
   `res_b` e ricalcola `fv_tot` come somma delle quattro fonti.

USO:  python fix_geometrie_e_residenziale.py
"""
import json, math, sys
from pathlib import Path

try: sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception: pass

HERE = Path(__file__).resolve().parent
GDB  = Path(r'C:\Progetti_GIS\GIS_lisbona\napoli\Geodatabase')
SEZ_SRC = GDB / 'ERP_sezioni_final_FeaturesToJSO.geojson'
DATASET = HERE / 'dataset.json'
FOOT    = HERE / 'footprints.json'

TOL = 0.000018          # ~1,8 m: contorni fedeli, nessuna fessura fra sezioni
R_KWH_M2 = 1100.0       # radiazione media annua sui tetti (coerente con i dati FV esistenti)
NET = 0.085             # c · η · PR = 0,50 · 0,20 · 0,85

def dp(pts, tol):
    if len(pts) < 3: return pts
    def perp(pt, a, b):
        (x, y), (x1, y1), (x2, y2) = pt, a, b
        dx, dy = x2 - x1, y2 - y1
        if dx == 0 and dy == 0: return math.hypot(x - x1, y - y1)
        t = max(0, min(1, ((x - x1)*dx + (y - y1)*dy) / (dx*dx + dy*dy)))
        return math.hypot(x - (x1 + t*dx), y - (y1 + t*dy))
    dmax, idx = 0, 0
    for k in range(1, len(pts) - 1):
        d = perp(pts[k], pts[0], pts[-1])
        if d > dmax: dmax, idx = d, k
    if dmax > tol:
        return dp(pts[:idx+1], tol)[:-1] + dp(pts[idx:], tol)
    return [pts[0], pts[-1]]

def rings_of(geom):
    """Tutti gli anelli esterni della geometria (Polygon o MultiPolygon)."""
    t, co = geom.get('type'), geom.get('coordinates') or []
    if t == 'Polygon':   return [co[0]] if co else []
    if t == 'MultiPolygon': return [p[0] for p in co if p]
    return []

def centroid(ring):
    xs = [p[0] for p in ring]; ys = [p[1] for p in ring]
    return [round(sum(xs)/len(xs), 6), round(sum(ys)/len(ys), 6)]

def main():
    ds = json.loads(DATASET.read_text(encoding='utf-8'))
    by_id = {s['id']: s for s in ds['sezioni']}
    print(f'dataset: {len(ds["sezioni"])} sezioni')

    # ---------- 1. geometrie ----------
    gj = json.loads(SEZ_SRC.read_text(encoding='utf-8'))
    aggiornate, aggiunte, scartate = 0, 0, 0
    for f in gj.get('features', []):
        p = f.get('properties', {})
        try: sid = int(float(p.get('SEZ21')))
        except (TypeError, ValueError): continue
        rings = []
        for r in rings_of(f.get('geometry') or {}):
            pts = dp([(pt[0], pt[1]) for pt in r], TOL)
            if len(pts) >= 4:
                rings.append([[round(x, 6), round(y, 6)] for x, y in pts])
        if not rings: scartate += 1; continue
        s = by_id.get(sid)
        if s is None:
            # sezione assente dal dataset: entra come tessera del mosaico
            s = {'id': sid, 'cab': p.get('COD_AC') or 'NONE', 'pop': 0, 'pop_vuln': 0,
                 'pop_nonvuln': 0, 'fam': 0, 'erp_b': 0, 'sup_erp': 0, 'erp_pct': 0,
                 'fv_mwh': 0, 'fv_raw': 0, 'pub_b': 0, 'sup_pub': 0, 'fv_pub': 0,
                 'ind_b': 0, 'sup_ind': 0, 'fv_ind': 0, 'fv_tot': 0, 'cons_tot': 0,
                 'cons_vuln': 0, 'cons_nonvuln': 0, 'fv_to_vuln': 0, 'fv_to_nonvuln': 0,
                 'fv_residual': 0, 'cov_vuln': 0, 'cov_tot': 0, 'ivsm': 0, 'ivsm_raw': 0,
                 'ivsm_class': '', 'cer_class': '', 'priorita': 0, 'edu_low': 0, 'old70': 0,
                 'emp_vuln': 0, 'pv60': 0, 'pv70': 0, 'pv80': 0, 'cv60': 0, 'cv70': 0,
                 'cv80': 0, 'dens': 0, 'area': 0, 'empty': True}
            ds['sezioni'].append(s); by_id[sid] = s; aggiunte += 1
        s['geom'] = rings[0]                       # retro-compatibilità
        if len(rings) > 1: s['gs'] = rings         # tutti gli anelli, per il disegno
        else: s.pop('gs', None)
        s['c'] = centroid(rings[0])
        aggiornate += 1
    print(f'geometrie: {aggiornate} riscritte (~1,8 m) · {aggiunte} sezioni aggiunte · '
          f'{scartate} senza contorno valido')
    multi = sum(1 for s in ds['sezioni'] if s.get('gs'))
    print(f'  sezioni con più parti: {multi}')

    # ---------- 2. fotovoltaico residenziale ----------
    if not FOOT.exists():
        print('footprints.json assente: salto la stima residenziale')
    else:
        fp = json.loads(FOOT.read_text(encoding='utf-8'))
        agg = {}
        for b in fp['b']:
            if b[0] != 'r': continue
            sid, area = b[1], b[2] or 0
            if not sid or area <= 0: continue
            a = agg.setdefault(sid, [0, 0])
            a[0] += area; a[1] += 1
        tot_mwh = 0.0
        for s in ds['sezioni']:
            area, nb = agg.get(s['id'], (0, 0))
            fv = round(area * R_KWH_M2 * NET / 1000, 3)
            s['sup_res'] = round(area, 1)
            s['res_b']   = nb
            s['fv_res']  = fv
            s['fv_tot']  = round((s.get('fv_mwh') or 0) + (s.get('fv_pub') or 0) +
                                 (s.get('fv_ind') or 0) + fv, 3)
            tot_mwh += fv
        print(f'residenziale: {len(agg)} sezioni con tetti privati · '
              f'{tot_mwh/1000:,.1f} GWh/a stimati (R={R_KWH_M2:.0f} kWh/m², netto {NET})')
        con_prod = sum(1 for s in ds['sezioni'] if (s.get('fv_tot') or 0) > 0)
        print(f'  sezioni con produzione > 0: {con_prod}/{len(ds["sezioni"])} '
              f'(prima erano {sum(1 for s in ds["sezioni"] if (s.get("fv_mwh") or 0)+(s.get("fv_pub") or 0)+(s.get("fv_ind") or 0) > 0)})')

    # ---------- aggregati per cabina ----------
    for c in ds['cabine']:
        sez = [s for s in ds['sezioni'] if s['cab'] == c['id']]
        c['fv_res_mwh'] = round(sum(s.get('fv_res') or 0 for s in sez), 1)
        c['res_buildings'] = sum(s.get('res_b') or 0 for s in sez)
        c['sup_res_m2'] = round(sum(s.get('sup_res') or 0 for s in sez))
        c['fv_tot_mwh'] = round((c.get('fv_erp_mwh') or 0) + (c.get('fv_pub_mwh') or 0) +
                                (c.get('fv_ind_mwh') or 0) + c['fv_res_mwh'], 1)
    ds['meta']['has_residenziale'] = True
    ds['meta']['r_kwh_m2'] = R_KWH_M2

    DATASET.write_text(json.dumps(ds, separators=(',', ':'), ensure_ascii=False), encoding='utf-8')
    print(f'\nscritto {DATASET.name}: {DATASET.stat().st_size/1024/1024:.1f} MB · '
          f'{len(ds["sezioni"])} sezioni')

if __name__ == '__main__':
    main()
