/* =====================================================================
   SSD CER Napoli · v9 — logica dell'applicazione
   Allineata ai capitoli 5 e 6 della tesi di dottorato di V. Martinelli
   (DICEA, Università di Napoli Federico II, XXXIX ciclo).

   Tre parametri della tesi (soglia IVSM, consumo per abitante, coperture
   attivate) più il coefficiente di utilizzazione delle coperture c (Eq. 2):
   E = R · A · c · η · PR è lineare in c, quindi si ricalcola in diretta.
   ===================================================================== */
'use strict';
(function(){

const BUILD = window.SSD_BUILD || 'web';          // 'web' | 'offline' | 'artifact'
const $  = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const RIDOTTO = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------------------------------------------------------------- formati */
const NF0 = new Intl.NumberFormat('it-IT', {maximumFractionDigits:0});
const NF1 = new Intl.NumberFormat('it-IT', {minimumFractionDigits:1, maximumFractionDigits:1});
const NF2 = new Intl.NumberFormat('it-IT', {minimumFractionDigits:2, maximumFractionDigits:2});
const n0 = v => NF0.format(Math.round(v) || 0);
const n1 = v => NF1.format(v);
// arrotondamenti come nelle tabelle della tesi: valore binario esatto (toFixed)
const r1 = x => Number(x.toFixed(1));
const r2 = x => Number(x.toFixed(2));
const NF2p = new Intl.NumberFormat('it-IT', {minimumFractionDigits:2, maximumFractionDigits:2});
// le quote piccolissime restano leggibili (0,03% invece di 0,0%), come nella Tab. 6.6
const perc = v => (v === null || v === undefined || !isFinite(v)) ? '—' : (v > 0 && v < 0.1 ? NF2p.format(v) : NF1.format(r1(v))) + '%';
const segno = v => { const x = Math.round(v) || 0; return (x > 0 ? '+' : x < 0 ? '−' : '') + NF0.format(Math.abs(x)); };
const gwh = mwh => NF1.format(mwh / 1000);
const energia = mwh => mwh >= 10000 ? NF1.format(mwh/1000) + ' GWh/a' : n0(mwh) + ' MWh/a';
const codice = id => id.slice(-3);
// articolo davanti a un numero: l'8%, l'11%, l'80%, ma il 94%
function art(num, forma='il'){
  const intero = String(num).replace(/\./g, '').split(/[,%\s]/)[0];
  const voc = intero === '1' || intero === '11' || intero.startsWith('8');
  const f = {il:['il ', "l'"], al:['al ', "all'"], con:['con il ', "con l'"]}[forma];
  return (voc ? f[1] : f[0]) + num;
}

/* ---------------------------------------------------------------- costanti */
const DEST = ['erp', 'pub', 'ind', 'res'];
const DEST_NOME = {erp:'Edilizia residenziale pubblica', pub:'Patrimonio pubblico non residenziale', ind:'Edificato industriale', res:'Residenziale privato'};
const DEST_BREVE = {erp:'ERP', pub:'pubblico', ind:'industriale', res:'residenziale privato'};
const COMBO = [['erp'], ['pub'], ['ind'], ['erp','pub'], ['erp','ind'], ['pub','ind'], ['erp','pub','ind']];
const COMBO_NOME = {
  'erp':'edilizia residenziale pubblica', 'pub':'pubblico non residenziale', 'ind':'industriale',
  'erp+pub':'ERP e pubblico', 'erp+ind':'ERP e industriale', 'pub+ind':'pubblico e industriale', 'erp+pub+ind':'tutte e tre'};
const SCEN = {A:['erp'], B:['erp','pub'], C:['erp','pub','ind']};
const SCEN_NOME = {A:'A · ERP', B:'B · ERP e pubblico', C:'C · ERP, pubblico e industriale'};
const CLASSE = {1:'C1', 2:'C2', 3:'C3'};
const CLASSE_NOME = {1:'intervento prioritario', 2:'intervento opportuno', 3:'intervento residuale'};
const REG_NOME = ['dato non disponibile', 'idonea', 'ordinaria', 'non idonea'];
const COND = {3:'Offerta e domanda elevate', 2:'Domanda elevata, offerta contenuta', 1:'Offerta elevata, domanda contenuta', 0:'Fuori dalla prioritizzazione'};
const COND_BREVE = {3:'coincidono', 2:'solo domanda', 1:'solo offerta', 0:'fuori priorità'};
const FER_CLASSI = [250, 282, 350, 500];            // FER_100 ×10: <25 · 25–28,2 · 28,2–35 · 35–50 · ≥50
const CO2_T_MWH = 0.33;                              // fattore indicativo, da allineare all'IBE del PAESC
// descrizioni dei perimetri riportate nella tesi (par. 6.2.5 e 6.3.2)
const DESCR_TESI = {
  'AC001E00223':'Nella tesi: insiste sui quartieri di Scampia, Secondigliano e Piscinola.',
  'AC001E00189':'Nella tesi: insiste su Fuorigrotta, Soccavo e Pianura.',
  'AC001E00192':'Nella tesi: insiste su Barra, Ponticelli e San Giovanni a Teduccio.',
  'AC001E00190':'Nella tesi: comprende il centro storico e la fascia costiera occidentale.',
};

/* ---------------------------------------------------------------- stato */
let D = null, N = 0, SC = 100000;
const S = {};                                        // colonne delle sezioni
const TESI = {T:60, k:2441, c:50, att:{erp:true, pub:false, ind:false, res:false}};
const P = {T:60, k:2441, c:50, att:{erp:true, pub:false, ind:false, res:false}};
let R = null;                                         // risultati del calcolo
let vista = 'napoli', cabAttiva = -1;
let passoCitta = 1, varCitta = 'cab', passoCab = 5, schedaSez = 3;
let filtro = 'tutte', ricerca = '';
let tour = -1;
let FOOT = null, footInCorso = null;
const COL = {};

/* ================================================================ DATI */
async function carica(nome){
  const el = document.getElementById('json-' + nome);
  if(el) return JSON.parse(el.textContent);
  const r = await fetch(nome + '.json');
  if(!r.ok) throw new Error(nome + '.json non disponibile (' + r.status + ')');
  return r.json();
}

function prepara(){
  const z = D.sez;
  N = z.id.length; SC = D.meta.scala;
  const I32 = a => Int32Array.from(a);
  for(const k of ['pop','fam','iv','cab','mun','edu','emp','old','erpp','fe','fp','fi','fr','se','sp','si','sr','be','bp','bi','br','ni','no','nn','ns','ss','fer','area','cx','cy']) S[k] = I32(z[k]);
  S.id = z.id; S.g = z.g;
  S.reg = new Uint8Array(N); S.ferc = new Int8Array(N); S.mwh = new Float64Array(N);
  S.idx = new Map();
  for(let i = 0; i < N; i++){
    S.idx.set(String(S.id[i]), i);
    const a = S.ni[i], o = S.no[i], n = S.nn[i];
    S.reg[i] = a < 0 ? 0 : (n >= a && n >= o) ? 3 : (a > o) ? 1 : 2;
    const f = S.fer[i];
    S.ferc[i] = f < 0 ? -1 : f < FER_CLASSI[0] ? 0 : f < FER_CLASSI[1] ? 1 : f < FER_CLASSI[2] ? 2 : f < FER_CLASSI[3] ? 3 : 4;
    S.mwh[i] = (S.fe[i] + S.fp[i] + S.fi[i] + S.fr[i]) / 100;
  }
  // per cabina: sezioni (indici) e municipalità servite
  D.cab.forEach((c, j) => { c.j = j; c.sez = []; });
  for(let i = 0; i < N; i++) D.cab[S.cab[i]].sez.push(i);
  // municipalità: cabine attraversate (quota di residenti)
  D.munCab = {};
  for(let i = 0; i < N; i++){
    const m = S.mun[i]; if(!m) continue;
    const o = D.munCab[m] || (D.munCab[m] = {});
    o[S.cab[i]] = (o[S.cab[i]] || 0) + S.pop[i];
  }
  D.munNome = m => (D.meta.municipalita[String(m)] || ('Municipalità ' + m));
  // quota di producibilità per classe regolatoria e destinazione (indipendente da c)
  D.regQ = {};
  for(const d of ['erp', 'pub', 'ind', 'res']){
    const col = d === 'erp' ? S.fe : d === 'pub' ? S.fp : d === 'ind' ? S.fi : S.fr;
    const v = [0, 0, 0, 0]; for(let i = 0; i < N; i++) v[S.reg[i]] += col[i];
    const t = v.reduce((x, y) => x + y, 0) || 1;
    D.regQ[d] = v.map(x => x / t * 100);
  }
}

/* ================================================================ CALCOLO */
function jenks3(values, minSize=3){
  const v = values.slice().sort((a, b) => a - b), n = v.length;
  const sdcm = a => { if(!a.length) return 0; const m = a.reduce((x, y) => x + y, 0) / a.length; return a.reduce((x, y) => x + (y - m) * (y - m), 0); };
  let best = null;
  for(let i = minSize; i <= n - 2 * minSize; i++) for(let j = i + minSize; j <= n - minSize; j++){
    const s = sdcm(v.slice(0, i)) + sdcm(v.slice(i, j)) + sdcm(v.slice(j));
    if(!best || s < best.s) best = {s, b1:v[i - 1], b2:v[j - 1]};
  }
  return best || {b1:v[Math.floor(n / 3)], b2:v[Math.floor(2 * n / 3)]};
}

function calcola(){
  const T100 = P.T * 100, kM = P.k / 1000, fc = P.c / 50, ferT = Math.round(D.meta.fer_alta * 10);
  const att = DEST.filter(d => P.att[d]);
  const vul = new Uint8Array(N), cond = new Uint8Array(N);
  const cab = D.cab.map((c, j) => ({j, id:c.id, popV:0, nV:0, cvE:0, tvE:0,
    n:[0,0,0,0], pop:[0,0,0,0], pV:[0,0,0,0], mwh:[0,0,0,0]}));
  const city = {popV:0, nV:0, n:[0,0,0,0], vuoti:[0,0,0,0], pop:[0,0,0,0], pV:[0,0,0,0], mwh:[0,0,0,0], regPv:[0,0,0,0]};
  const munP = {}, munV = {};
  for(let i = 0; i < N; i++){
    const p = S.pop[i], x = cab[S.cab[i]];
    const v = p > 0 && S.iv[i] >= T100;
    const hi = S.fer[i] >= ferT;
    const q = v ? (hi ? 3 : 2) : (hi ? 1 : 0);
    cond[i] = q;
    const mw = S.mwh[i] * fc;
    city.n[q]++; city.pop[q] += p; city.mwh[q] += mw; if(p === 0) city.vuoti[q]++;
    x.n[q]++; x.pop[q] += p; x.mwh[q] += mw;
    // producibilità attivata per classe regolatoria
    let pa = 0; for(const d of att) pa += (d === 'erp' ? S.fe[i] : d === 'pub' ? S.fp[i] : d === 'ind' ? S.fi[i] : S.fr[i]);
    city.regPv[S.reg[i]] += pa / 100 * fc;
    const m = S.mun[i]; munP[m] = (munP[m] || 0) + p;
    if(v){
      vul[i] = 1; city.popV += p; city.nV++; x.popV += p; x.nV++; city.pV[q] += p; x.pV[q] += p;
      munV[m] = (munV[m] || 0) + p;
      // copertura effettiva ERP (Tab. 6.6): l'energia ERP della sezione serve prima i suoi vulnerabili
      const dom = p * kM; x.cvE += dom; x.tvE += Math.min(S.fe[i] / 100 * fc, dom);
    }
  }
  const tot = {cons:0, pv:{erp:0, pub:0, ind:0, res:0}, pvAtt:0, serv:0, servD:{erp:0, pub:0, ind:0},
               servS:{A:0, B:0, C:0}, pari:0, popPari:0, pariD:{erp:0, pub:0, ind:0, res:0}, pariS:{A:0, B:0, C:0}};
  for(const x of cab){
    const c = D.cab[x.j];
    x.cons = r1(x.popV * kM);                              // MWh/a a un decimale, come nella tesi
    x.pv = {}; x.rap = {};
    for(const d of DEST){ x.pv[d] = c.fv[d] * fc; x.rap[d] = x.cons > 0 ? x.pv[d] / x.cons * 100 : null; }
    // gli scenari sommano i rapporti già arrotondati (Tab. 6.10)
    const comb = ks => x.cons > 0 ? r1(ks.reduce((a, d) => a + r1(x.rap[d]), 0)) : null;
    const serv = ks => Math.min(x.popV, kM > 0 ? Math.floor(ks.reduce((a, d) => a + x.pv[d], 0) / kM) : 0);
    x.pvAtt = att.reduce((a, d) => a + x.pv[d], 0);
    x.rapAtt = att.length ? comb(att) : (x.cons > 0 ? 0 : null);
    x.saldo = x.pvAtt - x.cons;
    x.serv = serv(att);
    x.copEff = x.cvE > 0 ? r1(r2(x.tvE / x.cvE * 100)) : null;
    x.scen = {A:comb(SCEN.A), B:comb(SCEN.B), C:comb(SCEN.C)};
    x.min = x.cons > 0 ? (COMBO.find(ks => comb(ks) >= 100) || null) : undefined;
    tot.cons += x.cons; tot.pvAtt += x.pvAtt; tot.serv += x.serv;
    for(const d of DEST) tot.pv[d] += x.pv[d];
    for(const d of ['erp', 'pub', 'ind']) tot.servD[d] += serv([d]);
    for(const s of ['A', 'B', 'C']){ tot.servS[s] += serv(SCEN[s]); if(x.cons > 0 && x.scen[s] >= 100) tot.pariS[s]++; }
    for(const d of DEST) if(x.cons > 0 && r1(x.rap[d]) >= 100) tot.pariD[d]++;
    if(x.cons > 0 && x.rapAtt >= 100){ tot.pari++; tot.popPari += x.popV; }
  }
  const nDom = cab.filter(x => x.cons > 0).length;
  // classi di priorità: Jenks a tre classi, almeno tre cabine per classe (Tab. 6.7)
  const jb = jenks3(cab.map(x => x.popV));
  for(const x of cab) x.cl = x.popV > jb.b2 ? 1 : x.popV > jb.b1 ? 2 : 3;
  if(cab.every(x => x.popV === 0)) cab.forEach(x => x.cl = 3);
  const ord = cab.slice().sort((a, b) => b.popV - a.popV || a.j - b.j).map(x => x.j);
  const cls = {1:{n:0, popV:0, pop:0, cab:[]}, 2:{n:0, popV:0, pop:0, cab:[]}, 3:{n:0, popV:0, pop:0, cab:[]}};
  for(const j of ord){ const x = cab[j], k = cls[x.cl]; k.n++; k.popV += x.popV; k.pop += D.cab[j].pop; k.cab.push(j); }
  const mun = Object.keys(D.meta.municipalita).map(Number).sort((a, b) => a - b)
    .map(m => ({m, pop:munP[m] || 0, popV:munV[m] || 0}));
  return {T:P.T, k:P.k, c:P.c, att, vul, cond, cab, ord, cls, jb, city, tot, mun, nDom,
          popTot:D.cab.reduce((a, c) => a + c.pop, 0)};
}

/* ================================================================ COLORI DAI TOKEN */
function leggiColori(){
  const cs = getComputedStyle(document.documentElement);
  for(const k of ['m-bg','m-line','m-cab','m-cabfill','sez-ll','sez-none','reg-idonea','reg-ord','reg-non','reg-hatch',
                  'off-1','off-2','off-3','off-4','off-5','dom-1','dom-2','dom-3','dom-4','pri-1','pri-2','pri-3',
                  'sez-hh','sez-lh','sez-hl','bld-erp','bld-pub','bld-ind','bld-res','ink','ink-2','ink-3','sheet','accent'])
    COL[k] = cs.getPropertyValue('--' + k).trim();
  COL.hatch = null; COL.dom = null; COL.off = null;    // si ricreano al primo uso
}
// tratteggio delle aree non idonee: un motivo canvas usato come colore di riempimento
function tratteggio(ctx){
  if(COL.hatch) return COL.hatch;
  const t = document.createElement('canvas'); t.width = 8; t.height = 8;
  const g = t.getContext('2d');
  g.fillStyle = COL['reg-non']; g.fillRect(0, 0, 8, 8);
  g.strokeStyle = COL['reg-hatch']; g.lineWidth = 1.6; g.globalAlpha = .9;
  g.beginPath(); g.moveTo(-2, 10); g.lineTo(10, -2); g.moveTo(-2, 2); g.lineTo(2, -2); g.moveTo(6, 10); g.lineTo(10, 6); g.stroke();
  COL.hatch = (ctx || g).createPattern(t, 'repeat');
  return COL.hatch;
}
const DOM_COL = () => COL.dom || (COL.dom = [COL['dom-1'], COL['dom-2'], COL['dom-3'], COL['dom-4']]);
const OFF_COL = () => COL.off || (COL.off = [COL['off-1'], COL['off-2'], COL['off-3'], COL['off-4'], COL['off-5']]);
const PRI_COL = cl => COL['pri-' + cl];
const COND_COL = q => q === 3 ? COL['sez-hh'] : q === 2 ? COL['sez-lh'] : q === 1 ? COL['sez-hl'] : COL['sez-ll'];
const REG_COL = k => k === 1 ? COL['reg-idonea'] : k === 2 ? COL['reg-ord'] : k === 3 ? COL['reg-non'] : COL['sez-none'];
function ivClasse(i){
  if(S.pop[i] === 0 || S.iv[i] < 0) return -1;
  const T = P.T * 100;
  if(S.iv[i] >= T) return 3;
  return Math.min(2, Math.floor(S.iv[i] / (T / 3)));
}
const ivTxt = i => S.iv[i] < 0 ? 'n.d.' : NF1.format(Math.round(S.iv[i] / 10) / 10);
const ferTxt = i => S.fer[i] < 0 ? 'n.d.' : NF1.format(S.fer[i] / 10);

/* ================================================================ TESTI DINAMICI */
function attiviTesto(){
  const sc = scenarioCorrente();
  return sc ? 'scenario ' + SCEN_NOME[sc] : (R.att.length ? R.att.map(d => DEST_BREVE[d]).join(' + ') : 'nessuna copertura');
}
function scenarioCorrente(){
  const a = P.att;
  if(a.res) return null;
  if(a.erp && !a.pub && !a.ind) return 'A';
  if(a.erp && a.pub && !a.ind) return 'B';
  if(a.erp && a.pub && a.ind) return 'C';
  return null;
}
const modificati = () => P.T !== TESI.T || P.k !== TESI.k || P.c !== TESI.c || DEST.some(d => P.att[d] !== TESI.att[d]);
function lineaParametri(){
  return `<span>Calcolo con: soglia IVSM<sub>100</sub> <b>≥ ${P.T}</b></span><span><b>${n0(P.k)}</b> kWh per abitante</span>` +
    `<span><b>${P.c}%</b> dei tetti</span><span><b>${esc(attiviTesto())}</b></span>` +
    (modificati() ? `<span><b>valori modificati</b> · <button type="button" class="btn-link" data-ripristina>ripristina la tesi</button></span>`
                  : `<span>(valori della tesi)</span>`) +
    `<a href="#parametri">Modifica i parametri</a>`;
}
function elencoCab(js){
  return js.map(j => codice(D.cab[j].id)).join(', ').replace(/, ([^,]*)$/, ' e $1');
}
function munBreve(m){ return 'Municipalità ' + m + ' ' + D.munNome(m); }

/* ================================================================ VISTA NAPOLI */
function renderNapoli(){
  const t = R.tot, c = R.city;
  $('#dati-napoli').innerHTML = `<span><strong>${n0(R.popTot)}</strong> residenti</span><span><strong>${NF2.format(D.meta.area_km2)}</strong> km²</span>` +
    `<span><strong>${D.cab.length}</strong> cabine primarie</span><span><strong>${n0(N)}</strong> sezioni censuarie, ${n0(D.cab.reduce((a, x) => a + x.nab, 0))} abitate</span>`;
  $('#attivi-napoli').innerHTML = lineaParametri();
  $('#kpi-vuln').innerHTML = kpiVuln(c.popV, c.nV, R.popTot, t.cons);
  const rap = t.cons > 0 ? t.pvAtt / t.cons * 100 : null;
  $('#kpi-energia').innerHTML = `<p class="kpi-l">Energia producibile, ${esc(attiviTesto())}</p>
    <p class="kpi-v">${gwh(t.pvAtt)}<small>GWh/a</small></p>
    <p class="kpi-s">${R.att.length ? 'pari ' + art(perc(rap), 'al') + ' del consumo dei vulnerabili' : 'attiva almeno una copertura nei parametri'}</p>
    <div class="kpi-barra" aria-hidden="true"><span style="width:${Math.min(100, rap || 0)}%"></span></div>`;
  const quota = c.popV ? t.serv / c.popV * 100 : 0;
  $('#kpi-serviti').innerHTML = `<p class="kpi-l">Vulnerabili raggiungibili</p>
    <p class="kpi-v">${n0(t.serv)}</p>
    <p class="kpi-s">${art(perc(quota))} dei vulnerabili; in ${t.pari} cabine su ${R.nDom} l'energia della cabina copre tutto il consumo</p>
    <div class="kpi-barra" aria-hidden="true"><span style="width:${Math.min(100, quota)}%"></span></div>`;
  renderTabCabine();
  renderNorma();
  renderScenari();
  renderPaesc();
  renderMun();
}

function renderPaesc(){
  const voci = R.ord.map(j => {
    const x = R.cab[j], c = D.cab[j];
    return `<li><button type="button" class="voce-cab voce-paesc" data-scheda="${c.id}">
      ${pillClasse(x.cl)}<span class="cod">${c.id}</span><span class="vv">${n0(x.serv)} <small>vuln. raggiungibili</small></span>
      <span class="dove">Configurazione minima: ${esc(configTesto(x))}</span>
      <span class="apri"><svg aria-hidden="true"><use href="#i-doc"/></svg>Apri la scheda</span></button></li>`;
  }).join('');
  $('#blocco-paesc').innerHTML = `
    <div class="blocco-testa"><div><p class="occhiello">Dall'esito al piano</p>
      <h2 id="h-paesc">Schede d'azione per il PAESC</h2></div></div>
    <p class="lead">Per ogni cabina lo strumento compila una scheda d'azione da inserire nel Piano d'Azione per l'Energia Sostenibile e il Clima del Comune di Napoli: obiettivo, configurazione, siti per l'installazione, risultati attesi, soggetti responsabili, tempi e indicatori di monitoraggio. La scheda usa i valori del pannello «Parametri variabili»${BUILD === 'artifact' ? '' : ' e si può stampare o salvare in PDF'}.</p>
    <ul class="lista-cab griglia-paesc" style="margin-top:14px">${voci}</ul>`;
}

function kpiVuln(popV, nV, popTot, cons){
  return `<p class="kpi-l">Popolazione vulnerabile e consumo elettrico</p>
    <div class="calcolo">
      <div class="calcolo-v"><span class="kpi-v">${n0(popV)}</span><span class="kpi-s">residenti vulnerabili (${perc(popTot ? popV / popTot * 100 : 0)} dei residenti) in ${n0(nV)} sezioni con IVSM<sub>100</sub> ≥ ${P.T}</span></div>
      <span class="op"><span aria-hidden="true">×</span><span class="sr-only">per</span></span>
      <div class="calcolo-v"><span class="kpi-v">${n0(P.k)}<small>kWh</small></span><span class="kpi-s">consumo per abitante all'anno</span></div>
      <span class="op"><span aria-hidden="true">=</span><span class="sr-only">uguale a</span></span>
      <div class="calcolo-v"><span class="kpi-v">${gwh(cons)}<small>GWh/a</small></span><span class="kpi-s">consumo elettrico da coprire</span></div>
    </div>
    <button type="button" class="btn-info" data-apri="dlg-ivsm"><svg aria-hidden="true"><use href="#i-info"/></svg>Come si calcola la popolazione vulnerabile</button>`;
}

function pillClasse(cl, lungo){
  return `<span class="pill pill-c${cl}">${CLASSE[cl]}${lungo ? ' · ' + CLASSE_NOME[cl] : ''}</span>`;
}
function stato(v){
  if(v === null || v === undefined) return '<span class="stato">—</span>';
  if(v >= 100) return `<span class="stato stato-ok"><svg aria-hidden="true"><use href="#i-ok"/></svg>in pari</span>`;
  if(v >= 70) return `<span class="stato stato-parz"><svg aria-hidden="true"><use href="#i-parz"/></svg>parziale</span>`;
  return `<span class="stato stato-no"><svg aria-hidden="true"><use href="#i-no"/></svg>in deficit</span>`;
}
function barretta(v, cap=100){
  if(v === null || v === undefined) return '—';
  const w = Math.min(100, v / cap * 100);
  return `<span class="barretta"><span class="b" aria-hidden="true"><span class="${v >= 100 ? 'ok' : ''}" style="width:${w}%"></span></span>${perc(v)}</span>`;
}
function configTesto(x){
  if(x.min === undefined) return 'nessun residente vulnerabile';
  if(x.min === null) return 'nessuna basta';
  return COMBO_NOME[x.min.join('+')];
}

function renderTabCabine(){
  const sc = scenarioCorrente();
  $('#nota-cabine').innerHTML = `Ordinate per numero assoluto di residenti vulnerabili, come nella Tab. 6.6 della tesi. Il <strong>rapporto potenziale</strong> confronta la producibilità delle coperture attivate (${esc(attiviTesto())}) con il consumo dei vulnerabili della cabina; la <strong>copertura effettiva</strong> conta solo l'energia ERP prodotta nella stessa sezione dei vulnerabili ed è un limite inferiore. Le classi C1–C3 derivano dalle interruzioni naturali di Jenks, con almeno tre cabine per classe.`;
  const righe = R.ord.map(j => {
    const x = R.cab[j], c = D.cab[j];
    const corr = vista === 'cabina' && cabAttiva === j;
    return `<tr${corr ? ' aria-current="true"' : ''}>
      <th scope="row"><button type="button" class="btn-riga" data-cab="${c.id}">${c.id}</button><span class="sotto">${esc(munCabBreve(j))}</span></th>
      <td>${pillClasse(x.cl)}</td>
      <td class="r">${n0(x.popV)}<span class="sotto">${perc(c.pop ? x.popV / c.pop * 100 : 0)} dei residenti</span></td>
      <td class="r">${n0(x.cons)}</td>
      <td class="r">${n0(x.pvAtt)}</td>
      <td class="r">${barretta(x.rapAtt)}</td>
      <td class="r">${x.copEff === null ? '—' : perc(x.copEff)}</td>
      <td class="r">${segno(x.saldo)}</td>
      <td>${esc(configTesto(x))}</td>
    </tr>`;
  }).join('');
  const t = R.tot;
  $('#tab-cabine').innerHTML = `<caption class="sr-only">Le dodici cabine primarie di Napoli, ordinate per residenti vulnerabili</caption>
    <thead><tr><th scope="col">Cabina primaria</th><th scope="col">Classe</th><th scope="col" class="r">Residenti vulnerabili</th>
      <th scope="col" class="r">Consumo dei vulnerabili<br>(MWh/a)</th><th scope="col" class="r">Producibilità attivata<br>(MWh/a)</th>
      <th scope="col" class="r">Rapporto potenziale</th><th scope="col" class="r">Copertura effettiva ERP</th><th scope="col" class="r">Saldo<br>(MWh/a)</th>
      <th scope="col">Configurazione minima</th></tr></thead>
    <tbody>${righe}</tbody>
    <tfoot><tr><th scope="row">Napoli</th><td></td><td class="r">${n0(R.city.popV)}</td><td class="r">${n0(t.cons)}</td><td class="r">${n0(t.pvAtt)}</td>
      <td class="r">${perc(t.cons ? t.pvAtt / t.cons * 100 : null)}</td><td class="r">${copEffCitta()}</td><td class="r">${segno(t.pvAtt - t.cons)}</td><td>${sc ? 'scenario ' + sc : ''}</td></tr></tfoot>`;
}
function copEffCitta(){
  let cv = 0, tv = 0; for(const x of R.cab){ cv += x.cvE; tv += x.tvE; }
  return cv > 0 ? perc(r1(r2(tv / cv * 100))) : '—';
}
function munCabBreve(j){
  const ms = D.cab[j].mun.slice(0, 2).map(([m]) => m);
  return 'Municipalità ' + ms.join(' e ');
}

function renderNorma(){
  const t = D.meta.tab62, c = R.city;
  let nReg = [0, 0, 0, 0]; for(let i = 0; i < N; i++) nReg[S.reg[i]]++;
  $('#blocco-norma').innerHTML = `
    <div class="blocco-testa"><div><p class="occhiello">Step 2 · Classificazione regolatoria del suolo</p>
      <h2 id="h-norma">Il quadro normativo: le aree idonee del DM 21 giugno 2024</h2></div></div>
    <p class="lead">Il decreto del MASE, attuativo dell'art. 20 del D.Lgs. 199/2021, divide il territorio in tre regimi autorizzativi. A Napoli la classificazione ricavata dalla Piattaforma delle Aree Idonee si distribuisce così.</p>
    <div class="fascia" role="img" style="margin-top:14px" aria-label="Superficie comunale: aree idonee ${n1(t.idonee[1])}%, ordinarie ${n1(t.ordinarie[1])}%, non idonee ${n1(t.non_idonee[1])}%">
      <span style="width:${t.idonee[1]}%;background:var(--reg-idonea)"></span><span style="width:${t.ordinarie[1]}%;background:var(--reg-ord)"></span><span style="width:${t.non_idonee[1]}%;background:var(--reg-non);background-image:repeating-linear-gradient(45deg,var(--reg-hatch) 0 2px,transparent 2px 6px)"></span>
    </div>
    <div class="fascia-leg">
      <div><span class="voce"><span class="campione" style="background:var(--reg-idonea)"></span>Aree idonee</span><b>${NF2.format(t.idonee[0])} km²</b><span>${NF2.format(t.idonee[1])}% della superficie · iter accelerato e agevolato · peso 1</span></div>
      <div><span class="voce"><span class="campione" style="background:var(--reg-ord)"></span>Aree ordinarie</span><b>${NF2.format(t.ordinarie[0])} km²</b><span>${NF2.format(t.ordinarie[1])}% · regime autorizzativo ordinario · peso 0,5</span></div>
      <div><span class="voce"><span class="campione tratteggio" style="background-color:var(--reg-non)"></span>Aree non idonee</span><b>${NF2.format(t.non_idonee[0])} km²</b><span>${NF2.format(t.non_idonee[1])}% · incompatibili con alcune tipologie di impianto · peso 0</span></div>
    </div>
    <div class="griglia-2" style="margin-top:18px">
      <div>
        <h3>Alla scala della sezione censuaria</h3>
        <dl class="dati" style="margin-top:8px">
          <dt>Sezioni a prevalenza idonea</dt><dd>${n0(nReg[1])}</dd>
          <dt>Sezioni a prevalenza ordinaria</dt><dd>${n0(nReg[2])}</dd>
          <dt>Sezioni a prevalenza non idonea</dt><dd>${n0(nReg[3])}</dd>
        </dl>
        <div class="tab-wrap" style="margin-top:12px"><table class="tab" style="min-width:0">
          <caption>Dove ricade la producibilità di ciascuna destinazione</caption>
          <thead><tr><th scope="col">Destinazione</th><th scope="col" class="r">in sezioni idonee</th><th scope="col" class="r">in sezioni non idonee</th></tr></thead>
          <tbody>${['erp', 'pub', 'ind'].map(d => `<tr><th scope="row">${DEST_NOME[d]}</th><td class="r">${perc(D.regQ[d][1])}</td><td class="r">${perc(D.regQ[d][3])}</td></tr>`).join('')}</tbody>
        </table></div>
        <p class="formula" style="margin-top:10px">N<sub>s</sub> = (1 · A<sub>idonea</sub> + 0,5 · A<sub>ordinaria</sub> + 0 · A<sub>non idonea</sub>) / A<sub>s</sub> &nbsp;(Eq. 1)</p>
      </div>
      <div class="regola"><strong>La regola che regge il metodo.</strong> La classificazione condiziona dove si installa l'impianto, non chi ne beneficia. Un nucleo vulnerabile che abita in un'area non idonea resta beneficiario a tutti gli effetti, perché la partecipazione dipende dal punto di connessione nella stessa cabina primaria. Per questo l'IVSM non è mai filtrato dalla classificazione regolatoria.
        <p class="nota" style="margin-top:8px">La non idoneità non è un divieto assoluto: comporta un procedimento più gravoso, con il parere dell'amministrazione preposta alla tutela.</p></div>
    </div>
    <p class="fonte" style="margin-top:12px">Fonte: Piattaforma Aree Idonee (MASE), CORINE Land Cover; elaborazione della tesi, Tab. 6.2. Classe prevalente per superficie della sezione.</p>`;
}

function renderScenari(){
  const t = R.tot;
  const rigaD = d => {
    const rap = t.cons > 0 ? t.pv[d] / t.cons * 100 : null;
    const s = d === 'res' ? null : t.servD[d];
    return `<tr><th scope="row">${DEST_NOME[d]}${d === 'res' ? '<span class="sotto">termine di confronto, non è uno scenario</span>' : ''}</th>
      <td class="r">${n0(t.pv[d])}</td><td class="r">${perc(rap)}</td>
      <td class="r">${s === null ? '—' : n0(s) + '<span class="sotto">' + perc(R.city.popV ? s / R.city.popV * 100 : 0) + '</span>'}</td>
      <td class="r">${t.pariD[d]} su ${R.nDom}</td></tr>`;
  };
  const cella = v => v === null ? '<td class="r">—</td>' : `<td class="r">${v >= 100 ? '<span class="stato stato-ok"><svg aria-hidden="true"><use href="#i-ok"/></svg>' + perc(Math.min(100, v)) + '</span>' : perc(v)}</td>`;
  const righe = R.ord.map(j => {
    const x = R.cab[j];
    return `<tr><th scope="row"><button type="button" class="btn-riga" data-cab="${x.id}">${x.id}</button></th>
      <td class="r">${n0(x.popV)}</td>${cella(x.scen.A)}${cella(x.scen.B)}${cella(x.scen.C)}<td>${esc(configTesto(x))}</td></tr>`;
  }).join('');
  $('#blocco-scenari').innerHTML = `
    <div class="blocco-testa"><div><p class="occhiello">Gli scenari di intervento</p>
      <h2 id="h-scenari">Quale configurazione basta in ogni cabina</h2></div></div>
    <p class="lead">Gli scenari sono cumulativi e ordinati per controllo decrescente dell'ente locale: A attiva l'edilizia residenziale pubblica (un solo soggetto), B aggiunge il patrimonio pubblico non residenziale, C l'edificato industriale, che richiede un accordo con i privati. La configurazione minima è la combinazione più semplice la cui producibilità eguaglia il consumo dei vulnerabili della cabina.</p>
    <h3 style="margin-top:16px">Le destinazioni, una per una</h3>
    <div class="tab-wrap" style="margin-top:8px"><table class="tab">
      <caption class="sr-only">Producibilità e copertura per destinazione d'uso</caption>
      <thead><tr><th scope="col">Destinazione</th><th scope="col" class="r">Producibilità (MWh/a)</th><th scope="col" class="r">Rapporto con il consumo dei vulnerabili</th>
        <th scope="col" class="r">Residenti vulnerabili serviti</th><th scope="col" class="r">Cabine in pari</th></tr></thead>
      <tbody>${['erp', 'pub', 'ind', 'res'].map(rigaD).join('')}</tbody></table></div>
    <h3 style="margin-top:18px">Integrazione degli scenari e configurazione minima (Tab. 6.10)</h3>
    <div class="tab-wrap" style="margin-top:8px"><table class="tab">
      <caption class="sr-only">Copertura della domanda vulnerabile negli scenari A, B e C per cabina</caption>
      <thead><tr><th scope="col">Cabina primaria</th><th scope="col" class="r">Vulnerabili</th><th scope="col" class="r">A · ERP</th><th scope="col" class="r">B · + pubblico</th><th scope="col" class="r">C · + industriale</th><th scope="col">Configurazione minima sufficiente</th></tr></thead>
      <tbody>${righe}</tbody>
      <tfoot><tr><th scope="row">Cabine a copertura completa</th><td></td><td class="r">${t.pariS.A} su ${R.nDom}</td><td class="r">${t.pariS.B} su ${R.nDom}</td><td class="r">${t.pariS.C} su ${R.nDom}</td><td></td></tr>
        <tr><th scope="row">Vulnerabili serviti</th><td></td><td class="r">${n0(t.servS.A)}</td><td class="r">${n0(t.servS.B)}</td><td class="r">${n0(t.servS.C)}</td><td></td></tr></tfoot>
    </table></div>
    <p class="nota" style="margin-top:10px">Dove basta il patrimonio pubblico, residenziale o non residenziale, la configurazione può essere promossa e governata dall'operatore pubblico. Dove serve l'edificato industriale è a partecipazione mista, con l'ente locale promotore di un accordo con i privati. Dove nessuna destinazione basta da sola serve il concorso di ente gestore ERP, Comune e privati.</p>`;
}

function renderMun(){
  const tot = R.city.popV || 1;
  const ord = R.mun.slice().sort((a, b) => b.popV - a.popV);
  const top4 = ord.slice(0, 4), q4 = top4.reduce((a, o) => a + o.popV, 0) / tot * 100;
  const righe = R.mun.map(o => {
    const tutte = Object.entries(D.munCab[o.m] || {}).filter(([, p]) => p > 0);
    const totM = tutte.reduce((a, [, p]) => a + p, 0) || 1;
    const cabs = tutte.filter(([, p]) => p / totM >= 0.005).sort((a, b) => b[1] - a[1]);
    const q = o.popV / tot * 100;
    return `<tr><th scope="row">${o.m}</th><td>${esc(D.munNome(o.m))}</td><td class="r">${n0(o.pop)}</td><td class="r">${n0(o.popV)}</td>
      <td class="r"><span class="barretta"><span class="b" aria-hidden="true"><span style="width:${Math.min(100, q * 2.5)}%"></span></span>${perc(q)}</span></td>
      <td>${cabs.length} <span class="sotto">${cabs.slice(0, 3).map(([j, p]) => codice(D.cab[j].id) + ' (' + Math.round(p / totM * 100) + '%)').join(', ')}</span></td></tr>`;
  }).join('');
  $('#blocco-mun').innerHTML = `
    <div class="blocco-testa"><div><p class="occhiello">Governance urbana</p><h2 id="h-mun">Lettura per Municipalità</h2></div></div>
    <p class="lead">La cabina primaria è il perimetro tecnico della condivisione, la Municipalità quello della governance urbana. I due reticoli non coincidono: una CER di quartiere attraversa più ambiti elettrici, e chi la promuove non coincide con il perimetro entro cui l'energia si condivide.</p>
    <p class="nota" style="margin-top:8px">Con la soglia ≥ ${P.T} le Municipalità ${top4.map(o => o.m).join(', ').replace(/, ([^,]*)$/, ' e $1')} raccolgono ${art(perc(q4))} della popolazione vulnerabile.</p>
    <div class="tab-wrap" style="margin-top:12px"><table class="tab">
      <caption class="sr-only">Residenti e vulnerabili per Municipalità, con le cabine primarie attraversate</caption>
      <thead><tr><th scope="col">Mun.</th><th scope="col">Quartieri</th><th scope="col" class="r">Residenti</th><th scope="col" class="r">Vulnerabili</th><th scope="col" class="r">Quota dei vulnerabili della città</th><th scope="col">Cabine primarie attraversate</th></tr></thead>
      <tbody>${righe}</tbody></table></div>`;
}

/* ================================================================ COLONNA DESTRA */
function renderParametri(){
  $('#o-soglia').textContent = '≥ ' + P.T;
  $('#p-soglia').value = P.T;
  $('#p-soglia').setAttribute('aria-valuetext', 'soglia ' + P.T + ', ' + n0(R.city.nV) + ' sezioni vulnerabili');
  $$('[data-soglia]').forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.soglia === P.T)));
  $('#e-soglia').innerHTML = `<b>${n0(R.city.nV)}</b> sezioni sopra soglia · <b>${n0(R.city.popV)}</b> residenti vulnerabili (${perc(R.city.popV / R.popTot * 100)})`;
  if(document.activeElement !== $('#p-cons-n')) $('#p-cons-n').value = P.k;
  $('#p-cons').value = P.k;
  $('#p-cons').setAttribute('aria-valuetext', n0(P.k) + ' chilowattora per abitante all\'anno');
  $$('[data-cons]').forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.cons === P.k)));
  $('#e-cons').innerHTML = `Consumo dei vulnerabili: <b>${gwh(R.tot.cons)} GWh/a</b>${P.k !== TESI.k ? ` (${P.k < TESI.k ? '−' : '+'}${n0(Math.abs(P.k - TESI.k) / TESI.k * 100)}% rispetto alla tesi)` : ''}`;
  $('#o-cop').textContent = P.c + '%';
  $('#p-cop').value = P.c;
  $('#p-cop').setAttribute('aria-valuetext', P.c + ' per cento della copertura');
  $('#e-cop').innerHTML = `Coefficiente c = ${NF2.format(P.c / 100)} nell'Eq. 2 (tesi: 0,50). Producibilità ERP <b>${gwh(R.tot.pv.erp)} GWh/a</b>, tutte le coperture istituzionali <b>${gwh(R.tot.pv.erp + R.tot.pv.pub + R.tot.pv.ind)} GWh/a</b>.`;
  for(const d of DEST) $('#p-' + d).checked = P.att[d];
  const sc = scenarioCorrente();
  $$('[data-scen]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.scen === sc)));
  $('#e-scen').innerHTML = R.att.length ? `Attive: <b>${esc(attiviTesto())}</b> · ${gwh(R.tot.pvAtt)} GWh/a` : '<b>Nessuna copertura attiva</b>: la producibilità è zero.';
  $('#p-reset').disabled = !modificati();
}

