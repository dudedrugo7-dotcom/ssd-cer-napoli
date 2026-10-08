#!/usr/bin/env python3
"""
SSD v9 — Prepara dati.json, la base dati compatta e allineata alla tesi.

Parte da dataset.json (v8) e produce dati.json in formato colonnare.
Ogni intervento di allineamento è dichiarato qui e verificato in fondo:
lo script si ferma se un solo numero non coincide con le tabelle della tesi.

Allineamenti alla tesi (capitolo 6)
  1. Le tre sezioni senza cabina (non abitate) passano ad AC001E00190:
     così le sezioni per cabina coincidono con la Tab. 6.1 (1.122 per la 190).
  2. I MWh di pubblico e industriale delle sezioni sono riportati, cabina per
     cabina, sui totali di cabina delle Tab. 6.8 e 6.9: la somma per sezione
     torna a 107.529 e 231.516 MWh/a e la Tab. 6.12 torna al MWh.
  3. L'IVSM è arrotondato a un decimale e alcune sezioni cadono esattamente
     su 60,0 o 70,0. Chi è dentro o fuori la soglia è deciso dai campi pv60 e
     pv70, calcolati in GIS a piena precisione: la chiave di confronto viene
     spostata di 0,04 nel verso giusto. Con la regola IVSM >= soglia si
     ottengono così 73.408 vulnerabili a 60 e 6.450 a 70, cabina per cabina.
  4. "Offerta elevata" = FER_100 >= 70° percentile delle sezioni abitate
     (28,2): riproduce le 110 / 230 / 1.293 sezioni della Tab. 6.12.

USO:  python prepara_dati_v9.py
"""
import json, math, sys
from collections import defaultdict
from pathlib import Path

try: sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception: pass

HERE = Path(__file__).resolve().parent
SRC  = HERE / 'dataset.json'
DST  = HERE / 'dati.json'
MUNG = HERE / 'Municipalita_da_sezioni.geojson'
COMG = HERE / 'Comune_da_sezioni.geojson'

SCALE = 100000            # coordinate intere a 1e-5 gradi (~1 m)
C_TESI = 0.50             # coefficiente di utilizzazione delle coperture (Eq. 2)

# ---------------------------------------------------------------- tesi
# Tab. 6.1 — superfici, sezioni, popolazione
TAB61 = {
 'AC001E00201': (11.67, 738, 177860), 'AC001E00189': (24.17, 736, 147343),
 'AC001E00190': (6.62, 1122, 128052), 'AC001E00204': (14.13, 750, 127876),
 'AC001E00223': (9.29, 533, 96607),   'AC001E00191': (12.27, 359, 61437),
 'AC001E00192': (10.50, 478, 59034),  'AC001E00206': (14.01, 347, 50423),
 'AC001E00200': (4.19, 208, 26952),   'AC001E00205': (7.61, 211, 22207),
 'AC001E00207': (3.68, 174, 15914),   'AC001E00224': (1.01, 68, 7437),
}
# Tab. 6.6 / 6.8 / 6.9 / 6.11 — vulnerabili a 60 e 70, PV per destinazione
TAB66 = {  # id: (vuln60, vuln70, pv_erp, pv_pub, pv_ind, cop_eff_erp)
 'AC001E00223': (27207, 5193, 48738, 7417, 12167, 40.2),
 'AC001E00189': (17840, 74, 46668, 42250, 12416, 41.4),
 'AC001E00192': (8901, 360, 12981, 10024, 80424, 34.0),
 'AC001E00205': (7046, 42, 9673, 352, 54047, 36.9),
 'AC001E00207': (3566, 152, 8647, 2444, 10450, 52.9),
 'AC001E00204': (2482, 127, 5163, 7384, 36064, 37.1),
 'AC001E00191': (2153, 4, 6102, 8755, 18446, 50.2),
 'AC001E00200': (2132, 415, 15476, 2470, 1918, 79.4),
 'AC001E00224': (1323, 0, 3979, 2571, 1047, 55.1),
 'AC001E00206': (684, 76, 3278, 770, 3172, 26.1),
 'AC001E00201': (58, 3, 7651, 4317, 928, 0.0),
 'AC001E00190': (16, 4, 0, 18775, 436, 0.0),
}
# Tab. 6.7 e 6.11 — classi di priorità alle due soglie
CLASSI = {
 60: {'C1': {'223', '189', '192'}, 'C2': {'205', '207', '204'}},
 70: {'C1': {'223', '192', '200'}, 'C2': {'189', '207', '204', '206'}},
}
# Tab. 6.2 — classificazione regolatoria della superficie comunale
TAB62 = {'idonee': (21.14, 17.77), 'ordinarie': (74.18, 62.34), 'non_idonee': (23.67, 19.89)}
# Tab. 6.3 e 6.4 — coperture e producibilità per destinazione
TAB63 = {'res': 19190295, 'erp': 1928132, 'pub': 854136, 'ind': 1730477}
TAB64 = {'res': 1794293, 'erp': 168356, 'pub': 107529, 'ind': 231516}
# Tab. 6.12 — sezioni per condizione (soglia 60)
TAB612 = {'HH': (110, 0, 44054, 44054, 125388),
          'LH': (230, 0, 29354, 29354, 83810),
          'HL': (1293, 121, 470018, 0, 1193346)}