function renderListaCab(){
  const q = ricerca.trim().toLowerCase();
  const voci = R.ord.filter(j => {
    const x = R.cab[j];
    if(filtro !== 'tutte' && CLASSE[x.cl] !== filtro) return false;
    if(!q) return true;
    const c = D.cab[j];
    const testo = (c.id + ' ' + c.mun.map(([m]) => 'municipalità ' + m + ' ' + D.munNome(m)).join(' ')).toLowerCase();
    return testo.includes(q);
  }).map(j => {
    const x = R.cab[j], c = D.cab[j], corr = vista === 'cabina' && cabAttiva === j;
    return `<li><button type="button" class="voce-cab" data-cab="${c.id}"${corr ? ' aria-current="true"' : ''}>
      ${pillClasse(x.cl)}<span class="cod">${c.id}</span><span class="vv">${n0(x.popV)} <small>vuln.</small></span>
      <span class="dove">${esc(c.mun.slice(0, 2).map(([m]) => D.munNome(m).split(' · ')[0]).join(', '))} · ${x.rapAtt === null ? 'nessun vulnerabile' : 'rapporto ' + perc(x.rapAtt)}</span></button></li>`;
  });
  $('#lista-cab').innerHTML = voci.join('') || '<li class="vuoto">Nessuna cabina corrisponde al filtro.</li>';
}

/* ================================================================ MAPPA DELLA CITTÀ */
const MC = {map:null, sez:null, cab:null, lab:null, mun:null, sfondo:null};
const PASSI_CITTA = [
  {p:1, t:'Perimetrazione', s:'cabine primarie'},
  {p:2, t:'Classificazione regolatoria', s:'aree idonee'},
  {p:3, t:'Offerta', s:'FER₁₀₀'},
  {p:4, t:'Domanda', s:'IVSM₁₀₀'},
  {p:5, t:'Priorità', s:'sovrapposizione'},
];
const PASSI_CAB = [
  {p:2, t:'Classificazione regolatoria', s:'aree idonee'},
  {p:3, t:'Offerta', s:'FER₁₀₀'},
  {p:4, t:'Domanda', s:'IVSM₁₀₀'},
  {p:5, t:'Offerta × domanda', s:'sezioni prioritarie'},
];
function renderPassi(el, passi, attivo, scope){
  el.innerHTML = passi.map(x => `<li><button type="button" class="passo" data-${scope}="${x.p}" aria-pressed="${x.p === attivo}">
    <span class="n" aria-hidden="true">${x.p}</span><span class="t">${x.t}<small>${x.s}</small></span><span class="sr-only">, step ${x.p}</span></button></li>`).join('');
}