CONS_TESI = 2441          # kWh per abitante all'anno (Napoli 2020)


def g(s, k):
    v = s.get(k)
    return 0 if v is None else v


def enc_ring(ring):
    """[[lon,lat],...] -> [x0,y0,dx1,dy1,...] interi a 1e-5 gradi"""
    out, px, py = [], None, None
    for lon, lat in ring:
        x, y = round(lon * SCALE), round(lat * SCALE)
        if px is None: out += [x, y]
        else:
            dx, dy = x - px, y - py
            if dx == 0 and dy == 0: continue
            out += [dx, dy]
        px, py = x, y
    return out


def simplify_geojson(path, tol):
    """Confini semplificati (shapely) per l'orientamento senza mappa di base."""
    from shapely.geometry import shape, mapping
    gj = json.loads(path.read_text(encoding='utf-8'))
    out = []
    for ft in gj['features']:
        geom = shape(ft['geometry']).simplify(tol, preserve_topology=True)
        polys = [geom] if geom.geom_type == 'Polygon' else list(geom.geoms)
        rings = []
        for p in polys:
            if p.area < 2e-7:          # isolotti e frammenti < ~0,2 ha
                continue
            rings.append(enc_ring(list(p.exterior.coords)))
        out.append({'p': ft['properties'], 'r': rings})
    return out


def jenks3(values, min_size=3):
    v = sorted(values); n = len(v)
    def sdcm(a):
        if not a: return 0
        m = sum(a) / len(a); return sum((x - m) ** 2 for x in a)
    best = None
    for i in range(min_size, n - 2 * min_size + 1):
        for j in range(i + min_size, n - min_size + 1):
            s = sdcm(v[:i]) + sdcm(v[i:j]) + sdcm(v[j:])
            if best is None or s < best[0]: best = (s, v[i - 1], v[j - 1])
    return best[1], best[2]


# arrotondamenti come nelle tabelle della tesi (valore binario esatto, come toFixed in JS)
def r2(x): return round(x, 2)
def r1(x): return round(x, 1)


def percentile(vals, p):
    """come numpy.percentile (interpolazione lineare)"""
    v = sorted(vals); k = (len(v) - 1) * p / 100
    f = math.floor(k); c = math.ceil(k)
    return v[f] if f == c else v[f] + (v[c] - v[f]) * (k - f)