function decodifica(enc){
  const pts = new Array(enc.length / 2);
  let x = enc[0], y = enc[1]; pts[0] = [y / SC, x / SC];
  for(let k = 2, n = 1; k < enc.length; k += 2, n++){ x += enc[k]; y += enc[k + 1]; pts[n] = [y / SC, x / SC]; }
  return pts;
}

function sfondi(m){
  if(BUILD === 'artifact') return;                    // l'anteprima non carica tessere esterne
  const nessuno = L.layerGroup();
  const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom:19, attribution:'© OpenStreetMap'});
  const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {maxZoom:19, attribution:'Esri World Imagery'});
  nessuno.addTo(m);
  const avviso = () => { if(m._avvisoTessere) return; m._avvisoTessere = true;
    const d = document.createElement('div'); d.className = 'avviso-mappa'; d.setAttribute('role', 'status');
    d.textContent = 'Lo sfondo cartografico richiede una connessione a internet: senza, la mappa resta leggibile sulle sole sezioni.';
    m.getContainer().parentElement.appendChild(d); setTimeout(() => d.remove(), 8000); };
  osm.on('tileerror', avviso); sat.on('tileerror', avviso);
  L.control.layers({'Nessuno sfondo':nessuno, 'Mappa stradale':osm, 'Satellite':sat}, null, {position:'topright'}).addTo(m);
}

function nuovaMappa(id){
  const m = L.map(id, {zoomSnap:.25, zoomDelta:.5, minZoom:10.5, maxZoom:18, zoomControl:false, attributionControl:true, keyboardPanDelta:120});
  L.control.zoom({position:'topleft', zoomInTitle:'Ingrandisci', zoomOutTitle:'Riduci'}).addTo(m);
  m.attributionControl.setPrefix('<a href="https://leafletjs.com" hreflang="en">Leaflet</a>');
  m.attributionControl.addAttribution('Dati: ISTAT 2021, GSE, MASE, SIT Città Metropolitana di Napoli, OSM');
  for(const [nome, z] of [['sez', 405], ['cab', 420], ['mun', 425], ['edi', 430], ['etich', 640]]){
    const p = m.createPane(nome); p.style.zIndex = z;
  }
  m.getPane('mun').style.pointerEvents = 'none';
  m.getPane('etich').style.pointerEvents = 'none';
  sfondi(m);
  return m;
}

function creaMappaCitta(){
  const m = MC.map = nuovaMappa('mappa-citta');
  const rS = L.canvas({padding:.35, pane:'sez'}), rC = L.canvas({padding:.35, pane:'cab'}), rM = L.canvas({padding:.35, pane:'mun'});
  MC.rS = rS;
  const polys = new Array(N);
  for(let i = 0; i < N; i++){ const p = L.polygon(decodifica(S.g[i]), {renderer:rS, weight:.35}); p._i = i; polys[i] = p; }
  MC.sez = L.featureGroup(polys);
  MC.sez.bindTooltip(l => ttSez(l._i), {sticky:true, className:'tt', direction:'top', offset:[0, -8]});
  MC.sez.on('click', e => apriSezione(e.layer._i));
  MC.cab = L.featureGroup(D.cab.map((c, j) => { const p = L.polygon(c.r.map(r => [decodifica(r)]), {renderer:rC, weight:1.6}); p._j = j; return p; }));
  MC.cab.bindTooltip(l => ttCab(l._j), {sticky:true, className:'tt', direction:'top', offset:[0, -8]});
  MC.cab.on('click', e => { if(passoCitta === 1 || (passoCitta === 5 && varCitta === 'cab')) location.hash = '#cabina-' + D.cab[e.layer._j].id; });
  MC.cab.on('mouseover', e => { if(cabInterattive()) e.layer.setStyle({weight:3.2}); });
  MC.cab.on('mouseout', e => { if(cabInterattive()) e.layer.setStyle({weight:stileCabCitta(e.layer._j).weight}); });
  MC.cab.addTo(m);
  MC.mun = L.featureGroup(D.mun.map(o => L.polygon(o.r.map(r => [decodifica(r)]), {renderer:rM, interactive:false, fill:false, weight:1.3, dashArray:'5 5'})));
  MC.lab = L.layerGroup().addTo(m);
  m.fitBounds(MC.cab.getBounds(), {padding:[12, 12]});
  aggiornaMappaCitta();
}
const cabInterattive = () => passoCitta === 1 || (passoCitta === 5 && varCitta === 'cab');

function stileSez(i, passo){
  const base = {stroke:true, color:COL['m-line'], weight:.35, opacity:1, fill:true, fillOpacity:1};
  if(passo === 2){ const k = S.reg[i]; base.fillColor = k === 3 ? tratteggio(MC.rS && MC.rS._ctx) : REG_COL(k); }
  else if(passo === 3){ const k = S.ferc[i]; base.fillColor = k < 0 ? COL['sez-none'] : OFF_COL()[k]; }
  else if(passo === 4){ const k = ivClasse(i); base.fillColor = k < 0 ? COL['sez-none'] : DOM_COL()[k]; }
  else {
    const q = R.cond[i];
    base.fillColor = S.pop[i] === 0 && q === 0 ? COL['sez-none'] : COND_COL(q);
    if(q >= 2){ base.color = base.fillColor; base.weight = 1.4; }     // le sezioni vulnerabili restano visibili anche da lontano
  }
  return base;
}
function stileCabCitta(j){
  if(passoCitta === 1) return {color:COL['m-cab'], weight:2, opacity:1, fill:true, fillColor:COL['m-cabfill'], fillOpacity:1};
  if(passoCitta === 5 && varCitta === 'cab') return {color:COL['m-cab'], weight:1.8, opacity:1, fill:true, fillColor:PRI_COL(R.cab[j].cl), fillOpacity:1};
  return {color:COL['m-cab'], weight:1.8, opacity:.95, fill:false};
}

function aggiornaMappaCitta(){
  if(!MC.map) return;
  const m = MC.map, mostraSez = passoCitta >= 2 && !(passoCitta === 5 && varCitta === 'cab');
  if(mostraSez){ if(!m.hasLayer(MC.sez)) MC.sez.addTo(m); MC.sez.eachLayer(l => l.setStyle(stileSez(l._i, passoCitta))); }
  else if(m.hasLayer(MC.sez)) m.removeLayer(MC.sez);
  MC.cab.eachLayer(l => l.setStyle(stileCabCitta(l._j)));
  m.getPane('cab').style.pointerEvents = cabInterattive() ? 'auto' : 'none';
  if(passoCitta === 1){ if(!m.hasLayer(MC.mun)) MC.mun.addTo(m); MC.mun.setStyle({color:COL['ink-2']}); }
  else if(m.hasLayer(MC.mun)) m.removeLayer(MC.mun);
  // etichette dei codici di cabina
  MC.lab.clearLayers();
  D.cab.forEach((c, j) => {
    const extra = passoCitta === 5 && varCitta === 'cab' ? `<i>${CLASSE[R.cab[j].cl]}</i>` : '';
    MC.lab.addLayer(L.marker([c.c[1], c.c[0]], {pane:'etich', interactive:false, keyboard:false,
      icon:L.divIcon({className:'etichetta-cab', html:`<span>${codice(c.id)}${extra}</span>`, iconSize:[0, 0]})}));
  });
  $('#mappa-citta').setAttribute('aria-label', 'Mappa del Comune di Napoli, step ' + passoCitta + ': ' + titoloPasso(passoCitta, varCitta));
  renderLegenda($('#legenda-citta'), passoCitta, varCitta, null);
  renderTestoPasso();
}

/* ---------------------------------------------------------------- testi e legende dei passi */
function titoloPasso(p, v){
  return {1:'perimetrazione delle unità di analisi', 2:'classificazione regolatoria del suolo', 3:'scenario di offerta',
          4:'scenario di domanda', 5:v === 'cab' ? 'classi di priorità delle cabine' : 'sezioni prioritarie, offerta per domanda'}[p];
}
function testoPassoCitta(p, v){
  const c = R.city, t = R.tot;
  const c1 = R.cls[1];
  switch(p){
    case 1: return {h:'Step 1 · Perimetrazione delle unità di analisi',
      t:`Le ${D.cab.length} cabine primarie delimitano l'area entro cui l'energia di un impianto può essere condivisa tra i membri di una CER: è un vincolo della norma, non una scelta di progetto. Coprono ${NF2.format(D.meta.area_km2)} km² e ${n0(N)} sezioni censuarie, l'unità di dettaglio dell'analisi. Le linee tratteggiate sono le dieci Municipalità: i due reticoli non coincidono. Clic su una cabina per aprirla.`};
    case 2: return {h:'Step 2 · Classificazione regolatoria del suolo',
      t:`Ogni sezione è colorata per la classe prevalente del DM 21 giugno 2024: aree idonee con iter accelerato, ordinarie con regime ordinario, non idonee (tratteggiate) incompatibili con alcune tipologie di impianto. L'indicatore N<sub>s</sub> pesa le superfici 1, 0,5 e 0. La classe condiziona dove si installa l'impianto, non chi ne beneficia.`};
    case 3: return {h:'Step 3 · Scenario di offerta',
      t:`La producibilità delle coperture (Eq. 2: E = R · A · c · η · PR) è normalizzata nell'indicatore S<sub>s</sub> e combinata con N<sub>s</sub> nella mappa FER<sub>100</sub> = (N<sub>s</sub> + S<sub>s</sub>)/2. Più scuro significa che lì conviene cominciare a installare. Da FER<sub>100</sub> ${n1(D.meta.fer_alta)}, il 70° percentile delle sezioni abitate, l'offerta è considerata elevata. Le coperture di ERP, patrimonio pubblico e industriale producono ${gwh(t.pv.erp + t.pv.pub + t.pv.ind)} GWh/a ${art(P.c + '%', 'con')} dei tetti.`};
    case 4: return {h:'Step 4 · Scenario di domanda',
      t:`L'IVSM<sub>100</sub> misura la vulnerabilità sociale e materiale dei residenti di ogni sezione. Con la soglia ≥ ${P.T} risultano <strong>${n0(c.nV)} sezioni</strong> e <strong>${n0(c.popV)} residenti</strong> (${perc(c.popV / R.popTot * 100)} della popolazione), con un consumo elettrico stimato di <strong>${gwh(t.cons)} GWh/a</strong> a ${n0(P.k)} kWh per abitante.`};
    case 5: if(v === 'cab') return {h:'Step 5 · Classi di priorità delle cabine',
      t:`Le cabine sono ordinate per numero assoluto di residenti vulnerabili e divise in tre classi con le interruzioni naturali di Jenks, con almeno tre cabine per classe. In <strong>C1</strong> ci sono ${elencoCab(c1.cab)}, ${art(perc(c.popV ? c1.popV / c.popV * 100 : 0), 'con')} dei vulnerabili: è lì che l'intervento raggiunge più destinatari.`};
      return {h:'Step 5 · Sezioni prioritarie',
      t:`Ogni sezione è letta come coppia offerta-domanda. In <strong>${n0(c.n[3])} sezioni</strong> sono elevate entrambe (${n0(c.pV[3])} vulnerabili, ${perc(c.popV ? c.pV[3] / c.popV * 100 : 0)}): produzione e bisogno coincidono. <strong>${n0(c.n[2])} sezioni</strong> hanno domanda elevata e offerta contenuta (${n0(c.pV[2])} vulnerabili): sono destinatarie. <strong>${n0(c.n[1])} sezioni</strong> a offerta elevata e domanda contenuta sono il serbatoio da cui l'energia può raggiungerle, dentro la stessa cabina.`};
  }
}
function renderTestoPasso(){
  const x = testoPassoCitta(passoCitta, varCitta);
  const varianti = passoCitta === 5 ? `<div class="varianti" role="group" aria-label="Lettura dello step 5">
      <button type="button" data-var="cab" aria-pressed="${varCitta === 'cab'}">Classi delle cabine</button>
      <button type="button" data-var="sez" aria-pressed="${varCitta === 'sez'}">Sezioni: offerta × domanda</button></div>` : '';
  $('#testo-citta').innerHTML = `<h3>${x.h}</h3><p>${x.t}</p>${varianti}`;
}

function voce(col, testo){
  return `<span class="voce"><span class="campione" style="background:${col}"></span>${testo}</span>`;
}
function renderLegenda(el, p, v, cabJ){
  const z = cabJ === null ? R.city : R.cab[cabJ];
  let h = '';
  if(p === 1){
    h = `<span class="legenda-t">Le dodici cabine primarie</span>` +
        `<span class="voce"><span class="campione" style="background:${COL['m-cabfill']};border:2px solid ${COL['m-cab']}"></span>perimetro di condivisione (etichetta: ultime tre cifre del codice AC001E00…)</span>` +
        `<span class="voce"><span class="campione" style="background:none;border:1.5px dashed ${COL['ink-2']}"></span>Municipalità</span>`;
  } else if(p === 2){
    const n = [0, 0, 0, 0]; for(const i of iterSez(cabJ)) n[S.reg[i]]++;
    h = `<span class="legenda-t">Classe regolatoria prevalente (DM 21/06/2024)</span>` +
        voce(COL['reg-idonea'], `idonea <span class="q">${n0(n[1])}</span>`) + voce(COL['reg-ord'], `ordinaria <span class="q">${n0(n[2])}</span>`) +
        `<span class="voce"><span class="campione tratteggio" style="background-color:${COL['reg-non']}"></span>non idonea <span class="q">${n0(n[3])}</span></span>` +
        (n[0] ? voce(COL['sez-none'], `dato non disponibile <span class="q">${n0(n[0])}</span>`) : '');
  } else if(p === 3){
    const nomi = ['meno di 25', '25 – 28,2', '28,2 – 35', '35 – 50', '50 e oltre'];
    const n = [0, 0, 0, 0, 0]; for(const i of iterSez(cabJ)) if(S.ferc[i] >= 0) n[S.ferc[i]]++;
    h = `<span class="legenda-t">FER<sub>100</sub> = (N<sub>s</sub> + S<sub>s</sub>)/2 · da 28,2 offerta elevata</span>` +
        OFF_COL().map((c, k) => voce(c, `${nomi[k]} <span class="q">${n0(n[k])}</span>`)).join('');
  } else if(p === 4){
    const T = P.T, a = n1(T / 3), b = n1(2 * T / 3);
    const nomi = [`0 – ${a}`, `${a} – ${b}`, `${b} – ${T}`, `≥ ${T}: vulnerabile`];
    const n = [0, 0, 0, 0], nv = {v:0}; for(const i of iterSez(cabJ)){ const k = ivClasse(i); if(k >= 0) n[k]++; else nv.v++; }
    h = `<span class="legenda-t">IVSM<sub>100</sub> della sezione · soglia ≥ ${T}</span>` +
        DOM_COL().map((c, k) => voce(c, `${nomi[k]} <span class="q">${n0(n[k])}</span>`)).join('') + voce(COL['sez-none'], `non abitata <span class="q">${n0(nv.v)}</span>`);
  } else if(v === 'cab'){
    h = `<span class="legenda-t">Classe di priorità della cabina (residenti vulnerabili, Jenks)</span>` +
        [1, 2, 3].map(k => voce(PRI_COL(k), `${CLASSE[k]} · ${CLASSE_NOME[k]} <span class="q">${R.cls[k].n} cabine, ${n0(R.cls[k].popV)} vulnerabili</span>`)).join('');
  } else {
    h = `<span class="legenda-t">Sezioni per condizione (offerta elevata: FER<sub>100</sub> ≥ ${n1(D.meta.fer_alta)} · domanda elevata: IVSM<sub>100</sub> ≥ ${P.T})</span>` +
        voce(COL['sez-hh'], `offerta e domanda elevate <span class="q">${n0(z.n[3])}</span>`) +
        voce(COL['sez-lh'], `solo domanda elevata <span class="q">${n0(z.n[2])}</span>`) +
        voce(COL['sez-hl'], `solo offerta elevata <span class="q">${n0(z.n[1])}</span>`) +
        voce(COL['sez-ll'], `fuori priorità <span class="q">${n0(z.n[0])}</span>`);
  }
  el.innerHTML = h;
}
function* iterSez(cabJ){
  if(cabJ === null){ for(let i = 0; i < N; i++) yield i; }
  else for(const i of D.cab[cabJ].sez) yield i;
}

function ttSez(i){
  const c = D.cab[S.cab[i]], p = S.pop[i];
  return `<b>Sezione ${S.id[i]}</b> · cabina ${codice(c.id)}<br>` +
    (p > 0 ? `${n0(p)} residenti · IVSM<sub>100</sub> ${ivTxt(i)}${R.vul[i] ? ' · <b>vulnerabile</b>' : ''}` : 'Sezione non abitata') +
    `<br>Classe ${REG_NOME[S.reg[i]]} · FER<sub>100</sub> ${ferTxt(i)}<br>${COND[R.cond[i]]}`;
}
function ttCab(j){
  const x = R.cab[j], c = D.cab[j];
  return `<b>${c.id}</b> · ${CLASSE[x.cl]} ${CLASSE_NOME[x.cl]}<br>${n0(x.popV)} vulnerabili su ${n0(c.pop)} residenti<br>Rapporto potenziale ${perc(x.rapAtt)}` +
    (cabInterattive() ? '<br>Clic per aprire la cabina' : '');
}

function impostaPassoCitta(p, v, daTour){
  passoCitta = p; if(v) varCitta = v;
  $$('#passi-citta .passo').forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.citta === p)));
  aggiornaMappaCitta();
  if(!daTour && tour >= 0){
    const k = TOUR.findIndex(s => s.p === p && (!s.v || s.v === varCitta));
    if(k >= 0){ tour = k; renderGuida(false); }
  }
}

/* ================================================================ PERCORSO GUIDATO */
const TOUR = [{p:1}, {p:2}, {p:3}, {p:4}, {p:5, v:'cab'}, {p:5, v:'sez'}, {fine:true}];
function avviaPercorso(){
  if(vista !== 'napoli'){ history.pushState(null, '', '#napoli'); instrada(); }
  tour = 0; applicaTour(true);
}
function applicaTour(focus){
  const s = TOUR[tour];
  if(s.fine) impostaPassoCitta(5, 'sez', true); else impostaPassoCitta(s.p, s.v || varCitta, true);
  renderGuida(focus);
  if(focus){ const b = $('#blocco-mappa'); b.scrollIntoView({behavior:RIDOTTO ? 'auto' : 'smooth', block:'start'}); }
}
function renderGuida(focus){
  const g = $('#guida');
  if(tour < 0){ g.hidden = true; g.innerHTML = ''; return; }
  const s = TOUR[tour], tappe = TOUR.length - 1;
  const punti = TOUR.slice(0, -1).map((_, k) => `<span class="${k < tour ? 'fatto' : k === tour ? 'ora' : ''}"></span>`).join('');
  let corpo, comandi;
  if(s.fine){
    const c = R.city, c1 = R.cls[1], prima = R.ord[0];
    corpo = `<h3 id="guida-h" tabindex="-1">Esito: le aree prioritarie</h3>
      <p>Con i parametri attuali conviene cominciare dalle cabine in classe C1 e, al loro interno, dalle sezioni dove offerta e domanda coincidono. Poi si collegano le sezioni produttive alle sezioni a sola domanda della stessa cabina.</p>
      <ul class="esito-lista">
        <li><strong>Cabine C1:</strong> ${c1.cab.map(j => `<button type="button" class="btn-link" data-cab="${D.cab[j].id}">${D.cab[j].id}</button>`).join(', ')} · ${n0(c1.popV)} vulnerabili (${perc(c.popV ? c1.popV / c.popV * 100 : 0)})</li>
        <li><strong>${n0(c.n[3])} sezioni</strong> dove offerta e domanda coincidono, con ${n0(c.pV[3])} vulnerabili</li>
        <li><strong>${n0(c.n[2])} sezioni</strong> a sola domanda, con ${n0(c.pV[2])} vulnerabili da servire con l'energia prodotta altrove nella cabina</li>
        <li><strong>${n0(R.tot.serv)} vulnerabili</strong> raggiungibili con ${esc(attiviTesto())}</li>
        <li>Per ogni cabina c'è una <a href="#h-paesc">scheda d'azione per il PAESC</a>, pronta da allegare al piano</li>
      </ul>`;
    comandi = `<button type="button" class="btn" data-tour="indietro"><svg aria-hidden="true"><use href="#i-back"/></svg>Indietro</button>
      <button type="button" class="btn" data-tour="chiudi">Chiudi il percorso</button>
      <a class="btn btn-primario" href="#cabina-${D.cab[prima].id}">Apri la cabina ${D.cab[prima].id}<svg aria-hidden="true"><use href="#i-next"/></svg></a>`;
  } else {
    const x = testoPassoCitta(s.p, s.v || varCitta);
    corpo = `<div class="guida-avanz"><span>Passo ${tour + 1} di ${tappe}</span><span class="guida-punti" aria-hidden="true">${punti}</span></div>
      <h3 id="guida-h" tabindex="-1">${x.h}</h3><p>${x.t}</p>`;
    comandi = `<button type="button" class="btn" data-tour="indietro"${tour === 0 ? ' disabled' : ''}><svg aria-hidden="true"><use href="#i-back"/></svg>Indietro</button>
      <button type="button" class="btn" data-tour="chiudi">Chiudi</button>
      <button type="button" class="btn btn-primario" data-tour="avanti">${tour === tappe - 1 ? 'Vedi l\'esito' : 'Avanti'}<svg aria-hidden="true"><use href="#i-next"/></svg></button>`;
  }
  g.innerHTML = corpo + `<div class="guida-comandi">${comandi}</div>`;
  g.hidden = false;
  $('#testo-citta').hidden = true;
  if(focus) setTimeout(() => { const h = $('#guida-h'); if(h) h.focus({preventScroll:true}); }, RIDOTTO ? 0 : 350);
}
function chiudiPercorso(){
  tour = -1; renderGuida(false); $('#testo-citta').hidden = false;
  $('#btn-avvia').focus();
}

/* ================================================================ VISTA CABINA */
const MK = {map:null, sez:null, cab:null, edi:null, r:null};
function renderCabina(){
  const j = cabAttiva, c = D.cab[j], x = R.cab[j];
  document.title = c.id + ' · SSD CER Napoli';
  const munTxt = c.mun.map(([m, q]) => `${munBreve(m)} (${Math.round(q)}%)`).join('; ');
  $('#testa-cabina').innerHTML = `<p class="occhiello">Cabina primaria · perimetro di condivisione dell'energia</p>
    <div class="titolo-cab"><h1 id="h-cab" tabindex="-1">${c.id}</h1>${pillClasse(x.cl, true)}
      <button type="button" class="btn" data-scheda="${c.id}"><svg aria-hidden="true"><use href="#i-doc"/></svg>Scheda d'azione PAESC</button></div>
    <p class="dove-cab">${esc(munTxt)}</p>
    ${DESCR_TESI[c.id] ? `<p class="nota">${DESCR_TESI[c.id]}</p>` : ''}
    <p class="dati-sintetici"><span><strong>${n0(c.pop)}</strong> residenti</span><span><strong>${NF2.format(c.area)}</strong> km²</span><span><strong>${n0(c.nsez)}</strong> sezioni censuarie, ${n0(c.nab)} abitate</span><span>${R.ord.indexOf(j) + 1}ª per residenti vulnerabili</span></p>
    <p class="parametri-attivi">${lineaParametri()}</p>`;
  const q = x.popV ? x.serv / x.popV * 100 : 0;
  $('#sintesi-cabina').innerHTML = `<div class="kpi kpi-vuln">${kpiVuln(x.popV, x.nV, c.pop, x.cons)}</div>
    <div class="kpi"><p class="kpi-l">Producibilità attivata, ${esc(attiviTesto())}</p><p class="kpi-v">${energia(x.pvAtt).replace(/ (GWh|MWh)\/a/, '<small>$1/a</small>')}</p>
      <p class="kpi-s">rapporto potenziale ${perc(x.rapAtt)} · saldo ${segno(x.saldo)} MWh/a</p>
      <div class="kpi-barra" aria-hidden="true"><span style="width:${Math.min(100, x.rapAtt || 0)}%"></span></div></div>
    <div class="kpi"><p class="kpi-l">Vulnerabili raggiungibili</p><p class="kpi-v">${n0(x.serv)}</p>
      <p class="kpi-s">${x.popV ? art(perc(q)) + ' dei vulnerabili della cabina' : 'nessun residente vulnerabile alla soglia scelta'}</p>
      <div class="kpi-barra" aria-hidden="true"><span style="width:${Math.min(100, q)}%"></span></div></div>`;
  renderBilancio(j);
  renderConfig(j);
  renderSezioniPrio(j);
  renderPassi($('#passi-cab'), PASSI_CAB, passoCab, 'pcab');
  aggiornaMappaCab();
}

function renderBilancio(j){
  const x = R.cab[j];
  const riga = d => {
    const v = x.rap[d], on = P.att[d];
    const w = v === null ? 0 : Math.min(100, v / 2);
    return `<div class="riga-bil${on ? '' : ' spenta'}">
      <div class="nome"><span class="campione" style="background:${COL['bld-' + d]}"></span><span>${DEST_NOME[d]}<small>${on ? 'attivata' : d === 'res' ? 'termine di confronto' : 'non attivata'}</small></span></div>
      <div class="val">${perc(v)}</div>
      <div class="traccia-box"><div class="traccia" role="img" aria-label="Rapporto potenziale ${perc(v)}"><span class="${v >= 100 ? 'ok' : ''}" style="width:${w}%"></span><i style="left:50%"></i></div></div>
      <div class="nota-bil">${n0(x.pv[d])} MWh/a · saldo ${segno(x.pv[d] - x.cons)} MWh/a</div>
    </div>`;
  };
  $('#blocco-bil').innerHTML = `<div class="blocco-testa"><div><p class="occhiello">Step 5 · bilancio tra offerta e domanda</p><h2 id="h-bil">Bilancio per destinazione</h2></div></div>
    <p class="nota">Producibilità delle coperture della cabina divisa per il consumo dei suoi ${n0(x.popV)} residenti vulnerabili (${n0(x.cons)} MWh/a). La tacca segna il 100%, la barra arriva al 200%.</p>
    <div class="bilancio-righe" style="margin-top:14px">${DEST.map(riga).join('')}</div>
    <div class="riquadro" style="margin-top:16px"><h3>Copertura effettiva ERP: ${x.copEff === null ? '—' : perc(x.copEff)}</h3>
      <p class="nota">Quota del consumo dei vulnerabili coperta dall'energia ERP prodotta nella loro stessa sezione, dopo averla ripartita fra vulnerabili, non vulnerabili ed eccedenza (Tab. 6.6). È un limite inferiore: la norma ammette la condivisione in tutta la cabina.</p></div>`;
}

function tipoCer(x){
  if(x.min === undefined) return {n:'Nessuna domanda vulnerabile', d:'Alla soglia scelta la cabina non ha residenti vulnerabili: una configurazione qui risponde a obiettivi diversi da quello distributivo.'};
  if(x.min === null) return {n:'Nessuna combinazione basta', d:'Neppure ERP, patrimonio pubblico e industriale insieme coprono il consumo dei vulnerabili. Il residuo richiede l\'apertura ai prosumer del residenziale privato o la riduzione della domanda con la riqualificazione del patrimonio ERP.'};
  const k = x.min.join('+');
  if(k === 'erp') return {n:'CER promossa dall\'ente gestore ERP', d:'Basta l\'edilizia residenziale pubblica: decide un solo soggetto, proprietario delle coperture e gestore degli alloggi. È anche dove produzione e destinatari tendono a coincidere.'};
  if(k === 'pub') return {n:'CER promossa dal Comune', d:'Basta il patrimonio pubblico non residenziale: scuole, uffici, attrezzature. Il controllo resta pubblico; la compatibilità con gli usi in atto va verificata caso per caso.'};
  if(k === 'erp+pub') return {n:'CER pubblica a due soggetti', d:'Ente gestore ERP e Comune insieme: configurazione promossa e governata interamente dall\'operatore pubblico.'};
  if(k === 'erp+pub+ind') return {n:'CER integrata: ACER, Comune e privati', d:'Nessuna destinazione basta da sola: serve il concorso simultaneo dell\'ente gestore ERP, del Comune e dei titolari delle coperture produttive. È l\'ambito in cui il mandato pianificatorio è più necessario.'};
  return {n:'CER a partecipazione mista', d:'Serve l\'edificato industriale: la superficie è privata, quindi l\'ente locale promuove un accordo di condivisione con le imprese. È la destinazione che la disciplina delle aree idonee privilegia.'};
}
function renderConfig(j){
  const x = R.cab[j], tc = tipoCer(x);
  const barra = (s) => { const v = x.scen[s]; return `<div class="riga-bil">
      <div class="nome">${SCEN_NOME[s]}</div>
      <div class="val">${v === null ? '—' : perc(Math.min(100, v))}</div>
      <div class="traccia-box"><div class="traccia" aria-hidden="true"><span class="${v >= 100 ? 'ok' : ''}" style="width:${Math.min(100, v || 0)}%"></span></div></div>
      <div class="nota-bil">${v === null ? '' : stato(v)}</div></div>`; };
  $('#blocco-conf').innerHTML = `<div class="blocco-testa"><div><p class="occhiello">Gli scenari di intervento</p><h2 id="h-conf">Configurazione minima sufficiente</h2></div></div>
    <div class="config"><p class="occhiello" style="margin:0">Combinazione minima che copre il consumo dei vulnerabili</p>
      <p class="nome-config">${esc(x.min ? COMBO_NOME[x.min.join('+')] : configTesto(x))}</p>
      <p><strong>${esc(tc.n)}.</strong> ${esc(tc.d)}</p></div>
    <h3 style="margin-top:16px">Scenari cumulati per questa cabina</h3>
    <div class="bilancio-righe" style="margin-top:10px">${['A', 'B', 'C'].map(barra).join('')}</div>
    <div style="margin-top:18px;display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="btn btn-primario" data-scheda="${D.cab[j].id}"><svg aria-hidden="true"><use href="#i-doc"/></svg>Scheda d'azione PAESC</button></div>`;
}