def main():
    ds = json.loads(SRC.read_text(encoding='utf-8'))
    S, C = ds['sezioni'], ds['cabine']

    # ---- ordine delle cabine: come nelle tabelle della tesi (vulnerabili decrescenti)
    order = sorted(TAB66, key=lambda k: -TAB66[k][0])
    cidx = {cid: i for i, cid in enumerate(order)}
    cab = {c['id']: c for c in C}

    # ---- 1. sezioni senza cabina -> AC001E00190 (Tab. 6.1)
    for s in S:
        if s['cab'] not in cab:
            assert g(s, 'pop') == 0
            s['cab'] = 'AC001E00190'

    # ---- 2. pubblico e industriale riportati sui totali di cabina
    som = defaultdict(lambda: defaultdict(float))
    for s in S:
        for k in ('fv_pub', 'fv_ind'): som[s['cab']][k] += g(s, k)
    for s in S:
        c = cab[s['cab']]
        for k, kc in (('fv_pub', 'fv_pub_mwh'), ('fv_ind', 'fv_ind_mwh')):
            if g(s, k) > 0:
                s[k] = g(s, k) * c[kc] / som[s['cab']][k]

    # ---- 3. chiave IVSM con i confini delle soglie risolti dai campi GIS
    spost = 0
    def chiave(s):
        nonlocal spost
        if s.get('ivsm') is None or g(s, 'pop') == 0: return None
        iv = round(s['ivsm'], 1)
        for T, f in ((60, 'pv60'), (70, 'pv70'), (80, 'pv80')):
            if abs(iv - T) < 1e-9:
                spost += 1
                return T + 0.04 if g(s, f) > 0 else T - 0.04
        return iv

    # ---- 4. soglia di offerta elevata
    fer_ab = [s['nrm']['fer'] for s in S if g(s, 'pop') > 0 and s.get('nrm') and s['nrm'].get('fer') is not None]
    fer_thr = round(percentile(fer_ab, 70), 1)

    # ---- colonne delle sezioni
    def i10(v): return -1 if v is None else int(round(v * 10))
    col = defaultdict(list)
    for s in S:
        n = s.get('nrm') or {}
        k = chiave(s)
        col['id'].append(s['id'])
        col['cab'].append(cidx[s['cab']])
        col['mun'].append(g(s, 'mun'))
        col['pop'].append(int(g(s, 'pop')))
        col['fam'].append(int(g(s, 'fam')))
        col['iv'].append(-1 if k is None else int(round(k * 100)))
        col['edu'].append(i10(s.get('edu_low')) if g(s, 'pop') else -1)
        col['emp'].append(i10(s.get('emp_vuln')) if g(s, 'pop') else -1)
        col['old'].append(i10(s.get('old70')) if g(s, 'pop') else -1)
        col['erpp'].append(i10(s.get('erp_pct')) if g(s, 'pop') else -1)
        for a, b in (('fe', 'fv_mwh'), ('fp', 'fv_pub'), ('fi', 'fv_ind'), ('fr', 'fv_res')):
            col[a].append(int(round(g(s, b) * 100)))     # MWh/a in centesimi
        for a, b in (('se', 'sup_erp'), ('sp', 'sup_pub'), ('si', 'sup_ind'), ('sr', 'sup_res')):
            col[a].append(int(round(g(s, b))))
        for a, b in (('be', 'erp_b'), ('bp', 'pub_b'), ('bi', 'ind_b'), ('br', 'res_b')):
            col[a].append(int(g(s, b)))
        has = bool(n)
        col['ni'].append(i10(n.get('i', 0)) if has else -1)
        col['no'].append(i10(n.get('o', 0)) if has else -1)
        col['nn'].append(i10(min(100, n.get('n', 0))) if has else -1)
        col['ns'].append(i10(n.get('ns', 0)) if has else -1)
        col['ss'].append(i10(n.get('pv', 0)) if n.get('fer') is not None else -1)
        col['fer'].append(i10(n.get('fer')) if n.get('fer') is not None else -1)
        col['area'].append(int(round(g(s, 'area'))))
        col['cx'].append(round(s['c'][0] * SCALE)); col['cy'].append(round(s['c'][1] * SCALE))
        col['g'].append(enc_ring(s['geom']))

    # ---- cabine
    mpop = defaultdict(lambda: defaultdict(int))
    for s in S: mpop[s['cab']][g(s, 'mun')] += int(g(s, 'pop'))
    cab_out = []
    for cid in order:
        c = cab[cid]
        tot = sum(mpop[cid].values()) or 1
        muns = sorted(((m, round(p / tot * 100, 1)) for m, p in mpop[cid].items() if m and p / tot >= 0.05),
                      key=lambda x: -x[1])
        area, nsez, pop = TAB61[cid]
        cab_out.append({
            'id': cid, 'area': area, 'nsez': nsez,
            'nab': sum(1 for s in S if s['cab'] == cid and g(s, 'pop') > 0),
            'pop': pop,
            'fv': {'erp': c['fv_erp_mwh'], 'pub': c['fv_pub_mwh'], 'ind': c['fv_ind_mwh'], 'res': c['fv_res_mwh']},
            'sup': {'erp': c['sup_erp_m2'], 'pub': c['sup_pub_m2'], 'ind': c['sup_ind_m2'], 'res': c['sup_res_m2']},
            'nb': {'erp': c['erp_buildings'], 'pub': c['pub_buildings'], 'ind': c['ind_buildings'], 'res': c['res_buildings']},
            'c': c['c'], 'mun': muns,
            'r': [enc_ring(r) for r in c['rings']],
        })

    # ---- confini per orientarsi anche senza mappa di base
    mun = simplify_geojson(MUNG, 0.00012)
    com = simplify_geojson(COMG, 0.00012)

    meta = {
        'versione': 'v9', 'comune': 'Napoli',
        'scala': SCALE,
        'c_tesi': C_TESI, 'eta': 0.20, 'pr': 0.85, 'kwh_kwp': 1400,
        'cons_tesi': CONS_TESI, 'soglia_tesi': 60, 'soglia_sens': 70,
        'fer_alta': fer_thr,
        'area_km2': 119.16,
        'tab62': TAB62,
        'tab63': TAB63,
        'municipalita': ds['meta'].get('municipalita', {}),
        'fonte': 'Martinelli V., tesi di dottorato, DICEA Università di Napoli Federico II, XXXIX ciclo — capitoli 5 e 6',
    }
    out = {'meta': meta, 'cab': cab_out, 'sez': dict(col), 'mun': mun, 'comune': com}
    DST.write_text(json.dumps(out, separators=(',', ':'), ensure_ascii=False), encoding='utf-8')
    print(f'dati.json  {DST.stat().st_size/1024/1024:.2f} MB'
          f'  · sezioni {len(S):,}  · chiavi IVSM spostate {spost}  · soglia offerta {fer_thr}')
    verifica(out)