function righeSezioni(j, q){
  const ids = D.cab[j].sez.filter(i => R.cond[i] === q);
  const prod = i => R.att.reduce((a, d) => a + (d === 'erp' ? S.fe[i] : d === 'pub' ? S.fp[i] : d === 'ind' ? S.fi[i] : S.fr[i]), 0) / 100 * P.c / 50;
  ids.sort(q === 1 ? (a, b) => prod(b) - prod(a) || S.fer[b] - S.fer[a] : (a, b) => S.pop[b] - S.pop[a]);
  return {ids, prod};
}
function renderSezioniPrio(j){
  const x = R.cab[j];
  const tabs = [3, 2, 1].map(q => `<button type="button" role="tab" class="scheda-btn" id="tab-q${q}" aria-controls="pan-sez" aria-selected="${schedaSez === q}" tabindex="${schedaSez === q ? 0 : -1}" data-q="${q}">
      <span class="campione" style="background:${COND_COL(q)}"></span>${COND[q]} <span class="q">(${n0(x.n[q])})</span></button>`).join('');
  $('#blocco-sez').innerHTML = `<div class="blocco-testa"><div><p class="occhiello">Lo zoom alla scala della sezione</p><h2 id="h-sez-prio">Da quali sezioni cominciare</h2></div></div>
    <p class="nota">Si comincia dalle sezioni in cui offerta e domanda coincidono: l'impianto serve i residenti dello stesso isolato. Poi si collegano le sezioni produttive della cabina a quelle a sola domanda, perché la condivisione vale in tutto il perimetro.</p>
    <div class="schede" role="tablist" aria-label="Sezioni per condizione" style="margin-top:12px">${tabs}</div>
    <div id="pan-sez" role="tabpanel" aria-labelledby="tab-q${schedaSez}"></div>`;
  renderTabellaSez(j, false);
}
function renderTabellaSez(j, tutte){
  const q = schedaSez, {ids, prod} = righeSezioni(j, q);
  const lim = tutte ? ids.length : Math.min(ids.length, 12);
  const righe = ids.slice(0, lim).map(i => `<tr>
    <th scope="row"><button type="button" class="btn-riga" data-sez="${S.id[i]}">${S.id[i]}</button></th>
    <td class="r">${S.pop[i] ? n0(S.pop[i]) : 'non abitata'}</td><td class="r">${R.vul[i] ? n0(S.pop[i]) : '—'}</td><td class="r">${ivTxt(i)}</td>
    <td>${REG_NOME[S.reg[i]]}</td><td class="r">${ferTxt(i)}</td><td class="r">${n1(prod(i))}</td></tr>`).join('');
  $('#pan-sez').innerHTML = ids.length ? `<div class="tab-wrap"><table class="tab">
      <caption class="sr-only">${COND[q]}: ${ids.length} sezioni</caption>
      <thead><tr><th scope="col">Sezione</th><th scope="col" class="r">Residenti</th><th scope="col" class="r">Vulnerabili</th><th scope="col" class="r">IVSM<sub>100</sub></th>
        <th scope="col">Classe regolatoria</th><th scope="col" class="r">FER<sub>100</sub></th><th scope="col" class="r">Producibilità attivata (MWh/a)</th></tr></thead>
      <tbody>${righe}</tbody></table></div>
      ${ids.length > lim ? `<button type="button" class="btn" style="margin-top:10px" data-tutte="1">Mostra tutte le ${n0(ids.length)} sezioni</button>` : ''}`
    : `<p class="vuoto">Nessuna sezione in questa condizione con i parametri attuali.</p>`;
}

/* ---------------------------------------------------------------- mappa della cabina */
function creaMappaCab(){
  MK.map = nuovaMappa('mappa-cab');
  MK.r = L.canvas({padding:.35, pane:'sez'});
  MK.rC = L.canvas({padding:.35, pane:'cab'});
  MK.map.getPane('cab').style.pointerEvents = 'none';
}
function aggiornaMappaCab(){
  if(!MK.map) creaMappaCab();
  const m = MK.map, j = cabAttiva, c = D.cab[j];
  if(MK.j !== j){
    if(MK.sez) m.removeLayer(MK.sez);
    if(MK.cab) m.removeLayer(MK.cab);
    if(MK.edi){ m.removeLayer(MK.edi); MK.edi = null; }
    MK.sez = L.featureGroup(c.sez.map(i => { const p = L.polygon(decodifica(S.g[i]), {renderer:MK.r, weight:.6}); p._i = i; return p; }));
    MK.sez.bindTooltip(l => ttSez(l._i), {sticky:true, className:'tt', direction:'top', offset:[0, -8]});
    MK.sez.on('click', e => apriSezione(e.layer._i));
    MK.sez.addTo(m);
    MK.cab = L.featureGroup([L.polygon(c.r.map(r => [decodifica(r)]), {renderer:MK.rC, interactive:false, fill:false, weight:2.4})]).addTo(m);
    MK.j = j;
    setTimeout(() => { m.invalidateSize(); m.fitBounds(MK.cab.getBounds(), {padding:[14, 14]}); }, 30);
    if($('#chk-edifici').checked) disegnaEdifici();
  }
  const opac = MK.edi ? .45 : 1;
  MK.sez.eachLayer(l => { const s = stileSez(l._i, passoCab); s.weight = Math.max(.6, s.weight); s.fillOpacity = opac;
    if(passoCab === 2 && S.reg[l._i] === 3) s.fillColor = tratteggio(MK.r._ctx); l.setStyle(s); });
  MK.cab.setStyle({color:COL['m-cab']});
  $$('#passi-cab .passo').forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.pcab === passoCab)));
  const x = testoPassoCab(passoCab, j);
  $('#testo-cab').innerHTML = `<h3>${x.h}</h3><p>${x.t}</p>`;
  renderLegenda($('#legenda-cab'), passoCab, 'sez', j);
  if(MK.edi) $('#legenda-cab').insertAdjacentHTML('beforeend', legendaEdifici());
  $('#mappa-cab').setAttribute('aria-label', 'Mappa della cabina ' + c.id + ', step ' + passoCab + ': ' + titoloPasso(passoCab, 'sez'));
}
function testoPassoCab(p, j){
  const x = R.cab[j], c = D.cab[j];
  const n = [0, 0, 0, 0]; for(const i of c.sez) n[S.reg[i]]++;
  switch(p){
    case 2: return {h:'Step 2 · Classificazione regolatoria', t:`${n0(n[1])} sezioni a prevalenza idonea, ${n0(n[2])} ordinaria, ${n0(n[3])} non idonea (tratteggiate). Le non idonee rendono più gravoso l'impianto, ma i loro residenti restano beneficiari della CER.`};
    case 3: return {h:'Step 3 · Scenario di offerta', t:`FER<sub>100</sub> per sezione: combina idoneità del suolo e producibilità delle coperture. ${n0(x.n[1] + x.n[3])} sezioni hanno offerta elevata (FER<sub>100</sub> ≥ ${n1(D.meta.fer_alta)}).`};
    case 4: return {h:'Step 4 · Scenario di domanda', t:`${n0(x.nV)} sezioni con IVSM<sub>100</sub> ≥ ${P.T}, dove abitano ${n0(x.popV)} residenti vulnerabili: il loro consumo stimato è di ${n0(x.cons)} MWh/a.`};
    default: return {h:'Step 5 · Offerta × domanda', t:`${n0(x.n[3])} sezioni dove offerta e domanda coincidono (${n0(x.pV[3])} vulnerabili), ${n0(x.n[2])} a sola domanda (${n0(x.pV[2])} vulnerabili), ${n0(x.n[1])} a sola offerta: il serbatoio da cui l'energia può raggiungere chi non ha coperture utilizzabili.`};
  }
}

/* ---------------------------------------------------------------- edifici (caricati solo quando servono) */
async function caricaEdifici(){
  if(FOOT) return FOOT;
  if(!footInCorso) footInCorso = carica('footprints').then(f => { FOOT = f; return f; });
  return footInCorso;
}
const BLD_TIPO = {e:'erp', p:'pub', i:'ind', r:'res'};
async function disegnaEdifici(){
  const m = MK.map, j = cabAttiva;
  const note = $('#legenda-cab');
  if(!FOOT) note.insertAdjacentHTML('beforeend', '<span class="voce" id="caric-edifici">Caricamento degli edifici…</span>');
  let f;
  try{ f = await caricaEdifici(); }
  catch(e){ const el = $('#caric-edifici'); if(el) el.textContent = 'Edifici non disponibili in questa versione.'; return; }
  if(cabAttiva !== j || !$('#chk-edifici').checked) return;
  const sezSet = new Set(D.cab[j].sez.map(i => S.id[i]));
  const scale = f.scale || 100000;
  const polys = [];
  for(const b of f.b){
    if(!sezSet.has(b[1])) continue;
    const enc = b[3], pts = [];
    let x = enc[0], y = enc[1]; pts.push([y / scale, x / scale]);
    for(let k = 2; k < enc.length; k += 2){ x += enc[k]; y += enc[k + 1]; pts.push([y / scale, x / scale]); }
    const t = BLD_TIPO[b[0]] || 'res';
    const p = L.polygon(pts, {renderer:MK.r, color:COL['ink'], weight:.6, opacity:.8, fillColor:COL['bld-' + t], fillOpacity:1});
    p._b = b; polys.push(p);
  }
  if(MK.edi) m.removeLayer(MK.edi);
  MK.edi = L.featureGroup(polys).addTo(m);
  MK.edi.bindTooltip(l => ttEdificio(l._b), {sticky:true, className:'tt', direction:'top', offset:[0, -8]});
  MK.edi.on('click', e => { const i = S.idx.get(String(e.layer._b[1])); if(i !== undefined) apriSezione(i); });
  aggiornaMappaCab();
}
function ttEdificio(b){
  const t = BLD_TIPO[b[0]] || 'res', area = b[2] || 0;
  // stima indicativa con il coefficiente corrente: kWp ≈ superficie · c · η (0,20)
  const kwp = area * P.c / 100 * D.meta.eta, mwh = kwp * D.meta.kwh_kwp / 1000;
  const nome = (b[4] || '').trim(), uso = (b[5] || '').trim();
  return `<b>${esc(nome || DEST_NOME[t])}</b>${nome ? '<br>' + DEST_NOME[t] : ''}${uso ? ' · ' + esc(uso) : ''}<br>Copertura ${n0(area)} m² · circa ${n0(kwp)} kWp · ${n1(mwh)} MWh/a<br>Sezione ${b[1]}`;
}
function legendaEdifici(){
  return `<span class="legenda-t" style="margin-top:6px">Edifici per destinazione</span>` +
    DEST.map(d => voce(COL['bld-' + d], DEST_NOME[d])).join('');
}

/* ================================================================ DIALOGHI */
let ultimoFocus = null;
function apriDialogo(id){
  const d = document.getElementById(id);
  if(!d) return;
  if(id === 'dlg-ivsm') renderIvsm();
  if(id === 'dlg-metodo') renderMetodo();
  ultimoFocus = document.activeElement;
  if(d.open) d.close();
  d.showModal();
  const h = d.querySelector('h2'); if(h){ h.setAttribute('tabindex', '-1'); h.focus(); }
}
function chiudiDialoghi(){ $$('dialog[open]').forEach(d => d.close()); }

function renderIvsm(){
  const c = R.city;
  $('#dlg-ivsm-corpo').innerHTML = `
    <p>L'IVSM<sub>100</sub> è l'indice di vulnerabilità sociale e materiale ricostruito per ciascuna delle ${n0(N)} sezioni censuarie, partendo dall'indice dell'ISTAT che a Napoli non scende sotto 68 aree. È la media di cinque indicatori, ognuno riportato tra 0 e 100 con lo stesso verso: valori alti indicano più vulnerabilità.</p>
    <ul>
      <li><strong>Istruzione</strong>: quota dei residenti di 9 anni e più senza titolo di studio o analfabeti (ISTAT 2021).</li>
      <li><strong>Lavoro</strong>: quota della popolazione in età da lavoro non occupata, inattivi compresi (ISTAT 2021).</li>
      <li><strong>Famiglie numerose</strong>: quota delle famiglie con cinque o più componenti (ISTAT 2021).</li>
      <li><strong>Anziani</strong>: quota dei residenti di 70 anni e oltre (ISTAT 2021).</li>
      <li><strong>Edilizia pubblica</strong>: superficie ERP sul totale dell'edificato residenziale della sezione (SIT Città Metropolitana).</li>
    </ul>
    <p class="formula">IVSM<sub>100</sub> = (EDU<sub>LOW</sub> + EMP<sub>VULN</sub> + FAM<sub>NUM</sub> + OLD<sub>70</sub> + ERP_RES<sub>100</sub>) / 5 &nbsp;(Eq. 4)</p>
    <h3>Dalla soglia alla popolazione vulnerabile</h3>
    <ol>
      <li>Si fissa una soglia. La tesi usa 60: è il limite inferiore della quarta di cinque classi di ampiezza costante e cade vicino al 95° percentile e alla media più due deviazioni standard. La soglia 70 serve come verifica di sensitività.</li>
      <li>Sono vulnerabili le sezioni abitate con IVSM<sub>100</sub> uguale o superiore alla soglia.</li>
      <li>La popolazione vulnerabile è la somma dei residenti di quelle sezioni.</li>
      <li>Il consumo da coprire è la popolazione vulnerabile per il consumo elettrico per abitante: 2.441 kWh all'anno nella tesi, la media residenziale di Napoli nel 2020.</li>
    </ol>
    <div class="riquadro"><h3>Con i parametri di adesso</h3>
      <div class="esempio">
        <span>Soglia</span><b>IVSM<sub>100</sub> ≥ ${P.T}</b>
        <span>Sezioni sopra soglia</span><b>${n0(c.nV)}</b>
        <span>Residenti vulnerabili</span><b>${n0(c.popV)} (${perc(c.popV / R.popTot * 100)} dei residenti)</b>
        <span>Consumo per abitante</span><b>${n0(P.k)} kWh all'anno</b>
        <span>Consumo da coprire</span><b>${n0(c.popV)} × ${n0(P.k)} kWh = ${gwh(R.tot.cons)} GWh/a</b>
      </div></div>
    <h3>Come leggerla</h3>
    <p>È una stima per aree: non dice che ogni residente di quelle sezioni sia vulnerabile, né che altrove non ci siano famiglie vulnerabili. Serve a ordinare gli ambiti, non a individuare le persone. La vulnerabilità non è filtrata dalla classificazione regolatoria: chi abita in un'area non idonea resta beneficiario, perché conta l'appartenenza alla stessa cabina primaria.</p>
    <p class="fonte">Tesi, par. 5.5 e 6.2.4; Tab. 5.3 e 6.5.</p>`;
}

function renderMetodo(){
  $('#dlg-metodo-corpo').innerHTML = `
    <p>Lo strumento restituisce il framework GIS dei capitoli 5 e 6 della tesi. Opera a due scale: la cabina primaria, unità di prioritizzazione perché entro il suo perimetro la condivisione è ammessa, e la sezione censuaria, unità di dettaglio.</p>
    <ol>
      <li><strong>Perimetrazione delle unità di analisi.</strong> 12 cabine primarie (GSE) e ${n0(N)} sezioni censuarie (ISTAT 2021).</li>
      <li><strong>Classificazione regolatoria del suolo.</strong> Aree idonee, ordinarie e non idonee del DM 21/06/2024, sintetizzate per sezione in N<sub>s</sub> con pesi 1, 0,5 e 0 (Eq. 1).</li>
      <li><strong>Scenario di offerta.</strong> E = R · A · c · η · PR (Eq. 2), con radiazione R dal modello digitale delle superfici, c = 0,50, η = 0,20, PR = 0,85. La producibilità normalizzata S<sub>s</sub> e N<sub>s</sub> danno FER<sub>100</sub> = (N<sub>s</sub> + S<sub>s</sub>)/2 (Eq. 3).</li>
      <li><strong>Scenario di domanda.</strong> IVSM<sub>100</sub> per sezione (Eq. 4); con la soglia si ottengono la popolazione vulnerabile e il suo consumo.</li>
      <li><strong>Sovrapposizione e prioritizzazione.</strong> Alla scala della cabina il bilancio tra producibilità e consumo dei vulnerabili e le classi C1–C3 (Jenks); alla scala della sezione le quattro condizioni di offerta e domanda.</li>
    </ol>
    <h3>Gli scenari</h3>
    <p>A attiva l'edilizia residenziale pubblica, B aggiunge il patrimonio pubblico non residenziale, C l'edificato industriale. Il residenziale privato produce dieci volte il consumo dei vulnerabili ma richiede l'adesione di migliaia di proprietari: resta un termine di confronto.</p>
    <h3>Che cosa cambia con i parametri</h3>
    <ul>
      <li><strong>Soglia IVSM</strong>: quali sezioni sono vulnerabili, quindi popolazione, consumo, classi delle cabine e sezioni prioritarie.</li>
      <li><strong>Consumo per abitante</strong>: il consumo da coprire, i bilanci, i residenti raggiungibili e la configurazione minima.</li>
      <li><strong>Superficie dei tetti utilizzabile</strong>: il coefficiente c dell'Eq. 2. La producibilità vi è proporzionale, quindi cambiano bilanci e configurazioni; FER<sub>100</sub> no, perché S<sub>s</sub> è normalizzato al massimo osservato.</li>
      <li><strong>Coperture attivate</strong>: quali destinazioni contano nel bilancio; possono essere combinate liberamente, non solo come scenari A, B e C.</li>
    </ul>
    <h3>Limiti dichiarati</h3>
    <ul>
      <li>Le impronte dell'edificato sono del 2011 e il modello delle superfici del 2013, mentre la domanda è del 2021: la producibilità descrive il costruito mappato, non quello attuale.</li>
      <li>L'indice di vulnerabilità è una stima per aree e serve a ordinare gli ambiti, non a individuare le persone.</li>
      <li>Cambiare i pesi dell'indice o i coefficienti diversi da c richiede di ripetere l'elaborazione GIS.</li>
      <li>Lo strumento non ha funzioni partecipative e non dimensiona gli impianti, che richiedono profili di prelievo misurati.</li>
    </ul>
    <p class="fonte">${esc(D.meta.fonte)}.</p>`;
}

function apriSezione(i){
  const c = D.cab[S.cab[i]], p = S.pop[i], q = R.cond[i], fc = P.c / 50;
  $('#dlg-sezione-occh').textContent = `Sezione censuaria · cabina ${c.id}${S.mun[i] ? ' · Municipalità ' + S.mun[i] : ''}`;
  $('#dlg-sezione-h').textContent = 'Sezione ' + S.id[i];
  const v10 = x => x < 0 ? 'n.d.' : NF1.format(x / 10) + '%';
  const reg = S.reg[i];
  const righeCop = DEST.map(d => {
    const sup = d === 'erp' ? S.se[i] : d === 'pub' ? S.sp[i] : d === 'ind' ? S.si[i] : S.sr[i];
    const nb = d === 'erp' ? S.be[i] : d === 'pub' ? S.bp[i] : d === 'ind' ? S.bi[i] : S.br[i];
    const mw = (d === 'erp' ? S.fe[i] : d === 'pub' ? S.fp[i] : d === 'ind' ? S.fi[i] : S.fr[i]) / 100 * fc;
    if(!sup && !mw) return '';
    return `<tr><th scope="row">${DEST_NOME[d]}</th><td class="r">${n0(nb)}</td><td class="r">${n0(sup)}</td><td class="r">${n1(mw)}</td><td class="r">${n0(mw * 1000 / D.meta.kwh_kwp)}</td></tr>`;
  }).join('');
  const domV = R.vul[i] ? p * P.k / 1000 : 0;
  const erpS = S.fe[i] / 100 * fc;
  $('#dlg-sezione-corpo').innerHTML = `
    <p><span class="voce"><span class="campione" style="background:${COND_COL(q)}"></span><strong>${COND[q]}</strong></span></p>
    <p class="nota">${q === 3 ? 'Qui produzione e bisogno coincidono: è da sezioni come questa che conviene cominciare.' : q === 2 ? 'Sezione destinataria: la sua domanda va coperta con l\'energia prodotta altrove nella stessa cabina.' : q === 1 ? 'Sezione serbatoio: conviene installare anche senza domanda locale, per servire le sezioni vulnerabili della cabina.' : 'Offerta e domanda sono entrambe contenute.'}</p>
    <div class="griglia-2">
      <div><h3>Domanda</h3><dl class="dati">
        <dt>Residenti</dt><dd>${p ? n0(p) : 'non abitata'}</dd>
        <dt>Famiglie</dt><dd>${n0(S.fam[i])}</dd>
        <dt>IVSM<sub>100</sub></dt><dd>${ivTxt(i)}${p ? (R.vul[i] ? ' · sopra soglia' : ' · sotto soglia') : ''}</dd>
        <dt>Istruzione · EDU<sub>LOW</sub></dt><dd>${v10(S.edu[i])}</dd>
        <dt>Lavoro · EMP<sub>VULN</sub></dt><dd>${v10(S.emp[i])}</dd>
        <dt>Anziani · OLD<sub>70</sub></dt><dd>${v10(S.old[i])}</dd>
        ${S.erpp[i] >= 0 && S.se[i] > 0 ? `<dt>Quota ERP dell'edificato</dt><dd>${v10(S.erpp[i])}</dd>` : ''}
        <dt>Consumo dei vulnerabili</dt><dd>${R.vul[i] ? n1(domV) + ' MWh/a' : '—'}</dd>
      </dl></div>
      <div><h3>Classificazione regolatoria</h3><dl class="dati">
        <dt>Classe prevalente</dt><dd>${REG_NOME[reg]}</dd>
        <dt>Quota idonea</dt><dd>${v10(S.ni[i])}</dd><dt>Quota ordinaria</dt><dd>${v10(S.no[i])}</dd><dt>Quota non idonea</dt><dd>${v10(S.nn[i])}</dd>
        <dt>N<sub>s</sub></dt><dd>${S.ns[i] < 0 ? 'n.d.' : NF1.format(S.ns[i] / 10)}</dd>
        <dt>S<sub>s</sub></dt><dd>${S.ss[i] < 0 ? 'n.d.' : NF1.format(S.ss[i] / 10)}</dd>
        <dt>FER<sub>100</sub></dt><dd>${ferTxt(i)}</dd>
      </dl></div>
    </div>
    ${righeCop ? `<div><h3>Coperture e producibilità ${art(P.c + '%', 'con')} dei tetti</h3>
      <div class="tab-wrap" style="margin-top:6px"><table class="tab" style="min-width:520px"><caption class="sr-only">Coperture per destinazione</caption>
      <thead><tr><th scope="col">Destinazione</th><th scope="col" class="r">Edifici</th><th scope="col" class="r">Copertura (m²)</th><th scope="col" class="r">MWh/a</th><th scope="col" class="r">kWp circa</th></tr></thead>
      <tbody>${righeCop}</tbody></table></div></div>` : '<p class="nota">Nessuna copertura mappata in questa sezione.</p>'}
    ${R.vul[i] && domV > 0 ? `<p class="nota">L'energia ERP prodotta nella sezione (${n1(erpS)} MWh/a) copre ${art(perc(Math.min(100, erpS / domV * 100)))} del consumo dei suoi vulnerabili; il resto può arrivare da tutta la cabina.</p>` : ''}
    <div style="display:flex;gap:8px;flex-wrap:wrap">${vista !== 'cabina' || cabAttiva !== S.cab[i] ? `<a class="btn btn-primario" href="#cabina-${c.id}" data-chiudi-nav>Apri la cabina ${c.id}</a>` : ''}</div>`;
  apriDialogo('dlg-sezione');
}

/* ---------------------------------------------------------------- scheda d'azione PAESC */
function apriScheda(id){
  const j = D.cab.findIndex(c => c.id === id); if(j < 0) return;
  const c = D.cab[j], x = R.cab[j], tc = tipoCer(x);
  const siti = c.sez.filter(i => R.cond[i] === 3 || R.cond[i] === 1)
    .map(i => ({i, mw:(S.fe[i] + S.fp[i] + S.fi[i]) / 100 * P.c / 50})).filter(o => o.mw > 0 && S.reg[o.i] !== 3)
    .sort((a, b) => b.mw - a.mw).slice(0, 8);
  const kwp = x.pvAtt * 1000 / D.meta.kwh_kwp;
  const tempi = {1:['Breve termine, entro due anni', 'Massima concentrazione di popolazione vulnerabile.'],
                 2:['Medio termine, da due a quattro anni', 'Secondo fronte, dopo le prime esperienze in classe C1.'],
                 3:['Lungo termine o sperimentale', 'Intervento residuale rispetto alla finalità distributiva; adatto a sperimentare il modello di governance.']}[x.cl];
  const reg = [['erp', 'Ente gestore ERP con il Comune, a beneficio degli assegnatari'], ['pub', 'Comune di Napoli, su scuole, uffici e attrezzature'],
               ['ind', 'Imprese titolari delle coperture, con accordo promosso dal Comune'], ['res', 'Condomini e amministratori, con uno sportello energia comunale']]
               .filter(([d]) => P.att[d] && x.pv[d] > 0);
  const munTxt = c.mun.map(([m, q]) => `${munBreve(m)} (${Math.round(q)}%)`).join('; ');
  const riga = (l, v) => `<tr><th scope="row">${l}</th><td>${v}</td></tr>`;
  const nReg = [0, 0, 0, 0]; for(const i of c.sez) nReg[S.reg[i]]++;
  $('#foglio').innerHTML = `
    <div class="f-testa"><div><p class="f-occh">Comune di Napoli · PAESC, Piano d'Azione per l'Energia Sostenibile e il Clima</p>
      <h1>Scheda d'azione · Comunità energetica rinnovabile</h1>
      <p>Ambito della cabina primaria <strong>${c.id}</strong> · classe <strong>${CLASSE[x.cl]}, ${CLASSE_NOME[x.cl]}</strong></p></div>
      <div class="f-cod">CER<br>${codice(c.id)}</div></div>
    <h2>1 · Inquadramento</h2><table><tbody>
      ${riga('Perimetro', `Cabina primaria ${c.id}: l'ambito entro cui la norma consente la condivisione dell'energia (D.Lgs. 199/2021)`)}
      ${riga('Estensione', `${NF2.format(c.area)} km² · ${n0(c.nsez)} sezioni censuarie, ${n0(c.nab)} abitate`)}
      ${riga('Residenti', n0(c.pop))}
      ${riga('Residenti vulnerabili', `${n0(x.popV)} (IVSM<sub>100</sub> ≥ ${P.T}), ${art(perc(c.pop ? x.popV / c.pop * 100 : 0))} dei residenti`)}
      ${riga('Municipalità', esc(munTxt))}
      ${riga('Classe di priorità', `${CLASSE[x.cl]}, per numero assoluto di residenti vulnerabili (interruzioni naturali di Jenks sulle 12 cabine)`)}
    </tbody></table>
    <h2>2 · Bilancio e configurazione</h2><table><tbody>
      ${riga('Consumo dei vulnerabili', `${n0(x.cons)} MWh/a (${n0(P.k)} kWh per abitante)`)}
      ${DEST.filter(d => d !== 'res').map(d => riga('Producibilità ' + DEST_BREVE[d], `${n0(x.pv[d])} MWh/a · rapporto ${perc(x.rap[d])}`)).join('')}
      ${riga('Configurazione minima sufficiente', `<strong>${esc(x.min ? COMBO_NOME[x.min.join('+')] : configTesto(x))}</strong>`)}
      ${riga('Tipo di comunità', `<strong>${esc(tc.n)}</strong>. ${esc(tc.d)}`)}
    </tbody></table>
    <h2>3 · Obiettivo</h2>
    <p>Costituire una comunità energetica rinnovabile a finalità solidale nell'ambito della cabina ${c.id}, installando gli impianti sulle coperture più produttive fuori dalle aree non idonee e destinando l'energia condivisa in via prioritaria ai nuclei in condizione di vulnerabilità sociale e materiale residenti nell'ambito.</p>
    <h2>4 · Quadro regolatorio</h2><table><tbody>
      ${riga('Riferimenti', 'DM 21/06/2024 (aree idonee), attuativo dell\'art. 20 del D.Lgs. 199/2021 · Piattaforma Aree Idonee MASE')}
      ${riga('Sezioni a prevalenza idonea', `${n0(nReg[1])}: procedimento accelerato e agevolato`)}
      ${riga('Sezioni a prevalenza ordinaria', `${n0(nReg[2])}: regime ordinario`)}
      ${riga('Sezioni a prevalenza non idonea', `${n0(nReg[3])}: impianti sconsigliati; i residenti restano beneficiari`)}
    </tbody></table>
    <h2>5 · Siti per l'installazione</h2>
    ${siti.length ? `<table class="g"><thead><tr><th scope="col">Sezione</th><th scope="col">Condizione</th><th scope="col">Classe regolatoria</th><th scope="col" class="r">FER<sub>100</sub></th><th scope="col" class="r">MWh/a (ERP, pubblico, industriale)</th></tr></thead>
      <tbody>${siti.map(o => `<tr><td>${S.id[o.i]}</td><td>${COND_BREVE[R.cond[o.i]]}</td><td>${REG_NOME[S.reg[o.i]]}</td><td class="r">${ferTxt(o.i)}</td><td class="r">${n0(o.mw)}</td></tr>`).join('')}</tbody></table>
      <p class="f-nota">Sezioni a offerta elevata (FER<sub>100</sub> ≥ ${n1(D.meta.fer_alta)}) fuori dalle aree non idonee, ordinate per producibilità delle coperture istituzionali.</p>`
      : `<p>Nessuna sezione a offerta elevata con coperture istituzionali fuori dalle aree non idonee: servono aree ordinarie o il residenziale privato.</p>`}
    <h2>6 · Risultati attesi</h2><table><tbody>
      ${riga('Coperture attivate', esc(attiviTesto()))}
      ${riga('Potenza installabile stimata', `${n0(kwp)} kWp`)}
      ${riga('Produzione da fonte rinnovabile', `<strong>${n0(x.pvAtt)} MWh/a</strong>`)}
      ${riga('Residenti vulnerabili raggiungibili', `<strong>${n0(x.serv)}</strong> su ${n0(x.popV)}`)}
      ${riga('Emissioni evitate (stima indicativa)', `${n0(x.pvAtt * CO2_T_MWH)} t CO₂/a, con fattore ${NF2.format(CO2_T_MWH)} t/MWh da allineare all'inventario di base del PAESC`)}
    </tbody></table>
    <h2>7 · Soggetti e regia</h2>
    ${reg.length ? `<table><tbody>${reg.map(([d, s]) => riga(DEST_NOME[d], s)).join('')}</tbody></table>` : '<p>Da definire: nessuna copertura attivata.</p>'}
    <p class="f-nota">Coordinamento: Comune di Napoli, in raccordo con l'ente gestore del patrimonio ERP e il distributore di rete.</p>
    <h2>8 · Tempi</h2><table><tbody>${riga('Orizzonte', `<strong>${tempi[0]}</strong>. ${tempi[1]}`)}
      ${riga('Fasi', '1) manifestazione d\'interesse e individuazione dei membri · 2) studio di fattibilità sui siti · 3) costituzione del soggetto giuridico · 4) progettazione e autorizzazioni · 5) realizzazione e attivazione')}</tbody></table>
    <h2>9 · Indicatori di monitoraggio</h2>
    <table class="g"><thead><tr><th scope="col">Indicatore</th><th scope="col">Unità</th><th scope="col" class="r">Obiettivo</th></tr></thead><tbody>
      <tr><td>Potenza fotovoltaica installata</td><td>kWp</td><td class="r">${n0(kwp)}</td></tr>
      <tr><td>Energia prodotta e condivisa</td><td>MWh/a</td><td class="r">${n0(x.pvAtt)}</td></tr>
      <tr><td>Membri in condizione di vulnerabilità</td><td>persone</td><td class="r">${n0(x.serv)}</td></tr>
      <tr><td>Quota del consumo dei vulnerabili coperta</td><td>%</td><td class="r">${x.popV ? n0(Math.min(100, x.serv / x.popV * 100)) : '—'}</td></tr>
    </tbody></table>
    <h2>10 · Parametri e fonti</h2>
    <p class="f-nota">Soglia IVSM<sub>100</sub> ≥ ${P.T} · consumo ${n0(P.k)} kWh per abitante · superficie utilizzabile ${P.c}% (coefficiente c, Eq. 2) · ${esc(attiviTesto())}. Cabine primarie: GSE · aree idonee: Piattaforma MASE, DM 21/06/2024 · vulnerabilità: IVSM<sub>100</sub> su censimento ISTAT 2021 · coperture: SIT Città Metropolitana di Napoli e OpenStreetMap · radiazione: modello digitale delle superfici PST-A. Elaborazione: SSD CER Napoli v9, ${new Date().toLocaleDateString('it-IT')}.</p>`;
  $('#btn-stampa').hidden = BUILD === 'artifact';
  apriDialogo('dlg-scheda');
}

/* ================================================================ AGGIORNAMENTO */
let annuncioT = null, mappaT = null;
function ricalcola(annuncia){
  R = calcola();
  renderParametri();
  renderListaCab();
  if(vista === 'napoli') renderNapoli(); else { renderNapoliLeggero(); renderCabina(); }
  if(tour >= 0) renderGuida(false);
  clearTimeout(mappaT);
  mappaT = setTimeout(() => { if(vista === 'napoli') aggiornaMappaCitta(); }, 60);
  if($('#dlg-ivsm').open) renderIvsm();
  if(annuncia){
    clearTimeout(annuncioT);
    annuncioT = setTimeout(() => {
      $('#annuncio').textContent = `Soglia ${P.T}: ${n0(R.city.popV)} residenti vulnerabili in ${n0(R.city.nV)} sezioni, consumo ${gwh(R.tot.cons)} gigawattora l'anno. ` +
        `${R.cls[1].n} cabine in classe C1. Vulnerabili raggiungibili: ${n0(R.tot.serv)}.`;
    }, 700);
  }
}
// in vista cabina le tabelle della città si aggiornano solo quando si torna indietro
let napoliSporca = false;
function renderNapoliLeggero(){ napoliSporca = true; }