# ===================================================================== verifica
def verifica(d):
    """Ricalcola dalle colonne le grandezze della tesi e le confronta."""
    sez, cabs = d['sez'], d['cab']
    n = len(sez['id'])
    err = []
    def ck(nome, val, atteso, tol=0):
        if abs(val - atteso) > tol: err.append(f'{nome}: {val} invece di {atteso}')

    # Tab. 6.1
    for j, c in enumerate(cabs):
        ck(f'sezioni {c["id"]}', sum(1 for i in range(n) if sez['cab'][i] == j), TAB61[c['id']][1])
        ck(f'popolazione {c["id"]}', sum(sez['pop'][i] for i in range(n) if sez['cab'][i] == j), TAB61[c['id']][2])
    ck('popolazione totale', sum(sez['pop']), 921142)

    # vulnerabili alle due soglie, per cabina (Tab. 6.6 e 6.11)
    def vuln(T):
        v = [0] * len(cabs); ns = 0
        for i in range(n):
            if sez['pop'][i] > 0 and sez['iv'][i] >= T * 100:
                v[sez['cab'][i]] += sez['pop'][i]; ns += 1
        return v, ns
    v60, n60 = vuln(60); v70, n70 = vuln(70)
    for j, c in enumerate(cabs):
        ck(f'vulnerabili 60 {c["id"]}', v60[j], TAB66[c['id']][0])
        ck(f'vulnerabili 70 {c["id"]}', v70[j], TAB66[c['id']][1])
    ck('vulnerabili 60', sum(v60), 73408); ck('sezioni 60', n60, 340)
    ck('vulnerabili 70', sum(v70), 6450)

    # classi di priorità (Jenks, minimo 3 per classe)
    for T, v in ((60, v60), (70, v70)):
        b1, b2 = jenks3(v)
        for j, c in enumerate(cabs):
            cl = 'C1' if v[j] > b2 else 'C2' if v[j] > b1 else 'C3'
            code = c['id'][-3:]
            att = 'C1' if code in CLASSI[T]['C1'] else 'C2' if code in CLASSI[T]['C2'] else 'C3'
            if cl != att: err.append(f'classe {c["id"]} a {T}: {cl} invece di {att}')

    # producibilità per destinazione (Tab. 6.4) e coerenza sezioni-cabine
    for k, kc in (('erp', 'fe'), ('pub', 'fp'), ('ind', 'fi'), ('res', 'fr')):
        ck(f'MWh {k} cabine', round(sum(c['fv'][k] for c in cabs)), TAB64[k], 1)
        ck(f'MWh {k} sezioni', round(sum(sez[kc]) / 100), TAB64[k], 1)
    for j, c in enumerate(cabs):
        ck(f'PV ERP {c["id"]}', round(c['fv']['erp']), TAB66[c['id']][2], 1)
        ck(f'PV pub {c["id"]}', round(c['fv']['pub']), TAB66[c['id']][3], 1)
        ck(f'PV ind {c["id"]}', round(c['fv']['ind']), TAB66[c['id']][4], 1)

    # copertura effettiva ERP (Tab. 6.6): l'energia ERP di ogni sezione serve
    # prima i vulnerabili della sezione, poi i non vulnerabili, il resto è eccedenza
    for j, c in enumerate(cabs):
        cv = tv = 0.0
        for i in range(n):
            if sez['cab'][i] != j or sez['pop'][i] == 0 or sez['iv'][i] < 6000: continue
            dom = sez['pop'][i] * CONS_TESI / 1000
            cv += dom; tv += min(sez['fe'][i] / 100, dom)
        # la tesi riporta il campo GIS a due decimali arrotondato a uno (36,85 -> 36,9)
        cop = r1(r2(tv / cv * 100)) if cv else 0.0
        ck(f'copertura effettiva {c["id"]}', cop, TAB66[c['id']][5], 0.001)

    # rapporto potenziale e saldo (Tab. 6.6, 6.8, 6.9) e scenari cumulati (Tab. 6.10)
    RP = {'AC001E00223': (73.4, 11.2, 18.3, 84.6), 'AC001E00189': (107.2, 97.0, 28.5, 100.0),
          'AC001E00192': (59.7, 46.1, 370.2, 100.0), 'AC001E00205': (56.2, 2.0, 314.2, 58.2),
          'AC001E00207': (99.3, 28.1, 120.1, 100.0), 'AC001E00204': (85.2, 121.9, 595.3, 100.0),
          'AC001E00191': (116.1, 166.6, 351.0, 100.0), 'AC001E00200': (297.4, 47.5, 36.9, 100.0),
          'AC001E00224': (123.2, 79.6, 32.4, 100.0), 'AC001E00206': (196.3, 46.1, 190.0, 100.0),
          # 201: la tesi riporta 5.407,3; con 7.651,4 MWh e 141,6 MWh di consumo il valore è 5.403,5
          'AC001E00201': (5403.5, 3048.4, 655.2, 100.0), 'AC001E00190': (0.0, 48018.2, 1114.3, 100.0)}
    for j, c in enumerate(cabs):
        cons = r1(v60[j] * CONS_TESI / 1000)        # MWh/a a un decimale, come nella tesi
        e, p_, i_ = c['fv']['erp'], c['fv']['pub'], c['fv']['ind']
        att = RP[c['id']]
        ck(f'rapporto ERP {c["id"]}', r1(e / cons * 100), att[0], 0.001)
        ck(f'rapporto pub {c["id"]}', r1(p_ / cons * 100), att[1], 0.001)
        ck(f'rapporto ind {c["id"]}', r1(i_ / cons * 100), att[2], 0.001)
        # gli scenari cumulati sommano i rapporti già arrotondati (Tab. 6.10: 56,2 + 2,0 = 58,2)
        ck(f'scenario B {c["id"]}', min(100.0, r1(r1(e / cons * 100) + r1(p_ / cons * 100))), att[3], 0.001)
    # configurazione minima sufficiente (Tab. 6.10): singole destinazioni, poi coppie, poi tutte e tre
    MIN = {'AC001E00223':'erp+pub+ind', 'AC001E00189':'erp', 'AC001E00192':'ind', 'AC001E00205':'ind',
           'AC001E00207':'ind', 'AC001E00204':'pub', 'AC001E00191':'erp', 'AC001E00200':'erp',
           'AC001E00224':'erp', 'AC001E00206':'erp', 'AC001E00201':'erp', 'AC001E00190':'pub'}
    combo = [['erp'], ['pub'], ['ind'], ['erp', 'pub'], ['erp', 'ind'], ['pub', 'ind'], ['erp', 'pub', 'ind']]
    for j, c in enumerate(cabs):
        cons = r1(v60[j] * CONS_TESI / 1000)
        trov = next(('+'.join(ks) for ks in combo if r1(sum(r1(c['fv'][k] / cons * 100) for k in ks)) >= 100), None)
        if trov != MIN[c['id']]: err.append(f'configurazione minima {c["id"]}: {trov} invece di {MIN[c["id"]]}')
    cons_tot = sum(v60) * CONS_TESI / 1000
    ck('consumo vulnerabili', round(cons_tot), 179189)
    ck('rapporto ERP città', r1(TAB64['erp'] / cons_tot * 100), 94.0, 0.001)
    ck('rapporto ind città', r1(TAB64['ind'] / cons_tot * 100), 129.2, 0.001)

    # residenti serviti per destinazione (par. 6.3): 59.092 / 32.685 / 36.189
    for k, att in (('erp', 59092), ('pub', 32685), ('ind', 36189)):
        tot = sum(min(v60[j], math.floor(c['fv'][k] / (CONS_TESI / 1000))) for j, c in enumerate(cabs))
        ck(f'serviti {k}', tot, att)

    # Tab. 6.12 — sezioni per condizione
    thr = d['meta']['fer_alta'] * 10
    grp = defaultdict(lambda: [0, 0, 0, 0, 0.0])
    for i in range(n):
        vul = sez['pop'][i] > 0 and sez['iv'][i] >= 6000
        hi = sez['fer'][i] >= thr
        key = 'HH' if (hi and vul) else 'LH' if vul else 'HL' if hi else None
        if not key: continue
        r = grp[key]
        r[0] += 1; r[1] += sez['pop'][i] == 0; r[2] += sez['pop'][i]; r[3] += sez['pop'][i] if vul else 0
        r[4] += (sez['fe'][i] + sez['fp'][i] + sez['fi'][i] + sez['fr'][i]) / 100
    for key, att in TAB612.items():
        r = grp[key]
        ck(f'{key} sezioni', r[0], att[0]); ck(f'{key} non abitate', r[1], att[1])
        ck(f'{key} popolazione', r[2], att[2]); ck(f'{key} vulnerabili', r[3], att[3])
        ck(f'{key} MWh', round(r[4]), att[4], 2)

    if err:
        print('VERIFICA NON SUPERATA:'); [print('  -', e) for e in err]; sys.exit(1)
    print('verifica superata: Tab. 6.1, 6.4, 6.6, 6.7, 6.8, 6.9, 6.10, 6.11, 6.12 e residenti serviti coincidono')


if __name__ == '__main__':
    main()