/* ================================================================ NAVIGAZIONE */
function instrada(){
  const h = decodeURIComponent(location.hash.slice(1));
  if(h.startsWith('cabina-')){
    const j = D.cab.findIndex(c => c.id === h.slice(7));
    if(j >= 0){ mostraCabina(j); return; }
  }
  if(h === '' || h === 'napoli' || h.startsWith('cabina-')) mostraNapoli(h === 'napoli');
}
function mostraNapoli(focus){
  const eraCab = vista === 'cabina';
  vista = 'napoli'; cabAttiva = -1;
  $('#vista-cabina').hidden = true; $('#vista-napoli').hidden = false;
  document.title = 'SSD CER Napoli';
  if(napoliSporca || eraCab){ napoliSporca = false; renderNapoli(); aggiornaMappaCitta(); }
  renderListaCab();
  if(MC.map) setTimeout(() => MC.map.invalidateSize(), 30);
  if(eraCab || focus){ window.scrollTo(0, 0); $('#h-napoli').focus({preventScroll:true}); }
}
function mostraCabina(j){
  const cambio = cabAttiva !== j;
  vista = 'cabina'; cabAttiva = j;
  if(cambio) schedaSez = 3;
  $('#vista-napoli').hidden = true; $('#vista-cabina').hidden = false;
  if(tour >= 0){ tour = -1; renderGuida(false); $('#testo-citta').hidden = false; }
  renderListaCab();
  renderCabina();
  window.scrollTo(0, 0);
  setTimeout(() => { if(MK.map) MK.map.invalidateSize(); }, 30);
  $('#h-cab').focus({preventScroll:true});
  $('#annuncio').textContent = `Aperta la cabina ${D.cab[j].id}, classe ${CLASSE[R.cab[j].cl]}.`;
}

/* ================================================================ CONTROLLI */
function collegaControlli(){
  const soglia = $('#p-soglia'), consR = $('#p-cons'), consN = $('#p-cons-n'), cop = $('#p-cop');
  soglia.addEventListener('input', () => { P.T = +soglia.value; ricalcola(true); });
  consR.addEventListener('input', () => { P.k = +consR.value; ricalcola(true); });
  consN.addEventListener('change', () => { let v = Math.round(+consN.value); if(!isFinite(v) || v < 500) v = 500; if(v > 4000) v = 4000; P.k = v; consN.value = v; ricalcola(true); });
  cop.addEventListener('input', () => { P.c = +cop.value; ricalcola(true); });
  for(const d of DEST) $('#p-' + d).addEventListener('change', e => { P.att[d] = e.target.checked; ricalcola(true); });
  $('#p-reset').addEventListener('click', () => { ripristina(); });

  document.addEventListener('click', e => {
    const t = e.target.closest('button, a');
    if(!t) return;
    if(t.dataset.soglia){ P.T = +t.dataset.soglia; ricalcola(true); return; }
    if(t.dataset.cons){ P.k = +t.dataset.cons; ricalcola(true); return; }
    if(t.dataset.scen){ const ks = SCEN[t.dataset.scen]; for(const d of DEST) P.att[d] = ks.includes(d); ricalcola(true); return; }
    if(t.hasAttribute('data-ripristina')){ ripristina(); return; }
    if(t.dataset.filtro){ filtro = t.dataset.filtro; $$('[data-filtro]').forEach(b => b.setAttribute('aria-pressed', String(b === t))); renderListaCab(); return; }
    if(t.dataset.pcab){ passoCab = +t.dataset.pcab; aggiornaMappaCab(); return; }
    if(t.dataset.cab && t.tagName === 'BUTTON'){ chiudiDialoghi(); location.hash = '#cabina-' + t.dataset.cab; return; }
    if(t.dataset.citta){ impostaPassoCitta(+t.dataset.citta, null, false); return; }
    if(t.dataset.var){ varCitta = t.dataset.var; impostaPassoCitta(5, t.dataset.var, false); const b = $(`[data-var="${t.dataset.var}"]`); if(b) b.focus(); return; }
    if(t.dataset.tour){
      const a = t.dataset.tour;
      if(a === 'avanti'){ tour = Math.min(TOUR.length - 1, tour + 1); applicaTour(true); }
      else if(a === 'indietro'){ tour = Math.max(0, tour - 1); applicaTour(true); }
      else chiudiPercorso();
      return;
    }
    if(t.dataset.apri){ apriDialogo(t.dataset.apri); return; }
    if(t.hasAttribute('data-chiudi')){ t.closest('dialog').close(); return; }
    if(t.hasAttribute('data-chiudi-nav')){ chiudiDialoghi(); return; }
    if(t.dataset.sez){ const i = S.idx.get(t.dataset.sez); if(i !== undefined){ if(MK.map && vista === 'cabina'){ const b = L.latLngBounds(decodifica(S.g[i])); MK.map.flyToBounds(b, {maxZoom:17, duration:RIDOTTO ? 0 : .6}); } apriSezione(i); } return; }
    if(t.dataset.scheda){ apriScheda(t.dataset.scheda); return; }
    if(t.dataset.q){ schedaSez = +t.dataset.q; renderSezioniPrio(cabAttiva); $('#tab-q' + schedaSez).focus(); return; }
    if(t.dataset.tutte){ renderTabellaSez(cabAttiva, true); return; }
  });
  // schede (tab) con le frecce
  document.addEventListener('keydown', e => {
    const t = e.target;
    if(t.getAttribute && t.getAttribute('role') === 'tab'){
      const tabs = $$('[role="tab"]', t.parentElement); let k = tabs.indexOf(t);
      if(e.key === 'ArrowRight') k = (k + 1) % tabs.length; else if(e.key === 'ArrowLeft') k = (k - 1 + tabs.length) % tabs.length;
      else if(e.key === 'Home') k = 0; else if(e.key === 'End') k = tabs.length - 1; else return;
      e.preventDefault(); tabs[k].click();
    }
  });
  $('#btn-avvia').addEventListener('click', avviaPercorso);
  $('#btn-metodo').addEventListener('click', () => apriDialogo('dlg-metodo'));
  $('#cerca-cab').addEventListener('input', e => { ricerca = e.target.value; renderListaCab(); });
  $('#chk-edifici').addEventListener('change', e => {
    if(e.target.checked) disegnaEdifici();
    else { if(MK.edi){ MK.map.removeLayer(MK.edi); MK.edi = null; } aggiornaMappaCab(); }
  });
  $('#btn-stampa').addEventListener('click', () => {
    document.body.classList.add('stampa-scheda');
    window.print();
    setTimeout(() => document.body.classList.remove('stampa-scheda'), 400);
  });
  $$('dialog').forEach(d => {
    d.addEventListener('close', () => { if(ultimoFocus && document.contains(ultimoFocus)) ultimoFocus.focus(); });
    d.addEventListener('click', e => { if(e.target === d) d.close(); });     // clic sullo sfondo
  });
  // passi della mappa della città
  renderPassi($('#passi-citta'), PASSI_CITTA, passoCitta, 'citta');
  if(BUILD === 'web') $('#lnk-offline').hidden = false;
  // tema
  const tb = $('#btn-tema');
  tb.addEventListener('click', () => {
    const nuovo = temaScuro() ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', nuovo);
    try{ localStorage.setItem('ssd-tema', nuovo); }catch(e){}
  });
}
function ripristina(){
  P.T = TESI.T; P.k = TESI.k; P.c = TESI.c; for(const d of DEST) P.att[d] = TESI.att[d];
  ricalcola(true);
}

/* ---------------------------------------------------------------- tema chiaro / scuro */
function temaScuro(){
  const a = document.documentElement.getAttribute('data-theme');
  if(a) return a === 'dark';
  return window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches;
}
function aggiornaTema(){
  const tb = $('#btn-tema'), scuro = temaScuro();
  tb.setAttribute('aria-pressed', String(scuro));
  tb.querySelector('span').textContent = 'Tema scuro';
  leggiColori();
  if(!R) return;
  if(MC.map) aggiornaMappaCitta();
  if(vista === 'cabina' && MK.map){ if(MK.edi){ MK.edi.eachLayer(l => l.setStyle({color:COL['ink'], fillColor:COL['bld-' + (BLD_TIPO[l._b[0]] || 'res')]})); } aggiornaMappaCab(); renderBilancio(cabAttiva); }
}
function osservaTema(){
  try{ const t = localStorage.getItem('ssd-tema'); if(t && !document.documentElement.hasAttribute('data-theme')) document.documentElement.setAttribute('data-theme', t); }catch(e){}
  new MutationObserver(aggiornaTema).observe(document.documentElement, {attributes:true, attributeFilter:['data-theme']});
  if(window.matchMedia){ const mq = matchMedia('(prefers-color-scheme: dark)'); (mq.addEventListener ? mq.addEventListener('change', aggiornaTema) : mq.addListener(aggiornaTema)); }
}

/* ================================================================ AVVIO */
async function avvia(){
  try{ D = await carica('dati'); }
  catch(e){
    $('#contenuto').insertAdjacentHTML('afterbegin', `<div class="blocco" role="alert"><h2>I dati non si sono caricati</h2><p class="lead">${esc(e.message)}. Se hai aperto il file index.html con un doppio clic, apri invece la versione offline (SSD-CER-Napoli.html), che contiene già i dati.</p></div>`);
    return;
  }
  prepara();
  osservaTema();
  leggiColori();
  collegaControlli();
  R = calcola();
  renderParametri();
  renderListaCab();
  renderNapoli();
  aggiornaTema();
  if(typeof L === 'undefined'){
    $('#mappa-citta').innerHTML = '<p class="vuoto" style="padding:16px">La libreria cartografica non si è caricata: le tabelle restano complete.</p>';
  } else creaMappaCitta();
  instrada();
  window.addEventListener('hashchange', instrada);
  window.__SSD = {P, calcola:() => calcola(), R:() => R, D:() => D};   // per le verifiche automatiche
}
if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', avvia); else avvia();
})();
