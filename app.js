/* ===== SSD v6 — Home Napoli + drill-down cabina → sezioni · 3 fonti FV ===== */
let DATA = null;
let activeCabina = null;
let currentFilter = 'all';
let currentSearch = '';
let map = null;           // mappa sezioni (vista cabina)
let sezLayer = null;
let prioMarkers = null;   // layer marker priorità CER (☀ 👥 ⭐)
let prioOverlay = true;   // overlay priorità attivo
let mapColorMode = 'match';

// ---------- Fonte FV selezionata ----------
// 'erp' | 'pub' | 'ind' | 'tot'
let fvSource = 'erp';
const SRC = {
  erp: { label:'ERP',         icon:'🏠', fv:s=>s.fv_mwh||0,  b:s=>s.erp_b||0, sup:s=>s.sup_erp||0, cabFv:c=>c.fv_erp_mwh||0, cabB:c=>c.erp_buildings||0, cabSup:c=>c.sup_erp_m2||0 },
  pub: { label:'Pubblico',    icon:'🏛', fv:s=>s.fv_pub||0,  b:s=>s.pub_b||0, sup:s=>s.sup_pub||0, cabFv:c=>c.fv_pub_mwh||0, cabB:c=>c.pub_buildings||0, cabSup:c=>c.sup_pub_m2||0 },
  ind: { label:'Industriale', icon:'🏭', fv:s=>s.fv_ind||0,  b:s=>s.ind_b||0, sup:s=>s.sup_ind||0, cabFv:c=>c.fv_ind_mwh||0, cabB:c=>c.ind_buildings||0, cabSup:c=>c.sup_ind_m2||0 },
  res: { label:'Residenziale', icon:'🏘', fv:s=>s.fv_res||0, b:s=>s.res_b||0, sup:s=>s.sup_res||0,
         cabFv:c=>c.fv_res_mwh||0, cabB:c=>c.res_buildings||0, cabSup:c=>c.sup_res_m2||0 },
  tot: { label:'tutti i tetti', icon:'Σ', fv:s=>s.fv_tot||((s.fv_mwh||0)+(s.fv_pub||0)+(s.fv_ind||0)+(s.fv_res||0)),
         b:s=>(s.erp_b||0)+(s.pub_b||0)+(s.ind_b||0)+(s.res_b||0),
         sup:s=>(s.sup_erp||0)+(s.sup_pub||0)+(s.sup_ind||0)+(s.sup_res||0),
         cabFv:c=>c.fv_tot_mwh||((c.fv_erp_mwh||0)+(c.fv_pub_mwh||0)+(c.fv_ind_mwh||0)+(c.fv_res_mwh||0)),
         cabB:c=>(c.erp_buildings||0)+(c.pub_buildings||0)+(c.ind_buildings||0)+(c.res_buildings||0),
         cabSup:c=>(c.sup_erp_m2||0)+(c.sup_pub_m2||0)+(c.sup_ind_m2||0)+(c.sup_res_m2||0) },
};

// ---------- Indice di producibilità 0-100 (rango percentile su tutte le sezioni) ----------
// Con la distribuzione fortemente asimmetrica dei MWh, il rango percentile rende la
// soglia leggibile: "prod > 60" = più produttiva del 60% delle sezioni della città.
let _prodRank = null;
function prodIndex(s){
  if(!_prodRank){
    _prodRank = {};
    const arr = DATA.sezioni.map(x=>({id:x.id, v:(x.fv_tot||0)})).sort((a,b)=>a.v-b.v);
    const n = arr.length;
    arr.forEach((o,i)=>{ _prodRank[o.id] = o.v>0 ? Math.round((i/(n-1))*1000)/10 : 0; });
  }
  return _prodRank[s.id] || 0;
}
const HIPROD = 60;                        // soglia di "alta producibilità"
const isHiProd = s => prodIndex(s) > HIPROD;
const isIdonea = s => normStatus(s).code === 'fac';
const isVulnSec = s => s.pop > 0 && (s.ivsm||0) >= THR;

// AMMISSIBILITÀ ≠ PRIORITÀ. Il DM 21/06/2024 distingue tre regimi: le aree idonee
// hanno iter semplificato, le ORDINARIE sono pienamente ammissibili con iter standard,
// solo le non idonee sono di fatto precluse. Un sito è quindi attivabile se non è
// bloccato; l'idoneità è un acceleratore, non un requisito di esistenza.
const isAmmissibile   = s => !hasNorm() || !isBlocked(s);
const isSitoAttivabile = s => isHiProd(s) && isAmmissibile(s);
const isSitoRapido     = s => isHiProd(s) && isIdonea(s);   // attivabile con iter semplificato
const sezFV = s => SRC[fvSource].fv(s);
const cabFV = c => SRC[fvSource].cabFv(c);

// ---------- Soglia vulnerabilità IVSM (60/70/80) — dal SSD-CER v5 ----------
let THR = 60;
const sezPV = s => s['pv'+THR] || 0;                    // pop. vulnerabile della sezione alla soglia
const cabTHR = c => (c.thr && c.thr[String(THR)]) || {};// blocco dati soglia della cabina

// ---------- Fattibilità normativa — DM 21/06/2024 (Decreto Aree Idonee) ----------
// Fonte: Piattaforma Aree Idonee (MASE/GSE, https://areeidonee.gse.it).
// Ogni sezione può avere s.nrm = { i:% sup. idonea, o:% ordinaria, n:% NON idonea, ns:0-100 }
// dove ns replica l'Eq.1 del paper: N_s = (1·A_idonea + 0,5·A_ordinaria + 0·A_non_idonea)/A_tot ×100.
// Il layer influenza SOLO la scelta della sezione dove installare l'impianto (lato "DOVE"):
// l'IVSM e il lato beneficiari ("PER CHI") NON rispondono alle aree idonee/non idonee.
let normOverlay = true;   // evidenzia i vincoli (tratteggio) sulla mappa sezioni
// Fasi del percorso normativo sulla mappa della cabina:
// 'all'   = quadro completo
// 'excl'  = ① escludi: le aree non idonee si spengono (fuori gioco)
// 'idon'  = ② evidenzia: restano accese le aree idonee (ordinarie in secondo piano)
// 'cross' = ③ interseca: idonee × producibilità → colore FER_100 (CER_OFFER_100)
let normPhase = 'all';
let ivsmOverlay = false;  // ④ spunta "per chi": evidenzia le sezioni vulnerabili
const hasNorm = () => !!(DATA && DATA.meta && DATA.meta.norm_loaded);
const NORM_COLORS = { fac:'#22c55e', ord:'#fbbf24', blk:'#ef4444', na:'#4d5568' };
function normStatus(s){
  if(!hasNorm() || !s.nrm) return {code:'na', lbl:'Layer normativo non caricato', short:'n.d.', color:NORM_COLORS.na, icon:''};
  const i=s.nrm.i||0, o=s.nrm.o||0, n=s.nrm.n||0;
  if(n >= i && n >= o) return {code:'blk', lbl:'Area NON idonea — bloccante', short:'non idonea', color:NORM_COLORS.blk, icon:'🚫'};
  if(i > o)            return {code:'fac', lbl:'Area idonea — iter semplificato', short:'idonea', color:NORM_COLORS.fac, icon:'✅'};
  return {code:'ord', lbl:'Area ordinaria — iter standard', short:'ordinaria', color:NORM_COLORS.ord, icon:'📋'};
}
const isBlocked = s => normStatus(s).code==='blk';
const normNs = s => (s.nrm && typeof s.nrm.ns==='number') ? s.nrm.ns : null;
// S_s (produzione FV normalizzata 0-100) e FER_100 = (N_s+S_s)/2 — "dove conviene
// installare" combinando idoneità normativa e produttività tecnica (paper, Sez. 3.2)
const normPv  = s => (s.nrm && typeof s.nrm.pv ==='number') ? s.nrm.pv  : null;
const normFer = s => (s.nrm && typeof s.nrm.fer==='number') ? s.nrm.fer : null;
let _hasFer = null;
function hasFer(){
  if(_hasFer===null) _hasFer = hasNorm() && DATA.sezioni.some(s=>s.nrm && typeof s.nrm.fer==='number');
  return _hasFer;
}

// Aggregato normativo per cabina (cache — i dati sono statici)
const _cabNormCache = {};
function cabNorm(c){
  if(_cabNormCache[c.id]) return _cabNormCache[c.id];
  const sez = DATA.sezioni.filter(s=>s.cab===c.id);
  const r = { nSez:sez.filter(s=>!s.empty).length, nBlk:0, nFac:0, nOrd:0,
              fvBlk:{erp:0,pub:0,ind:0,tot:0}, fvOk:{erp:0,pub:0,ind:0,tot:0},
              areaBlk:0, areaFac:0, areaTot:0, ferW:0, ferA:0 };
  sez.forEach(s=>{
    // FER medio: pesato su tutta la superficie (anche sezioni non abitate)
    const fer = normFer(s);
    if(fer!==null){ r.ferW += fer*(s.area||1); r.ferA += (s.area||1); }
    if(s.empty) return;   // contatori e FV: solo sezioni abitate
    const st = normStatus(s).code;
    const fe=s.fv_mwh||0, fp=s.fv_pub||0, fi=s.fv_ind||0, ft=s.fv_tot||fe+fp+fi;
    const dst = st==='blk' ? r.fvBlk : r.fvOk;
    dst.erp+=fe; dst.pub+=fp; dst.ind+=fi; dst.tot+=ft;
    r.areaTot += s.area||0;
    if(st==='blk'){ r.nBlk++; r.areaBlk += s.area||0; }
    else if(st==='fac'){ r.nFac++; r.areaFac += s.area||0; }
    else if(st==='ord'){ r.nOrd++; }
  });
  r.pctFvBlk = (r.fvBlk.tot + r.fvOk.tot) > 0 ? r.fvBlk.tot/(r.fvBlk.tot+r.fvOk.tot)*100 : 0;
  r.ferAvg = r.ferA > 0 ? r.ferW/r.ferA : null;   // FER_100 medio pesato per superficie
  _cabNormCache[c.id] = r;
  return r;
}
// FV bloccato/attivabile della fonte selezionata
const cabFvBlk = c => { const k=fvSource==='tot'?'tot':fvSource; return cabNorm(c).fvBlk[k]||0; };

// ---------- Tipologia di CER da implementare, dal mix dell'edificato ----------
// Una CER ha bisogno di un ANCORAGGIO: una copertura ampia con un solo proprietario,
// che avvii la configurazione. Il residenziale privato è ovunque e da solo non basta
// (richiede aggregazione condominiale), quindi la tipologia si legge dal peso relativo
// delle fonti non residenziali, con il residenziale come bacino di adesione.
const CER_TIPI = {
  erp:  {n:'CER solidale su ERP', col:'#2db885',
         d:'Il patrimonio di edilizia residenziale pubblica è l\'ancoraggio naturale: grandi coperture in gestione unica, sopra i nuclei più esposti alla povertà energetica.',
         p:'Ente gestore ERP e Comune, con gli assegnatari come membri consumatori'},
  pub:  {n:'CER a guida pubblica', col:'#58a6ff',
         d:'Scuole, uffici e impianti sportivi comunali fanno da produttore di avvio: nessuna negoziazione con privati, tempi di attivazione brevi.',
         p:'Comune di Napoli come promotore e produttore, cittadini e imprese come membri'},
  ind:  {n:'CER produttiva', col:'#e3b341',
         d:'Le grandi coperture produttive generano un surplus ampiamente superiore ai consumi delle imprese: energia disponibile per la condivisione solidale.',
         p:'Partenariato pubblico-privato fra Comune e imprese insediate'},
  mista:{n:'CER mista', col:'#a3e635',
         d:'Due categorie di copertura pesano in modo comparabile: la configurazione nasce dall\'accordo fra soggetti diversi, con governance condivisa.',
         p:'Più promotori in accordo di programma'},
  res:  {n:'CER diffusa residenziale', col:'#c084fc',
         d:'Non esiste un grande produttore unico: il potenziale è frammentato sui tetti dell\'edilizia privata e va aggregato condominio per condominio.',
         p:'Condomini e amministratori, con ESCo o sportello energia comunale come aggregatore'},
  na:   {n:'Non classificata', col:'#8b93a8', d:'Potenziale fotovoltaico non rilevato.', p:'—'},
};

// q = {erp, pub, ind, res} in MWh · popTot/popV per la qualificazione solidale
function cerTipologia(q, popTot, popV){
  const tot = (q.erp||0)+(q.pub||0)+(q.ind||0)+(q.res||0);
  if(!tot) return {...CER_TIPI.na, key:'na', solid:false, shareNR:0, mix:q};
  const nonres = (q.erp||0)+(q.pub||0)+(q.ind||0);
  const shareNR = nonres/tot*100;
  const vulnPct = popTot>0 ? popV/popTot*100 : 0;
  const solid = vulnPct >= 10;          // rilevanza sociale che giustifica la finalità solidale
  let key;
  if(shareNR < 6 || nonres === 0){
    key = 'res';                        // nessun ancoraggio: configurazione diffusa
  } else {
    const ord = [['erp',q.erp||0], ['pub',q.pub||0], ['ind',q.ind||0]].sort((a,b)=>b[1]-a[1]);
    key = (ord[1][1] >= 0.6*ord[0][1]) ? 'mista' : ord[0][0];
    if(key==='mista'){
      const et = {erp:'ERP', pub:'pubblico', ind:'produttivo'};
      var mistaLbl = `CER mista ${et[ord[0][0]]}–${et[ord[1][0]]}`;
    }
  }
  const t = CER_TIPI[key];
  const nome = (key==='mista' ? mistaLbl : t.n) + (solid && key!=='erp' ? ' a finalità solidale' : '');
  return {...t, key, n:nome, solid, shareNR, vulnPct, mix:q};
}

// Compatibilità con le viste esistenti (sidebar, tabella, mappa "tipo di comunità")
function cerConfig(c){
  return cerTipologia({erp:c.fv_erp_mwh, pub:c.fv_pub_mwh, ind:c.fv_ind_mwh, res:c.fv_res_mwh},
                      c.pop_tot, cabPopVuln(c)).n;
}
function cerTipoOf(c){
  return cerTipologia({erp:c.fv_erp_mwh, pub:c.fv_pub_mwh, ind:c.fv_ind_mwh, res:c.fv_res_mwh},
                      c.pop_tot, cabPopVuln(c));
}
function cerDesc(c){ const t = cerTipoOf(c); return t.d + ' <em>Promotori: ' + t.p + '.</em>'; }
const CER_COLORS = new Proxy({}, { get: (_, k) => {
  const s = String(k);
  if(s.includes('ERP')) return CER_TIPI.erp.col;
  if(s.includes('pubblica')) return CER_TIPI.pub.col;
  if(s.includes('produttiva')) return CER_TIPI.ind.col;
  if(s.includes('mista')) return CER_TIPI.mista.col;
  if(s.includes('diffusa')) return CER_TIPI.res.col;
  return CER_TIPI.na.col;
}});
function feasib(c){
  const t = cabTHR(c);
  const best = Math.max(t.cov_erp||0, t.cov_pub||0, t.cov_ind||0);
  if(best>=80) return {cls:'feas-hi', lbl:'Alta fattibilità', color:'#22c55e'};
  if(best>=40) return {cls:'feas-md', lbl:'Fattibilità media', color:'#fbbf24'};
  return {cls:'feas-lo', lbl:'Bassa fattibilità', color:'#ef4444'};
}

// ---------- Basemap: satellite (default, come SSD-CER v5) + scuro + stradale ----------
// showNonIdonee: sulla mappa città i perimetri delle aree non idonee (PAI) partono attivi,
// sulla mappa sezioni no (lì il blocco è già comunicato dal tratteggio rosso).
let OVERLAY = null;   // { idonee: FeatureCollection, non_idonee: FeatureCollection } — perimetri PAI
function addBaseLayers(m, showNonIdonee){
  const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    {attribution:'Tiles © Esri', maxZoom:19});
  const dark = L.layerGroup([
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {subdomains:'abcd', maxZoom:19}),
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png', {subdomains:'abcd', maxZoom:19, pane:'shadowPane'}),
  ]);
  const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {attribution:'© OpenStreetMap', maxZoom:19});
  sat.addTo(m);
  const ctl = L.control.layers({'🛰 Satellite':sat, '🌑 Scuro':dark, '🗺 Stradale':osm}, {}, {position:'topleft'}).addTo(m);
  if(OVERLAY){
    m._pai = {};   // riferimenti per il controllo programmatico (percorso guidato)
    const mk = (fc, color, name, key, on) => {
      if(!fc || !fc.features || !fc.features.length) return;
      // perimetri PAI leggeri: devono contestualizzare, non coprire il dato tematico
      const lyr = L.geoJSON(fc, {interactive:false,
        style:{color, weight:0.9, opacity:.55, dashArray:'5 5', fillColor:color, fillOpacity:.07}});
      ctl.addOverlay(lyr, name);
      m._pai[key] = lyr;
      if(on) lyr.addTo(m);
    };
    mk(OVERLAY.idonee,     '#22c55e', '✅ Aree idonee (PAI/GSE)', 'idonee', false);
    mk(OVERLAY.non_idonee, '#ef4444', '🚫 Aree non idonee (PAI/GSE)', 'non_idonee', !!showNonIdonee);
  }
  return ctl;
}
// accende/spegne un overlay PAI su una mappa (usato dal percorso guidato)
function setPai(m, key, on){
  const lyr = m && m._pai && m._pai[key];
  if(!lyr) return;
  if(on && !m.hasLayer(lyr)) lyr.addTo(m);
  if(!on && m.hasLayer(lyr)) m.removeLayer(lyr);
}
const KWH_PER_KWP = () => (DATA && DATA.meta && DATA.meta.kwh_per_kwp) || 1400;
const kwpFromMwh = mwh => (mwh*1000)/KWH_PER_KWP();
const fmtEnergy = mwh => mwh>=1000 ? (mwh/1000).toFixed(2)+' GWh/a' : fmt1(mwh)+' MWh/a';
let napoliMap = null;     // mappa home Napoli con cabine
let napoliLayer = null;
let napoliColorMode = 'priorita';
// Granularità mappa città: 'cab' = cabine primarie · 'sez' = tavola per sezione censuaria
let napoliGranularity = 'cab';
// Consumo procapite in kWh/anno (default 2.441 da workflow GIS)
const params = { cons_kwh: 2441 };
// Range IVSM_100 per filtro domanda energetica
const ivsmRange = { lo: 60, hi: 100 };

const fmt = n => Number(n||0).toLocaleString('it-IT');
const fmt1 = n => Number(n||0).toLocaleString('it-IT', {minimumFractionDigits:1, maximumFractionDigits:1});
const fmt2 = n => Number(n||0).toLocaleString('it-IT', {minimumFractionDigits:2, maximumFractionDigits:2});

// ---------- Impronte degli edifici (footprint) ----------
// FOOTPRINTS = {scale, types, b:[[tipo, sez, area_m2, [lon0,lat0,dlon,dlat,...]], ...]}
// Delta-encoding di interi a 1e-5° (~1 m): decodifica su richiesta, per tipo/sezione.
let FOOTPRINTS = null;
let showBuildings = false;          // toggle 🏢 Edifici sulla mappa cabina
let cityBuildings = false;          // idem sulla mappa città (solo da zoom ravvicinato)
let bldLayer = null, cityBldLayer = null;
const BLD_ZOOM_MIN = 14;            // sotto questo zoom i footprint sono pixel indistinguibili
const BLD_COLORS = { r:'#8fa3bf', e:'#2db885', p:'#58a6ff', i:'#e3b341' };
const BLD_LABELS = { r:'Residenziale', e:'ERP', p:'Pubblico', i:'Industriale' };
let _bldBySez = null;
function bldBySez(){
  if(_bldBySez) return _bldBySez;
  _bldBySez = {};
  if(FOOTPRINTS) FOOTPRINTS.b.forEach(b=>{ (_bldBySez[b[1]] = _bldBySez[b[1]] || []).push(b); });
  return _bldBySez;
}
function decodeRing(enc){
  const S = (FOOTPRINTS && FOOTPRINTS.scale) || 100000;
  const pts = [];
  let x = enc[0], y = enc[1];
  pts.push([y/S, x/S]);                       // Leaflet vuole [lat, lon]
  for(let k=2; k<enc.length; k+=2){
    x += enc[k]; y += enc[k+1];
    pts.push([y/S, x/S]);
  }
  return pts;
}

// ---------- Loading ----------
// aree_overlay.json e footprints.json sono opzionali: se assenti si prosegue senza.
fetch('dataset.json').then(r=>r.json())
  .then(d=>{ DATA = d;
    return fetch('aree_overlay.json').then(r=>r.ok?r.json():null).catch(()=>null); })
  .then(o=>{ OVERLAY = o;
    return fetch('footprints.json').then(r=>r.ok?r.json():null).catch(()=>null); })
  .then(f=>{ FOOTPRINTS = f; initApp(); });

// ---------- ⬇️ Scarica / condividi l'SSD ----------
// Copia fedele del documento catturata prima che l'app modifichi il DOM:
// permette di riscaricare e inviare l'SSD completo (dati inclusi) da qualsiasi copia.
// La copia del documento si costruisce solo quando serve: serializzare 9 MB di DOM
// all'avvio ritardava di secondi la comparsa della pagina.
let __SNAPSHOT = null;
function snapshotHtml(){ /* differito: vedi downloadSSD */ }
function downloadSSD(){
  const html = __SNAPSHOT || ('<!DOCTYPE html>\n' + document.documentElement.outerHTML);
  const mb = (html.length/1024/1024).toFixed(1);
  const blob = new Blob([html], {type:'text/html;charset=utf-8'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'SSD-CER-Napoli.html';
  document.body.appendChild(a);
  a.click();
  setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); }, 3000);
  const t = document.getElementById('dl-toast');
  if(t){
    t.innerHTML = `⬇️ <strong>SSD-CER-Napoli.html</strong> (${mb} MB) salvato nei Download.<br>
      <span style="color:var(--text-muted);font-size:11.5px">È un file unico e autonomo: puoi allegarlo a un'email o caricarlo su Drive — chi lo riceve lo apre con un doppio click, senza installare nulla.</span>`;
    t.classList.add('visible');
    setTimeout(()=>t.classList.remove('visible'), 9000);
  }
}

// I campi a zero non vengono scritti nel dataset (vedi ottimizza_dataset.py):
// qui vengono ripristinati, così il resto del codice non deve preoccuparsene.
const CAMPI_NUM = ['pop','pop_vuln','pop_nonvuln','fam','erp_b','sup_erp','erp_pct','fv_mwh',
  'fv_raw','pub_b','sup_pub','fv_pub','ind_b','sup_ind','fv_ind','res_b','sup_res','fv_res',
  'fv_tot','cons_tot','cons_vuln','cons_nonvuln','fv_to_vuln','fv_to_nonvuln','fv_residual',
  'cov_vuln','cov_tot','ivsm','ivsm_raw','priorita','edu_low','old70','emp_vuln',
  'pv60','pv70','pv80','cv60','cv70','cv80','dens','area'];
function normalizzaSezioni(){
  for(const s of DATA.sezioni){
    for(const k of CAMPI_NUM) if(s[k] === undefined) s[k] = 0;
    if(s.ivsm_class === undefined) s.ivsm_class = '';
    if(s.cer_class  === undefined) s.cer_class  = '';
    if(s.nrm){
      const n = s.nrm;
      if(n.i === undefined) n.i = 0;
      if(n.o === undefined) n.o = 0;
      if(n.n === undefined) n.n = 0;
      if(n.ns === undefined) n.ns = 0;
    }
  }
}

function initApp(){
  normalizzaSezioni();
  // il pulsante si sblocca solo a dati pronti: finché carica, lo stato è visibile
  const btn = document.getElementById('btn-launch');
  if(btn){ btn.disabled = false; btn.style.opacity = '1'; btn.textContent = 'Apri analisi'; }
  // KPI città
  const totPop = DATA.cabine.reduce((a,c)=>a+c.pop_tot,0);
  const totVuln = DATA.cabine.reduce((a,c)=>a+c.pop_vuln,0);
  const totCons = DATA.cabine.reduce((a,c)=>a+(c.cons_tot_mwh||0),0); // MWh/a
  const totFvErp = DATA.cabine.reduce((a,c)=>a+(c.fv_erp_mwh||0),0);  // MWh/a
  const totFvPub = DATA.cabine.reduce((a,c)=>a+(c.fv_pub_mwh||0),0);
  const totFvInd = DATA.cabine.reduce((a,c)=>a+(c.fv_ind_mwh||0),0);
  const totFv = totFvErp + totFvPub + totFvInd;
  const totFvVuln = DATA.cabine.reduce((a,c)=>a+(c.fv_to_vuln_mwh||0),0);
  // Domanda vulnerabili totale (MWh/a)
  const demandVulnMwh = totVuln * params.cons_kwh / 1000;
  const covVulnGlobal = demandVulnMwh>0 ? (totFvVuln/demandVulnMwh*100) : 0;

  document.getElementById('kpi-pop').textContent = fmt(totPop);
  document.getElementById('kpi-vuln').textContent = fmt(totVuln);
  document.getElementById('kpi-vuln-sub').textContent = (totVuln/totPop*100).toFixed(1)+'% del totale';
  document.getElementById('kpi-cons').textContent = (totCons/1000).toFixed(1)+' GWh';
  document.getElementById('kpi-cons-sub').textContent = `${fmt(Math.round(totCons))} MWh/anno (stima)`;
  document.getElementById('kpi-fv').textContent = (totFv/1000).toFixed(1)+' GWh';
  document.getElementById('kpi-fv-sub').textContent = `ERP ${(totFvErp/1000).toFixed(2)} · Pubbl. ${(totFvPub/1000).toFixed(1)} · Ind. ${(totFvInd/1000).toFixed(1)} GWh/a`;
  document.getElementById('header-context').textContent = DATA.cabine.length+' Cabine Primarie';

  buildSidebar();
  buildTable();
  buildAlertHighIvsm();
  buildNormChip();
  // I pannelli pesanti (aggregati su 5.724 sezioni e 35.000 edifici) non servono
  // alla prima schermata: si costruiscono dopo il primo disegno, così l'app appare subito.
  const differito = fn => (window.requestIdleCallback || (f=>setTimeout(f,200)))(fn);
  differito(()=>{ buildNormBand(); buildBestOpportunities(); buildMunPanel(); });

  // calcolo iniziale domanda + posiziona track slider
  updateIvsmRange();
  setupDualSliderStacking();
}

// ---------- Quadro normativo di sintesi (home): il territorio secondo il DM 21/06/2024 ----------
function buildNormBand(){
  const el = document.getElementById('norm-band');
  if(!el) return;
  if(!hasNorm()){ el.style.display='none'; return; }
  el.style.display='block';
  // aggregati città pesati per superficie di sezione
  let aI=0, aO=0, aN=0, aTot=0, ferW=0, ferA=0, nBlk=0, nFac=0;
  DATA.sezioni.forEach(s=>{
    if(!s.nrm) return;
    const a = s.area||0;
    aI += a*(s.nrm.i||0)/100; aO += a*(s.nrm.o||0)/100; aN += a*(s.nrm.n||0)/100; aTot += a;
    const fer = normFer(s);
    if(fer!==null){ ferW += fer*a; ferA += a; }
    const st = normStatus(s).code;
    if(st==='blk') nBlk++; else if(st==='fac') nFac++;
  });
  const pI = aTot>0? aI/aTot*100:0, pO = aTot>0? aO/aTot*100:0, pN = aTot>0? aN/aTot*100:0;
  const ferCity = ferA>0 ? ferW/ferA : null;
  const totBlk = DATA.cabine.reduce((a,c)=>a+cabNorm(c).fvBlk.tot,0);
  const totFv  = DATA.cabine.reduce((a,c)=>a+cabNorm(c).fvBlk.tot+cabNorm(c).fvOk.tot,0);
  const nGhost = DATA.sezioni.filter(s=>s.empty).length;
  const stat = (lbl,val,col,sub) => `
    <div style="min-width:130px">
      <div style="font-size:10.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--text-faint)">${lbl}</div>
      <div style="font-family:var(--font-display);font-size:23px;color:${col};font-variant-numeric:tabular-nums;line-height:1.15">${val}</div>
      <div style="font-size:10.5px;color:var(--text-muted)">${sub}</div>
    </div>`;
  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px">
      <div style="font-size:12px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--text-muted)">⚖️ Quadro normativo — Decreto Aree Idonee (DM 21/06/2024) · Piattaforma GSE</div>
      <button class="toolbar-btn" onclick="openMetodo()" style="font-size:11px">ℹ️ Come leggere l'SSD</button>
    </div>
    <div style="display:flex;height:14px;border-radius:99px;overflow:hidden;background:var(--surface3);margin-bottom:6px" title="Composizione del territorio abitato">
      <div style="width:${pI.toFixed(2)}%;background:${NORM_COLORS.fac}" title="Idonee ${fmt1(pI)}%"></div>
      <div style="width:${pO.toFixed(2)}%;background:${NORM_COLORS.ord}" title="Ordinarie ${fmt1(pO)}%"></div>
      <div style="width:${pN.toFixed(2)}%;background:${NORM_COLORS.blk}" title="Non idonee ${fmt1(pN)}%"></div>
    </div>
    <div style="display:flex;gap:16px;font-size:11px;color:var(--text-muted);flex-wrap:wrap;margin-bottom:14px">
      <span><span style="color:${NORM_COLORS.fac}">■</span> Aree idonee ${fmt1(pI)}% — iter semplificato</span>
      <span><span style="color:${NORM_COLORS.ord}">■</span> Ordinarie ${fmt1(pO)}% — iter standard</span>
      <span><span style="color:${NORM_COLORS.blk}">■</span> Non idonee ${fmt1(pN)}% — bloccanti per l'impianto</span>
    </div>
    <div style="display:flex;gap:26px;flex-wrap:wrap">
      ${stat('Sezioni bloccate', fmt(nBlk), '#f87171', 'prevalenza non idonea')}
      ${stat('Sezioni facilitate', fmt(nFac), '#22c55e', 'prevalenza idonea')}
      ${stat('FV bloccato', totFv>0?fmt1(totBlk/totFv*100)+'%':'—', '#fbbf24', fmtEnergy(totBlk)+' non attivabili')}
      ${stat('FER_100 medio città', ferCity!==null?fmt1(ferCity):'—', '#facc15', 'idoneità tecnico-normativa')}
    </div>
    ${nGhost?`<div style="font-size:10.5px;color:var(--text-faint);margin-top:10px">Il mosaico comprende anche ${fmt(nGhost)} sezioni non abitate (tessere tenui): non contano per la domanda sociale, ma restano valutabili come siti impianto.</div>`:''}`;
}

// Soglia dell'intersezione: 75° percentile della producibilità fra le sole sezioni
// idonee (quarto superiore). La distribuzione di S_s è fortemente asimmetrica —
// con la mediana la selezione perderebbe il significato di "alta produzione".
let _crossThr = null;
function crossThreshold(){
  if(_crossThr !== null) return _crossThr;
  const v = DATA.sezioni.filter(s=>normStatus(s).code==='fac' && normPv(s)!==null)
                        .map(s=>normPv(s)).sort((a,b)=>a-b);
  _crossThr = v.length ? v[Math.floor(v.length*0.75)] : 50;
  return _crossThr;
}
function crossSections(){
  const t = crossThreshold();
  return DATA.sezioni.filter(s=>normStatus(s).code==='fac' && normPv(s)!==null && normPv(s)>=t)
                     .sort((a,b)=>normPv(b)-normPv(a));
}

// ---------- 🎯 Le aree prioritarie della città (idonee × producibilità) ----------
function buildBestOpportunities(){
  const el = document.getElementById('best-panel');
  if(!el) return;
  if(!hasFer()){ el.style.display='none'; return; }
  el.style.display='block';
  const cand = DATA.sezioni
    .filter(s=>normStatus(s).code==='fac' && normPv(s)!==null)
    .sort((a,b)=>normPv(b)-normPv(a));
  const top = cand.slice(0,10);
  const fvT = s => s.fv_tot || (s.fv_mwh||0)+(s.fv_pub||0)+(s.fv_ind||0);
  const totMwh = cand.reduce((a,s)=>a+fvT(s),0);
  const rows = top.map((s,i)=>{
    const pv = normPv(s), fer = normFer(s), ft = fvT(s);
    const vuln = sezPV(s);
    return `<tr onclick="openCabina('${s.cab}');setTimeout(()=>zoomSez('${s.id}'),700)">
      <td style="font-weight:700;color:#facc15">${i+1}</td>
      <td><span class="sez-id">${shortSez(s.id)}</span></td>
      <td><span class="cabina-code" style="font-size:10.5px">${String(s.cab).replace('AC001E00','')}</span></td>
      <td class="num"><span style="display:inline-block;width:52px;height:6px;border-radius:99px;background:var(--surface3);vertical-align:middle;margin-right:6px;overflow:hidden"><span style="display:block;height:100%;width:${Math.min(100,pv)}%;background:linear-gradient(90deg,#65a30d,#facc15)"></span></span>${fmt1(pv)}</td>
      <td class="num">${ft>0?fmt1(ft)+' MWh':'<span style="color:var(--text-faint)">tetti privati</span>'}</td>
      <td class="num" style="color:#facc15;font-weight:600">${fer!==null?fmt1(fer):'—'}</td>
      <td class="num">${vuln>0?`<span style="color:#fb923c">👥 ${fmt(vuln)}</span>`:'<span style="color:var(--text-faint)">—</span>'}</td>
    </tr>`;
  }).join('');
  el.innerHTML = `
    <div class="section-title">🎯 Le migliori occasioni di Napoli — aree idonee con più energia producibile</div>
    <div class="table-wrap" style="border-top:3px solid #facc15">
      <div class="table-header">
        <div>
          <div class="table-title">Sezioni <span style="color:#22c55e">✅ idonee</span> ordinate per energia producibile</div>
          <div class="table-sub">Doppio requisito soddisfatto: <strong>si può installare senza ostacoli</strong> (procedura semplificata) <strong>e si produce molto</strong>. Click su una riga per entrare nella cabina.</div>
        </div>
        <div style="text-align:right">
          <div style="font-family:var(--font-display);font-size:24px;color:#22c55e;line-height:1">${fmt(cand.length)}</div>
          <div style="font-size:10.5px;color:var(--text-muted)">sezioni idonee in città</div>
        </div>
      </div>
      <table>
        <thead><tr><th style="width:34px">#</th><th>Sezione</th><th>Cabina</th><th class="num">Energia producibile (0-100)</th><th class="num">Tetti censiti</th><th class="num">🏆 FER</th><th class="num">Vulnerabili</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="7" style="text-align:center;padding:14px;color:var(--text-muted)">Nessuna sezione in area idonea</td></tr>'}</tbody>
      </table>
    </div>
    <div style="font-size:11px;color:var(--text-faint);padding:8px 4px 0;line-height:1.5">Le ${fmt(cand.length)} sezioni idonee della città totalizzano ${fmt(Math.round(totMwh))} MWh/a sui soli tetti censiti (ERP, pubblici, industriali). Dove la colonna dice “tetti privati”, la produzione stimata dal modello solare ricade su edilizia residenziale privata.</div>`;
}

// Chip di stato del layer normativo (home Napoli)
function buildNormChip(){
  const el = document.getElementById('norm-status-chip');
  if(!el) return;
  if(hasNorm()){
    const src = (DATA.meta && DATA.meta.norm_source) || 'Piattaforma Aree Idonee (GSE)';
    const demo = /demo/i.test(src);
    const totBlk = DATA.cabine.reduce((a,c)=>a+cabNorm(c).fvBlk.tot,0);
    const totFv  = DATA.cabine.reduce((a,c)=>a+cabNorm(c).fvBlk.tot+cabNorm(c).fvOk.tot,0);
    el.style.display='inline-flex';
    el.innerHTML = `⚖️ Layer aree idonee <strong style="color:${demo?'#fbbf24':'#22c55e'}">&nbsp;${demo?'DEMO SINTETICO':'attivo'}</strong>&nbsp;${demo?'':'· '+src+' '}· FV bloccato: <strong>&nbsp;${totFv>0?(totBlk/totFv*100).toFixed(1):0}%</strong>`;
    el.style.borderColor = demo ? 'rgba(245,158,11,.5)' : 'rgba(34,197,94,.4)';
  } else {
    el.style.display='inline-flex';
    el.innerHTML = `⚖️ Layer aree idonee/non idonee (DM 21/06/2024): <strong style="color:var(--text-muted)">&nbsp;non ancora caricato</strong>&nbsp;— usa merge_aree_idonee.py`;
    el.style.borderColor = 'var(--border-strong)';
  }
}

// Z-index dinamico sui due slider del dual-range (vedi index.html commento).
function setupDualSliderStacking(){
  const lo = document.getElementById('ivsm-range-lo');
  const hi = document.getElementById('ivsm-range-hi');
  if(!lo || !hi) return;
  const container = lo.parentElement;
  if(!container) return;
  const pick = (clientX) => {
    const r = container.getBoundingClientRect();
    if(r.width <= 0) return;
    const pct = ((clientX - r.left) / r.width) * 100;
    const loV = parseFloat(lo.value);
    const hiV = parseFloat(hi.value);
    const dLo = Math.abs(pct - loV);
    const dHi = Math.abs(pct - hiV);
    if(dLo <= dHi){
      lo.classList.add('on-top'); hi.classList.remove('on-top');
    } else {
      hi.classList.add('on-top'); lo.classList.remove('on-top');
    }
  };
  container.addEventListener('mousemove', (e) => pick(e.clientX));
  container.addEventListener('pointermove', (e) => pick(e.clientX));
  container.addEventListener('touchstart', (e) => { if(e.touches[0]) pick(e.touches[0].clientX); }, {passive:true});
}

function buildAlertHighIvsm(){
  const top3 = [...DATA.cabine].sort((a,b)=>cabPopVuln(b)-cabPopVuln(a)).slice(0,3);
  const alert = document.getElementById('alert-priorita');
  if(alert){
    const totV = DATA.cabine.reduce((a,c)=>a+cabPopVuln(c),0);
    const top3V = top3.reduce((a,c)=>a+cabPopVuln(c),0);
    const txt = top3.map(c=>`<strong style="color:var(--warning)">${c.id}</strong> (${fmt(cabPopVuln(c))} vuln.)`).join(', ');
    alert.children[1].innerHTML = `<strong>Priorità di intervento C1 — classificazione per numero di residenti vulnerabili (IVSM>${THR}, Jenks)</strong>: ${txt} — insieme concentrano il ${totV>0?(top3V/totV*100).toFixed(1):0}% dei vulnerabili della città. Clicca sulla mappa o sulla lista per il drill-down delle sezioni.`;
  }
}

// ---------- Schermata comune ----------
function setComune(n){ document.getElementById('comune-select').value = n; }
function openComune(){
  const c = document.getElementById('comune-select').value;
  document.getElementById('screen-comune').style.display='none';
  document.getElementById('screen-app').style.display='block';
  document.getElementById('header-comune-name').textContent = c;
  document.getElementById('city-name-main').textContent = c;
  if(c !== 'Napoli'){
    document.getElementById('city-desc-main').textContent = 'Dati di dettaglio disponibili al momento solo per Napoli. Il dataset GIS sezione-cabina è in corso di estensione agli altri comuni della Città Metropolitana.';
  }
  // Inizializza la mappa Napoli dopo che il container è visibile
  setTimeout(()=>buildNapoliMap(), 100);
}
function backToComuni(){
  document.getElementById('screen-app').style.display='none';
  document.getElementById('screen-comune').style.display='flex';
  document.getElementById('view-comune').style.display='block';
  document.getElementById('view-cabina').style.display='none';
  activeCabina = null;
  if(map){ map.remove(); map=null; }
  if(napoliMap){ napoliMap.remove(); napoliMap=null; }
}

// ---------- Sidebar cabine ----------
function getVulnLabel(pct){
  // mantenuta per i badge a livello sezione (basati su % vuln nella sezione)
  if(pct>=20) return {cls:'badge-red', label:'Alta', cat:'alta'};
  if(pct>=10) return {cls:'badge-orange', label:'Media', cat:'media'};
  if(pct>=5)  return {cls:'badge-yellow', label:'Bassa', cat:'bassa'};
  return {cls:'badge-gray', label:'Minima', cat:'bassa'};
}
// Classificatore IVSM medio (usato solo per colorare il valore IVSM nelle tabelle)
function getIvsmLabel(ivsm){
  if(ivsm>=45) return {cls:'badge-red', label:'Alta', cat:'alta', color:'#ef4444'};
  if(ivsm>=40) return {cls:'badge-orange', label:'Media', cat:'media', color:'#fb923c'};
  if(ivsm>=35) return {cls:'badge-yellow', label:'Bassa', cat:'bassa', color:'#fbbf24'};
  return {cls:'badge-gray', label:'Minima', cat:'bassa', color:'#8b93a8'};
}

// ---------- Priorità di intervento per POP. VULNERABILE (paper, Sez. 3.4) ----------
// Le cabine sono classificate in 3 tier (C1/C2/C3) con Jenks Natural Breaks sul numero
// assoluto di residenti vulnerabili alla soglia IVSM corrente — non sull'IVSM medio.
const cabPopVuln = c => { const t = cabTHR(c); return t.pop_vuln !== undefined ? t.pop_vuln : c.pop_vuln; };
let _prioBreaks = {};   // cache per soglia THR
// Jenks a 3 classi con numerosità minima di classe: con 12 unità fortemente
// asimmetriche il Jenks libero degenera (classi da 2 elementi isolano solo gli
// outlier). Il vincolo minSize = n/4 produce tier bilanciati e utilizzabili in
// pianificazione, coerenti con la classificazione a tre livelli del paper.
function jenks3(values){
  const v = [...values].sort((a,b)=>a-b), n = v.length;
  const minSize = Math.max(2, Math.round(n/4));
  const sdcm = arr => { if(!arr.length) return 0; const m = arr.reduce((a,b)=>a+b,0)/arr.length;
                        return arr.reduce((a,b)=>a+(b-m)*(b-m), 0); };
  let best = null;
  for(let i=minSize; i<=n-2*minSize; i++) for(let j=i+minSize; j<=n-minSize; j++){
    const s = sdcm(v.slice(0,i)) + sdcm(v.slice(i,j)) + sdcm(v.slice(j));
    if(!best || s < best.s) best = {s, b1: v[i-1], b2: v[j-1]};
  }
  if(!best){   // fallback per pochissime unità
    best = {s:0, b1: v[Math.floor(n/3)] , b2: v[Math.floor(2*n/3)]};
  }
  const tv = sdcm(v);
  best.gvf = tv>0 ? 1 - best.s/tv : 1;
  return best;   // classe bassa ≤ b1 < media ≤ b2 < alta
}
function prioBreaks(){
  const key = String(THR);
  if(!_prioBreaks[key]) _prioBreaks[key] = jenks3(DATA.cabine.map(cabPopVuln));
  return _prioBreaks[key];
}
function cabPrio(c){
  const b = prioBreaks(), pv = cabPopVuln(c);
  if(pv > b.b2) return {tier:'C1', label:'Alta',  cls:'badge-red',    color:'#ef4444', cat:'alta'};
  if(pv > b.b1) return {tier:'C2', label:'Media', cls:'badge-orange', color:'#fb923c', cat:'media'};
  return {tier:'C3', label:'Bassa', cls:'badge-gray', color:'#8b93a8', cat:'bassa'};
}
function buildSidebar(){
  const list = document.getElementById('cabine-list');
  list.innerHTML='';
  // ordinamento per numero di vulnerabili alla soglia corrente (ranking del paper)
  [...DATA.cabine].sort((a,b)=>cabPopVuln(b)-cabPopVuln(a)).forEach(c=>{
    const v = cabPrio(c);
    if(currentFilter!=='all' && v.cat!==currentFilter) return;
    if(currentSearch && !c.id.toLowerCase().includes(currentSearch)) return;
    const div = document.createElement('div');
    div.className = 'cabina-item' + (activeCabina===c.id?' active':'');
    div.onclick = ()=>openCabina(c.id);
    const cf = cerConfig(c), fe = feasib(c);
    div.innerHTML = `
      <div class="cabina-item-top">
        <span class="cabina-code">${c.id}</span>
        <span class="badge ${v.cls}">${v.tier} · ${v.label}</span>
      </div>
      <div class="cabina-item-meta">
        <span>${fmt(cabPopVuln(c))} vuln.</span>
        <span>IVSM ${c.ivsm_avg}</span>
        <span>${fmt(c.sez_count)} sez.</span>
      </div>
      <div style="display:flex;gap:5px;margin-top:5px;flex-wrap:wrap;align-items:center">
        <span style="font-size:10px;padding:1px 7px;border-radius:99px;background:var(--surface3);color:${CER_COLORS[cf]};border:1px solid ${CER_COLORS[cf]}44">${cf.replace('CER ','')}</span>
        <span style="font-size:10px;color:${fe.color}">● ${fe.lbl.replace(' fattibilità','').replace('Fattibilità ','')}</span>
      </div>`;
    list.appendChild(div);
  });
}
function filterCabine(v){ currentSearch=v.toLowerCase(); buildSidebar(); }
function setFilter(f,el){
  currentFilter = f;
  document.querySelectorAll('.sidebar-filters .filter-chip').forEach(c=>c.classList.remove('active'));
  el.classList.add('active');
  buildSidebar();
}

// ---------- Tabella riepilogo cabine (home Napoli) ----------
function buildTable(){
  const tb = document.getElementById('table-body');
  tb.innerHTML='';
  // Ranking del paper: cabine ordinate per numero assoluto di residenti vulnerabili
  const sorted = [...DATA.cabine].sort((a,b)=>cabPopVuln(b)-cabPopVuln(a));
  const showFer = hasFer();
  const th = document.getElementById('th-fer');
  if(th) th.style.display = showFer ? '' : 'none';
  sorted.forEach(c=>{
    const v = cabPrio(c);
    const iv = getIvsmLabel(c.ivsm_avg);
    const tr = document.createElement('tr');
    tr.onclick = ()=>openCabina(c.id);
    const ferAvg = showFer ? cabNorm(c).ferAvg : null;
    tr.innerHTML = `
      <td><span class="cabina-code">${c.id}</span></td>
      <td class="num">${fmt(c.pop_tot)}</td>
      <td class="num" style="font-weight:700;color:${v.color}">${fmt(cabPopVuln(c))}</td>
      <td class="num">${c.pop_tot>0?(cabPopVuln(c)/c.pop_tot*100).toFixed(1):0}%</td>
      <td class="num">${fmt(c.sez_count)}</td>
      <td class="num" style="color:${iv.color}">${c.ivsm_avg}</td>
      <td class="num">${fmt(Math.round(c.fv_tot_mwh||c.fv_erp_mwh))}</td>
      ${showFer?`<td class="num" style="color:#facc15;font-weight:600">${ferAvg!==null?fmt1(ferAvg):'—'}</td>`:''}
      <td><span style="font-size:11px;color:${CER_COLORS[cerConfig(c)]}">${cerConfig(c)}</span></td>
      <td><span class="badge ${v.cls}">${v.tier} · ${v.label}</span></td>`;
    tb.appendChild(tr);
  });
}

// ---------- MAPPA NAPOLI (home) — cabine colorate per priorità ----------
function buildNapoliMap(){
  const containerEl = document.getElementById('napoli-map');
  if(!containerEl) return;
  if(napoliMap){ napoliMap.remove(); napoliMap=null; }

  napoliMap = L.map('napoli-map', {zoomControl:true, attributionControl:false}).setView([40.85,14.27], 11);
  addBaseLayers(napoliMap, true);

  drawNapoli();

  // Legenda
  const legend = L.control({position:'bottomright'});
  legend.onAdd = () => {
    const div = L.DomUtil.create('div','legend');
    updateNapoliLegend(div);
    legend._div = div;
    return div;
  };
  legend.addTo(napoliMap);
  napoliMap._legend = legend;
  // i footprint si ridisegnano seguendo l'inquadratura
  napoliMap.on('moveend zoomend', ()=>{ if(cityBuildings) drawCityBuildings(); });
  setCityStep(cityStep, document.querySelector(`[data-citystep="${cityStep}"]`));
}

function getNapoliCabinaColor(c, mode){
  if(mode==='perim') return '#3b82f6';   // Step 1: perimetri, tutte uguali
  if(mode==='priorita'){
    return cabPrio(c).color;   // tier C1/C2/C3 per numero di vulnerabili (Jenks)
  }
  if(mode==='vuln'){
    // % vuln 0..15 → giallo→rosso
    const pct = c.vuln_pct||0;
    if(pct>=12) return '#ef4444';
    if(pct>=10) return '#f97316';
    if(pct>=8)  return '#fb923c';
    if(pct>=6)  return '#fbbf24';
    return '#8b93a8';
  }
  if(mode==='fv'){
    const maxFv = Math.max(...DATA.cabine.map(x=>x.fv_tot_mwh||x.fv_erp_mwh||0), 1);
    const t = (c.fv_tot_mwh||c.fv_erp_mwh||0)/maxFv;
    if(t>=0.75) return '#22d3ee';
    if(t>=0.5)  return '#06b6d4';
    if(t>=0.25) return '#0e7490';
    if(t>=0.05) return '#155e75';
    return '#1e2535';
  }
  if(mode==='cer'){
    return CER_COLORS[cerConfig(c)] || '#8b93a8';
  }
  if(mode==='norm'){
    // Quota del potenziale FV della cabina ricadente in aree non idonee (bloccata)
    if(!hasNorm()) return NORM_COLORS.na;
    const p = cabNorm(c).pctFvBlk;
    if(p>=40) return '#ef4444';
    if(p>=25) return '#f97316';
    if(p>=10) return '#fbbf24';
    if(p>=2)  return '#84cc16';
    return '#22c55e';
  }
  if(mode==='fer' || mode==='best' || mode==='cross'){
    // FER_100 medio pesato per superficie: idoneità localizzativa tecnico-normativa
    if(!hasFer()) return NORM_COLORS.na;
    const f = cabNorm(c).ferAvg;
    if(f===null) return NORM_COLORS.na;
    return rampColor(COLORS_FER, f/100);
  }
  if(mode==='cov'){
    const cov = c.cov_vuln_pct||0;
    if(cov>=2)   return '#22c55e';
    if(cov>=1)   return '#84cc16';
    if(cov>=0.5) return '#fbbf24';
    if(cov>=0.2) return '#f97316';
    return '#ef4444';
  }
  return '#8b93a8';
}

function drawNapoliCabine(){
  if(!napoliMap) return;
  if(napoliLayer){ napoliMap.removeLayer(napoliLayer); }

  // Costruisci FeatureCollection a partire dalle rings di ogni cabina
  // c.rings = array di poligoni; ogni poligono = array di [lon,lat]
  const features = DATA.cabine.filter(c=>c.rings && c.rings.length).map(c=>{
    // GeoJSON Polygon vs MultiPolygon: se c.rings ha più poligoni esterni → MultiPolygon
    let geometry;
    if(c.rings.length === 1){
      geometry = { type:'Polygon', coordinates:[c.rings[0]] };
    } else {
      geometry = { type:'MultiPolygon', coordinates: c.rings.map(r=>[r]) };
    }
    return { type:'Feature', properties: { ...c }, geometry };
  });

  napoliLayer = L.geoJSON({type:'FeatureCollection',features}, {
    style: f => ({
      fillColor: getNapoliCabinaColor(f.properties, napoliColorMode),
      color: '#fff',
      weight: 1.4,
      fillOpacity: 0.65,
      className: 'napoli-cabina-path'
    }),
    onEachFeature: (f, layer) => {
      const c = f.properties;
      const v = cabPrio(c);
      layer.on('click', ()=>openCabina(c.id));
      const cf = cerConfig(c), fe = feasib(c), t = cabTHR(c);
      const nrm = hasNorm() ? cabNorm(c) : null;
      const ferLine = nrm && nrm.ferAvg!==null ? ` · 🏆 FER ${fmt1(nrm.ferAvg)}` : '';
      const normLine = nrm ? `⚖️ FV in aree non idonee: <strong style="color:${nrm.pctFvBlk>=25?'#ef4444':nrm.pctFvBlk>=10?'#fbbf24':'#22c55e'}">${fmt1(nrm.pctFvBlk)}%</strong> (${fmt(nrm.nBlk)} sez. bloccate)${ferLine}<br>` : '';
      layer.bindTooltip(`
        <div style="font-family:DM Sans;font-size:12px;line-height:1.5">
          <strong>${c.id}</strong> — <span style="color:${v.color}">Priorità ${v.tier} · ${v.label}</span><br>
          IVSM medio: <strong>${c.ivsm_avg}</strong> · Vuln (>${THR}): <strong>${fmt(t.pop_vuln||c.pop_vuln)}</strong><br>
          FV tot: ${fmt(Math.round(c.fv_tot_mwh||0))} MWh/a<br>
          ${normLine}⚡ <strong style="color:${CER_COLORS[cf]}">${cf}</strong> · <span style="color:${fe.color}">● ${fe.lbl}</span><br>
          <em style="color:#8b93a8">Click per drill-down</em>
        </div>`, {sticky:true, className:'leaflet-tooltip-custom'});
      layer.on('mouseover', e=>e.target.setStyle({weight:2.5, fillOpacity:0.85}));
      layer.on('mouseout',  e=>napoliLayer.resetStyle(e.target));
    }
  }).addTo(napoliMap);

  // Etichette codice cabina al centroide
  DATA.cabine.forEach(c=>{
    if(!c.c) return;
    const [lon,lat] = c.c;
    const code = c.id.replace('AC001E00','');
    const ico = L.divIcon({
      className:'napoli-label',
      html:`<div style="font-family:'SF Mono',Menlo,monospace;font-size:10px;font-weight:700;color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.9);background:rgba(14,17,23,.5);padding:2px 5px;border-radius:4px;white-space:nowrap;border:1px solid rgba(255,255,255,.15)">${code}</div>`,
      iconSize:[40,16], iconAnchor:[20,8]
    });
    L.marker([lat,lon], {icon:ico, interactive:false}).addTo(napoliLayer);
  });

  try{ napoliMap.fitBounds(napoliLayer.getBounds(), {padding:[20,20]}); }catch(e){}
  updateNapoliLegend();
}

function updateNapoliLegend(div){
  div = div || (napoliMap && napoliMap._legend && napoliMap._legend._div);
  if(!div) return;
  let rows;
  let title;
  const sezGran = napoliGranularity==='sez';
  if(sezGran && napoliColorMode==='best'){
    div.innerHTML = `<strong>Producibilità nelle aree ammissibili</strong>` +
      COLORS_FV.map((col,i)=>`<div class="legend-row"><span class="legend-swatch" style="background:${col}"></span>${['poca energia','','','','','molta energia'][i]}</div>`).join('') +
      `<div style="border-top:1px solid rgba(255,255,255,.15);margin-top:6px;padding-top:6px"></div>` +
      `<div class="legend-row"><span class="legend-swatch" style="background:transparent;border:1.5px solid #22c55e"></span>✅ area idonea (accesa)</div>` +
      `<div class="legend-row"><span class="legend-swatch" style="background:transparent;border:1.5px solid #ef4444"></span>🚫 area non idonea (esclusa)</div>` +
      `<div class="legend-row"><span class="legend-swatch" style="background:#232936"></span>📋 ordinaria / non idonea (spenta)</div>`;
    return;
  }
  if(sezGran && napoliColorMode==='prio'){
    div.innerHTML = `<strong>🎯 Aree prioritarie per la CER</strong>` +
      `<div class="legend-row"><span class="legend-swatch" style="background:#f97316"></span><strong>coincidenza</strong> — sito ottimale e fragilità</div>` +
      `<div class="legend-row"><span class="legend-swatch" style="background:#facc15"></span>sito ottimale (dove installare)</div>` +
      `<div class="legend-row"><span class="legend-swatch" style="background:#a855f7"></span>IVSM > ${THR} (chi beneficia)</div>` +
      `<div class="legend-row"><span class="legend-swatch" style="background:#232936"></span>fuori sintesi</div>`;
    return;
  }
  if(sezGran && (napoliColorMode==='ambiti' || napoliColorMode==='top10')){
    const top = napoliColorMode==='top10';
    div.innerHTML = `<strong>${top?'🏁 I dieci ambiti prioritari':'🔎 Ambiti di intervento'}</strong>` +
      (top ? `<div class="legend-row"><span class="legend-swatch" style="background:#f97316"></span>primi 10 per vulnerabili servibili</div>
              <div class="legend-row"><span class="legend-swatch" style="background:#3a3320"></span>altri ambiti prioritari</div>`
           : `<div class="legend-row"><span class="legend-swatch" style="background:#facc15"></span>sezioni che compongono un ambito</div>`) +
      `<div class="legend-row"><span class="legend-swatch" style="background:#232936"></span>fuori ambito</div>` +
      `<div style="font-size:10px;color:var(--text-faint);margin-top:4px;max-width:186px;line-height:1.4">Ambito = sezioni prioritarie contigue entro ${AMB_DIST} m.</div>`;
    return;
  }
  if(sezGran && napoliColorMode==='mun'){
    div.innerHTML = `<strong>Municipalità</strong>` +
      Object.values(munAgg()).sort((a,b)=>a.mun-b.mun).map(o=>
        `<div class="legend-row"><span class="legend-swatch" style="background:${MUN_COLORS[(o.mun-1)%10]}"></span>${o.mun} · ${munNome(o.mun).split(' · ')[0]}</div>`).join('') +
      `<div style="font-size:10px;color:var(--text-faint);margin-top:4px;max-width:186px;line-height:1.4">Le linee bianche sono le cabine primarie: i due perimetri non coincidono.</div>`;
    return;
  }
  if(sezGran && napoliColorMode==='hiprod'){
    div.innerHTML = `<strong>Alta producibilità (indice > ${HIPROD})</strong>` +
      COLORS_FV.slice(3).map((c,i)=>`<div class="legend-row"><span class="legend-swatch" style="background:${c}"></span>${['sopra soglia','','massima'][i]||''}</div>`).join('') +
      `<div class="legend-row"><span class="legend-swatch" style="background:#232936"></span>sotto soglia (spente)</div>` +
      `<div style="font-size:10px;color:var(--text-faint);margin-top:4px;max-width:186px;line-height:1.4">Indice = rango percentile della producibilità fra tutte le sezioni della città.</div>`;
    return;
  }
  if(sezGran && napoliColorMode==='prioloc'){
    div.innerHTML = `<strong>📍 Localizzazione ottimale</strong>` +
      `<div class="legend-row"><span class="legend-swatch" style="background:#facc15"></span><strong>produttiva e idonea</strong> — priorità</div>` +
      `<div class="legend-row"><span class="legend-swatch" style="background:#1f5bab"></span>produttiva, iter ordinario o bloccato</div>` +
      `<div class="legend-row"><span class="legend-swatch" style="background:#232936"></span>bassa producibilità</div>`;
    return;
  }
  if(sezGran && napoliColorMode==='cross'){
    div.innerHTML = `<strong>✖️ Intersezione idonee × alta energia</strong>` +
      `<div class="legend-row"><span class="legend-swatch" style="background:#facc15;box-shadow:0 0 0 1px #fff"></span><strong>area prioritaria CER</strong></div>` +
      `<div class="legend-row"><span class="legend-swatch" style="background:#1f5bab"></span>idonea, energia inferiore</div>` +
      `<div class="legend-row"><span class="legend-swatch" style="background:#232936"></span>fuori intersezione</div>` +
      `<div style="font-size:10px;color:var(--text-faint);margin-top:4px;max-width:186px;line-height:1.4">In oro le sezioni che soddisfano <strong>entrambi</strong> i requisiti: area idonea (DM 21/06/2024) e producibilità elevata.</div>`;
    return;
  }
  if(!sezGran && napoliColorMode==='perim'){
    div.innerHTML = `<strong>Cabine primarie</strong>` +
      `<div class="legend-row"><span class="legend-swatch" style="background:#3b82f6"></span>perimetro di condivisione</div>` +
      `<div style="font-size:10px;color:var(--text-faint);margin-top:4px;max-width:180px;line-height:1.4">Dentro ciascun confine l'energia prodotta può essere condivisa dai membri della CER (D.Lgs. 199/2021).</div>`;
    return;
  }
  if(sezGran && napoliColorMode==='ivsm'){
    div.innerHTML = `<strong>Vulnerabilità sociale (IVSM)</strong>` +
      [['#ef4444','molto alta (80-100)'],['#f97316','alta (60-80)'],['#fbbf24','media (40-60)'],
       ['#3b82f6','bassa (20-40)'],['#1d4ed8','molto bassa (0-20)'],['#232936','non abitata']]
        .map(([c,l])=>`<div class="legend-row"><span class="legend-swatch" style="background:${c}"></span>${l}</div>`).join('');
    return;
  }
  if(sezGran && ['priorita','vuln','fv','norm','fer'].includes(napoliColorMode)){
    // legende dedicate alla tavola per sezioni
    if(napoliColorMode==='priorita'){
      title='IVSM della sezione (0-100)';
      rows = COLORS_IVSM.map((col,i)=>[col, ['0','20','40','60','80','100'][i]]);
    } else if(napoliColorMode==='vuln'){
      title=`Pop. vulnerabile sezione (IVSM>${THR})`;
      rows = COLORS_VULN.map((col,i)=>[col, ['0','','','','','max'][i]]);
    } else if(napoliColorMode==='norm'){
      title='Fattibilità normativa · DM 21/06/2024';
      rows = [[NORM_COLORS.fac,'✅ Idonea — iter semplificato'],
              [NORM_COLORS.ord,'📋 Ordinaria — iter standard'],
              [NORM_COLORS.blk,'🚫 Non idonea — bloccante'],
              [NORM_COLORS.na,'n.d.']];
    } else if(napoliColorMode==='fer'){
      title='🏆 FER_100 = (N_s + S_s)/2';
      rows = COLORS_FER.map((col,i)=>[col, ['0','20','40','60','80','100'][i]]);
    } else {
      title='Energia producibile (MWh/a)';
      rows = COLORS_FV.map((col,i)=>[col, ['nessuna','','','','','massima'][i]]);
    }
    div.innerHTML = `<strong>${title}</strong>` +
      rows.map(([col,lbl])=>`<div class="legend-row"><span class="legend-swatch" style="background:${col}"></span>${lbl}</div>`).join('') +
      // il blocco delle classi non si ripete quando il colore già le rappresenta (step 2)
      (hasNorm() && cityNormBorders && napoliColorMode !== 'norm' ? `<div style="border-top:1px solid rgba(255,255,255,.15);margin-top:6px;padding-top:6px"></div>
        <div style="font-size:10px;color:var(--text-faint);margin-bottom:3px">Bordo delle sezioni — DM 21/06/2024:</div>
        <div class="legend-row"><span class="legend-swatch" style="border:1.5px solid #22c55e;background:transparent"></span>✅ area idonea</div>
        <div class="legend-row"><span class="legend-swatch" style="border:1.5px solid #ef4444;background:transparent"></span>🚫 area non idonea</div>` : '') +
      `<div class="legend-row" style="margin-top:4px;color:var(--text-faint)">— linee bianche: cabine primarie</div>`;
    return;
  }
  if(napoliColorMode==='priorita'){
    const b = prioBreaks();
    title=`Priorità · pop. vulnerabile (IVSM>${THR}, Jenks)`;
    rows = [
      ['#ef4444',`C1 — Alta (> ${fmt(Math.round(b.b2))} vuln.)`],
      ['#fb923c',`C2 — Media (> ${fmt(Math.round(b.b1))})`],
      ['#8b93a8',`C3 — Bassa (≤ ${fmt(Math.round(b.b1))})`],
    ];
  } else if(napoliColorMode==='vuln'){
    title='% popolazione vulnerabile';
    rows = [
      ['#ef4444','≥ 12%'], ['#f97316','≥ 10%'], ['#fb923c','≥ 8%'],
      ['#fbbf24','≥ 6%'], ['#8b93a8','< 6%'],
    ];
  } else if(napoliColorMode==='cer'){
    title='Configurazione CER consigliata';
    rows = ['erp','pub','ind','mista','res'].map(k=>[CER_TIPI[k].col, CER_TIPI[k].n.replace('CER ','')]);
  } else if(napoliColorMode==='fv'){
    title='Energia producibile (relativa)';
    rows = [
      ['#22d3ee','molto alto'], ['#06b6d4','alto'], ['#0e7490','medio'],
      ['#155e75','basso'], ['#1e2535','minimo'],
    ];
  } else if(napoliColorMode==='norm'){
    title='% FV cabina in aree non idonee';
    rows = hasNorm() ? [
      ['#ef4444','≥ 40% — forte vincolo'], ['#f97316','≥ 25%'], ['#fbbf24','≥ 10%'],
      ['#84cc16','≥ 2%'], ['#22c55e','< 2% — via libera'],
    ] : [[NORM_COLORS.na,'layer normativo non caricato']];
  } else if(napoliColorMode==='fer'){
    title='🏆 FER_100 medio (tecnica × normativa)';
    rows = hasFer() ? COLORS_FER.map((col,i)=>[col, ['0-17','17-33','33-50','50-67','67-83','83-100'][i]])
                    : [[NORM_COLORS.na,'FER_100 non disponibile']];
  } else {
    title='Copertura pop. vuln.';
    rows = [
      ['#22c55e','≥ 2%'], ['#84cc16','≥ 1%'], ['#fbbf24','≥ 0,5%'],
      ['#f97316','≥ 0,2%'], ['#ef4444','< 0,2%'],
    ];
  }
  div.innerHTML = `<strong>${title}</strong>` +
    rows.map(([col,lbl])=>`<div class="legend-row"><span class="legend-swatch" style="background:${col}"></span>${lbl}</div>`).join('');
}

function setNapoliMapColor(mode, btn){
  napoliColorMode = mode;
  document.querySelectorAll('[data-napoli-color]').forEach(b=>b.classList.remove('active'));
  if(btn) btn.classList.add('active');
  // la vista "migliori opportunità" ha senso solo alla scala della sezione
  if(mode==='best' && napoliGranularity!=='sez'){
    const gb = document.querySelector('[data-napoli-gran="sez"]');
    napoliGranularity = 'sez';
    document.querySelectorAll('[data-napoli-gran]').forEach(b=>b.classList.remove('active'));
    if(gb) gb.classList.add('active');
    const covBtn = document.querySelector('[data-napoli-color="cov"]');
    if(covBtn) covBtn.style.display='none';
  }
  const hint = document.getElementById('napoli-hint');
  if(hint) hint.innerHTML = {
    perim:STEP_HINT[1],
    cross:STEP_HINT[6],
    priorita:'Ogni cabina è colorata per <strong>quante persone vulnerabili</strong> ci vivono: <span style="color:#ef4444">rosso = priorità alta (C1)</span>, poi arancione e grigio.',
    vuln:'Quota di residenti vulnerabili sul totale: dove il tessuto sociale è più fragile in proporzione.',
    fv:'Quanta energia solare si potrebbe produrre sui tetti censiti: <span style="color:#22d3ee">più chiaro = più energia</span>.',
    cer:'Che tipo di comunità energetica conviene in ciascuna zona, in base a quali tetti prevalgono.',
    cov:'Quanta parte del fabbisogno delle famiglie vulnerabili sarebbe già coperta dal solare.',
    norm:'<span style="color:#22c55e">Verde</span>: quasi tutto il potenziale è installabile. <span style="color:#ef4444">Rosso</span>: buona parte cade in <strong>aree non idonee</strong>, dove l\'impianto è bloccato.',
    fer:'Punteggio complessivo <strong>normativa + produttività</strong>: <span style="color:#facc15">le zone dorate sono le migliori dove installare</span>.',
    best:'🎯 Restano accese <strong>solo le sezioni in area idonea</strong> (iter semplificato), colorate per quanta energia producono: <span style="color:#0a2f75;background:#c9def3;padding:0 4px;border-radius:3px">il blu intenso segna le più produttive</span>. Tutto il resto è spento.',
  }[mode] || '';
  drawNapoli();
}
// ---------- I 5 STEP DELLA METODOLOGIA ----------
// Sequenza del quadro metodologico: fattori normativi e urbanistici (1-2),
// climatici e ambientali (3), socio-economici (4), sintesi prioritaria (5).
const STEP_HINT = {
  1:'<strong>Step 1 · Perimetrazione</strong> — le 12 <strong>cabine primarie</strong> sono il perimetro entro cui la legge consente di condividere l\'energia (D.Lgs. 199/2021): ogni comunità energetica vive dentro uno di questi confini. Clicca una cabina per entrarci.',
  2:'<strong>Step 2 · Aree idonee e non idonee</strong> — il territorio classificato dal <strong>Decreto Aree Idonee</strong> (DM 21/06/2024): <span style="color:#22c55e">verde</span> dove l\'iter è semplificato, <span style="color:#fbbf24">giallo</span> dove è ordinario, <span style="color:#ef4444">rosso</span> dove l\'impianto è di fatto bloccato da vincoli di tutela.',
  3:'<strong>Step 3 · Tetti ed edifici</strong> — quanta energia solare si può produrre sulle coperture: <span style="color:#22d3ee">più chiaro = più energia</span>. Avvicinati con lo zoom per vedere i <strong>singoli edifici</strong>, distinti per tipo; cliccane uno per la scheda.',
  4:'<strong>Step 4 · Vulnerabilità</strong> — l\'indice di vulnerabilità sociale e materiale (IVSM) per sezione: <span style="color:#ef4444">rosso = fragilità alta</span>. È la misura della povertà energetica, cioè <em>chi</em> ha più bisogno di beneficiare della comunità.',
  4:'<strong>Step 4 · Alta producibilità</strong> — restano accese solo le sezioni <strong>più produttive della città</strong> (indice di producibilità superiore a 60, cioè più produttive del 60% delle sezioni). È il potenziale energetico su cui vale la pena ragionare, indipendentemente dai vincoli.',
  5:'<strong>Step 5 · Localizzazione ottimale</strong> — alle sezioni ad alta producibilità si applica il filtro normativo: in <strong style="color:#facc15">oro</strong> quelle che ricadono anche in <strong style="color:#22c55e">area idonea</strong> — iter semplificato, quindi <strong>priorità di intervento</strong>; in <span style="color:#5b8fd6">blu</span> le altre, produttive ma con iter ordinario o bloccato.',
  6:'<strong>Step 6 · Vulnerabilità sociale</strong> — l\'indice IVSM per sezione, misura della povertà energetica: <span style="color:#ef4444">rosso = fragilità alta</span>. È il lato della <em>domanda</em>, che non risponde ad alcun vincolo normativo: i residenti sono beneficiari ovunque abitino.',
  8:'<strong>Step 8 · Ambiti di intervento</strong> — le sezioni prioritarie contigue si raggruppano in <strong>ambiti di progetto</strong>: la scala a cui si dimensiona un impianto. Per ciascuno l\'SSD indica la <strong>tipologia di CER</strong> derivata dal mix dell\'edificato e la rigenerazione urbana abilitata. Click su una riga per lo <strong>zoom sugli edifici</strong>.',
  9:'<strong>Step 9 · Indicazioni per il PAESC</strong> — l\'esito si traduce in <strong>schede d\'azione</strong> per il Piano d\'Azione per l\'Energia Sostenibile e il Clima: obiettivo, soggetti responsabili, MWh/a, tonnellate di CO₂ evitate, tempi e indicatori di monitoraggio, ambito per ambito.',
  10:'<strong>Step 10 · I dieci ambiti prioritari</strong> — la sintesi conclusiva: gli ambiti ordinati per <strong>numero di residenti vulnerabili presenti nelle cabine</strong> che attraversano, coerentemente con il criterio di priorità sociale che guida tutto il framework. Accanto, quanti di quei residenti l\'energia dell\'ambito riesce effettivamente a servire.',
  7:'<strong>Step 7 · Aree prioritarie per la CER</strong> — offerta e domanda sulla stessa tavola: in <strong style="color:#facc15">oro</strong> i siti ottimali dello step 5, in <strong style="color:#a855f7">viola</strong> le sezioni vulnerabili (IVSM > <span id="prio-thr">60</span>), in <strong style="color:#f97316">arancione</strong> dove coincidono. Sotto la mappa, gli <strong>scenari di configurazione</strong>: quale tipologia di CER — ERP, pubblico, produttivo o loro combinazioni — copre davvero il fabbisogno di ciascuna cabina.',
};
let cityStep = 1, cabStep = 2;
// I contorni normativi (bordo rosso sulle non idonee) si spengono allo step 4:
// la vulnerabilità sociale non ha nulla a che vedere con il vincolo sull'impianto.
let cityNormBorders = true;
function setCityStep(n, btn){
  cityStep = n;
  document.querySelectorAll('[data-citystep]').forEach(b=>b.classList.remove('active'));
  if(btn) btn.classList.add('active');
  const setGran = g => {
    napoliGranularity = g;
    document.querySelectorAll('[data-napoli-gran]').forEach(b=>b.classList.toggle('active', b.dataset.napoliGran===g));
  };
  const setColor = m => {
    napoliColorMode = m;
    document.querySelectorAll('[data-napoli-color]').forEach(b=>b.classList.toggle('active', b.dataset.napoliColor===m));
  };
  const pai = (id, nid) => { setPai(napoliMap,'idonee',id); setPai(napoliMap,'non_idonee',nid);
    const a=document.getElementById('btn-pai-id'), b2=document.getElementById('btn-pai-nid');
    if(a) a.classList.toggle('active', id); if(b2) b2.classList.toggle('active', nid); };
  // i contorni dei vincoli restano spenti dove non c'entrano (producibilità, vulnerabilità)
  cityNormBorders = (n === 2 || n === 5 || n === 7);
  if(n===1){ setGran('cab'); setColor('perim');   pai(false,false); cityBuildings=false; }
  if(n===2){ setGran('sez'); setColor('norm');    pai(true,true);   cityBuildings=false; }
  if(n===3){ setGran('sez'); setColor('fv');      pai(false,false); cityBuildings=true; }
  if(n===4){ setGran('sez'); setColor('hiprod');  pai(false,false); cityBuildings=false; }
  if(n===5){ setGran('sez'); setColor('prioloc'); pai(true,false);  cityBuildings=false; }
  if(n===6){ setGran('sez'); setColor('ivsm');    pai(false,false); cityBuildings=false; }
  if(n===7){ setGran('sez'); setColor('prio');    pai(true,false);  cityBuildings=false; }
  if(n===8){ setGran('sez'); setColor('ambiti');  pai(false,false); cityBuildings=false; }
  if(n===9){ setGran('sez'); setColor('ambiti');  pai(false,false); cityBuildings=false; }
  if(n===10){setGran('sez'); setColor('top10');   pai(false,false); cityBuildings=false; }
  const cb = document.getElementById('btn-city-bld');
  if(cb) cb.classList.toggle('active', cityBuildings);
  const hint = document.getElementById('napoli-hint');
  if(hint) hint.innerHTML = STEP_HINT[n];
  drawNapoli();
  const cross = document.getElementById('cross-panel');
  if(cross){ cross.style.display = (n===5 || n===7) ? 'block' : 'none';
             if(n===5) buildLocPanel(); if(n===7) buildPrioPanel(); }
  const best = document.getElementById('best-panel');
  if(best) best.style.display = 'none';
  // i pannelli conclusivi compaiono solo al proprio passo
  const show = (id, on, fn) => { const e = document.getElementById(id);
    if(!e) return; e.style.display = on ? 'block' : 'none'; if(on && fn) fn(); };
  show('ambiti-panel', n===8, buildAmbitiPanel);
  show('paesc-panel',  n===9, buildPaescPanel);
  show('top10-panel',  n===10, buildTop10Panel);
  show('mun-panel',    n<=7);
  const target = n===8 ? 'ambiti-panel' : n===9 ? 'paesc-panel' : n===10 ? 'top10-panel'
               : (n===5 || n===7) ? 'cross-panel' : null;
  if(target){ const e = document.getElementById(target);
              if(e) setTimeout(()=>e.scrollIntoView({behavior:'smooth', block:'start'}), 400); }
}

// ---------- Step 5: pannello della localizzazione ottimale ----------
function buildLocPanel(){
  const el = document.getElementById('cross-panel');
  if(!el) return;
  const hi = DATA.sezioni.filter(isHiProd);
  const ok = hi.filter(isIdonea).sort((a,b)=>(b.fv_tot||0)-(a.fv_tot||0));
  const mwhOk = ok.reduce((a,s)=>a+(s.fv_tot||0),0);
  const mwhHi = hi.reduce((a,s)=>a+(s.fv_tot||0),0);
  const byCab = {}; ok.forEach(s=>{ byCab[s.cab] = (byCab[s.cab]||0)+(s.fv_tot||0); });
  const chips = Object.entries(byCab).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([cab,mwh])=>
    `<span onclick="openCabina('${cab}')" style="cursor:pointer;display:inline-flex;gap:6px;align-items:center;padding:5px 11px;border-radius:99px;background:var(--surface2);border:1px solid var(--border);font-size:11.5px">
      <strong class="cabina-code">${cab.replace('AC001E00','')}</strong> ${fmt(Math.round(mwh))} MWh</span>`).join(' ');
  const rows = ok.slice(0,10).map((s,i)=>`
    <tr onclick="openCabina('${s.cab}');setTimeout(()=>zoomSez('${s.id}'),700)">
      <td style="color:#facc15;font-weight:700">${i+1}</td>
      <td><span class="sez-id">${shortSez(s.id)}</span></td>
      <td><span class="cabina-code" style="font-size:10.5px">${String(s.cab).replace('AC001E00','')}</span></td>
      <td class="num">${fmt1(prodIndex(s))}</td>
      <td class="num">${fmt(Math.round(s.fv_tot||0))} MWh</td>
      <td class="num">${sezPV(s)>0?`<span style="color:#a855f7">${fmt(sezPV(s))}</span>`:'—'}</td>
    </tr>`).join('');
  el.innerHTML = `
    <div class="section-title">📍 Localizzazione ottimale — alta producibilità in area idonea</div>
    <div class="panel" style="border-top:3px solid #facc15">
      <div class="panel-header"><div>
        <div class="panel-title">I siti dove installare conviene sotto ogni profilo</div>
        <div class="table-sub">Sezioni con indice di producibilità > ${HIPROD} <em>e</em> ricadenti in area idonea del DM 21/06/2024: massima resa energetica con l'iter autorizzativo più rapido.</div>
      </div>
      <div style="display:flex;gap:22px;text-align:right;flex-wrap:wrap">
        <div><div style="font-family:var(--font-display);font-size:26px;color:#facc15;line-height:1">${fmt(ok.length)}</div><div style="font-size:10.5px;color:var(--text-muted)">siti ottimali</div></div>
        <div><div style="font-family:var(--font-display);font-size:26px;color:var(--accent2);line-height:1">${(mwhOk/1000).toFixed(1)}</div><div style="font-size:10.5px;color:var(--text-muted)">GWh/a attivabili</div></div>
        <div><div style="font-family:var(--font-display);font-size:26px;color:#5b8fd6;line-height:1">${fmt(hi.length-ok.length)}</div><div style="font-size:10.5px;color:var(--text-muted)">produttive ma non idonee</div></div>
      </div></div>
      <div class="panel-body">
        <div style="font-size:11.5px;color:var(--text-muted);margin-bottom:8px">Energia attivabile per cabina — click per entrare:</div>
        <div style="display:flex;gap:7px;flex-wrap:wrap;margin-bottom:14px">${chips}</div>
        <table style="font-size:13px">
          <thead><tr><th style="width:30px">#</th><th>Sezione</th><th>Cabina</th><th class="num">Indice prod.</th><th class="num">Energia</th><th class="num">Vulnerabili</th></tr></thead>
          <tbody>${rows}</tbody></table>
        <div style="font-size:10.5px;color:var(--text-faint);padding:8px 2px 0;line-height:1.5">Le ${fmt(hi.length)} sezioni ad alta producibilità totalizzano ${(mwhHi/1000).toFixed(1)} GWh/a: ${(mwhOk/mwhHi*100).toFixed(0)}% ricade in area idonea e può essere attivato per primo.</div>
      </div>
    </div>`;
}

// ---------- 🎯 Step 7: aree prioritarie + soluzione per cabina ----------
// Non basta sapere dove offerta e domanda coincidono: la CER condivide l'energia
// dentro tutta la cabina, quindi la domanda utile è "installando nei siti ottimali
// di questa cabina, quante persone vulnerabili riesco a servire?".
// ---------- Scenari di configurazione CER per tipologia di edificato ----------
// Una CER si costituisce attorno a soggetti reali: l'ente gestore ERP, il Comune,
// le imprese. I tetti residenziali privati richiedono l'adesione di migliaia di
// condomini: entrano solo come CASO LIMITE, per misurare il potenziale teorico.
const SRC_FV = { erp:s=>s.fv_mwh||0, pub:s=>s.fv_pub||0, ind:s=>s.fv_ind||0, res:s=>s.fv_res||0 };
const SCEN_REAL = ['erp','pub','ind'];          // scenario realistico di riferimento
const SCENARI = [
  {k:['erp'],              n:'ERP',            lbl:'solo edilizia residenziale pubblica'},
  {k:['pub'],              n:'Pubblico',       lbl:'solo patrimonio comunale'},
  {k:['ind'],              n:'Industriale',    lbl:'solo coperture produttive'},
  {k:['erp','pub'],        n:'ERP+Pub',        lbl:'ente gestore ERP e Comune insieme'},
  {k:['erp','ind'],        n:'ERP+Ind',        lbl:'ERP con le imprese insediate'},
  {k:['pub','ind'],        n:'Pub+Ind',        lbl:'Comune e imprese'},
  {k:['erp','pub','ind'],  n:'Tutte e tre',    lbl:'configurazione integrata multi-attore'},
  {k:['erp','pub','ind','res'], n:'+ residenziale', lbl:'CASO LIMITE — richiede l\'adesione dei condomini privati', limite:true},
];
function energiaCab(c, srcs){
  return DATA.sezioni.filter(s=>s.cab===c.id && isAmmissibile(s))
    .reduce((a,s)=> a + srcs.reduce((x,k)=> x + SRC_FV[k](s), 0), 0);
}
function scenarioCab(c, srcs){
  const mwh = energiaCab(c, srcs);
  const popV = cabPopVuln(c), consPro = params.cons_kwh/1000, dom = popV*consPro;
  return { mwh, dom, popV,
           serviti: Math.min(popV, consPro>0 ? Math.floor(mwh/consPro) : 0),
           cop: dom>0 ? Math.min(100, mwh/dom*100) : (mwh>0?100:0) };
}
// La configurazione minima che copre il fabbisogno: dice quale CER basta davvero
function scenarioMinimo(c){
  for(const sc of SCENARI){
    if(sc.limite) continue;
    if(scenarioCab(c, sc.k).cop >= 100) return sc;
  }
  return null;
}

// La soluzione di riferimento è quella REALISTICA: solo coperture con un titolare
// istituzionale o imprenditoriale (ERP, pubblico, produttivo). Il residenziale privato
// è riportato a parte come caso limite, perché richiederebbe l'adesione volontaria
// di migliaia di condomini.
function cabSolution(c){
  const sez = DATA.sezioni.filter(s=>s.cab===c.id && isAmmissibile(s));
  const somma = (arr, srcs) => arr.reduce((a,s)=> a + srcs.reduce((x,k)=> x + SRC_FV[k](s), 0), 0);
  const siti   = sez.filter(s=>SCEN_REAL.some(k=>SRC_FV[k](s) > 0));
  const rapidi = siti.filter(isIdonea);                 // in area idonea: iter semplificato
  const mwh    = somma(sez, SCEN_REAL);
  const mwhRap = somma(sez.filter(isIdonea), SCEN_REAL);
  const mwhLim = somma(sez, ['erp','pub','ind','res']); // caso limite col residenziale
  const popV = cabPopVuln(c);
  const consPro = params.cons_kwh/1000;                 // MWh per persona/anno
  const domanda = popV * consPro;
  const serviti = Math.min(popV, consPro>0 ? Math.floor(mwh/consPro) : 0);
  return { siti: siti.length, mwh, popV, domanda, serviti,
           rapidi: rapidi.length, mwhRap, mwhLim,
           scenMin: scenarioMinimo(c),
           copLim: domanda>0 ? Math.min(100, mwhLim/domanda*100) : 0,
           // quota del fabbisogno raggiungibile con i soli siti a procedura semplificata:
           // distingue chi può partire subito da chi deve passare per l'iter ordinario
           copRap: domanda>0 ? Math.min(100, mwhRap/domanda*100) : 0,
           cop: domanda>0 ? Math.min(100, mwh/domanda*100) : (mwh>0?100:0) };
}

// ---------- Matrice degli scenari: quale CER copre davvero il fabbisogno ----------
// Non tutte le configurazioni sono ugualmente praticabili. Qui si legge, cabina per
// cabina, quanta parte della domanda vulnerabile copre ciascuna tipologia di CER e
// qual è la configurazione MINIMA sufficiente: è la risposta operativa a "che CER fare qui".
function buildScenariHtml(box, vulnTot){
  const cab = [...DATA.cabine].sort((a,b)=>cabPopVuln(b)-cabPopVuln(a));
  const cell = cop => {
    const col = cop>=100 ? '#22c55e' : cop>=70 ? '#facc15' : cop>=35 ? '#fb923c' : '#7f1d1d';
    const txt = cop>=100 ? '#0e1117' : '#fff';
    return `<td style="text-align:center;padding:4px 3px"><span style="display:inline-block;min-width:42px;padding:3px 6px;border-radius:6px;background:${col};color:${txt};font-weight:${cop>=100?700:500};font-size:11.5px">${cop.toFixed(0)}%</span></td>`;
  };
  const rows = cab.map(c=>{
    const pr = cabPrio(c), popV = cabPopVuln(c);
    const min = scenarioMinimo(c);
    const cells = SCENARI.map(sc=>cell(scenarioCab(c, sc.k).cop)).join('');
    return `<tr onclick="openCabina('${c.id}')">
      <td><span class="cabina-code">${c.id.replace('AC001E00','')}</span>
          <span style="color:${pr.color};font-size:10px;font-weight:700"> ${pr.tier}</span></td>
      <td class="num" style="color:#a855f7;font-weight:600">${fmt(popV)}</td>
      ${cells}
      <td style="font-size:11.5px;font-weight:600;color:${min?'#22c55e':'#f87171'}">${min ? min.n : 'nessuna basta'}</td>
    </tr>`;
  }).join('');
  // totali di città per ciascuno scenario
  const tot = SCENARI.map(sc=>({sc, serv: cab.reduce((a,c)=>a+scenarioCab(c, sc.k).serviti, 0)}));
  const barre = tot.map(t=>{
    const pct = vulnTot ? t.serv/vulnTot*100 : 0;
    return `<div style="margin-bottom:7px">
      <div style="display:flex;justify-content:space-between;font-size:11.5px;margin-bottom:2px">
        <span${t.sc.limite?' style="color:var(--text-faint);font-style:italic"':''}>${t.sc.n} <span style="color:var(--text-faint)">— ${t.sc.lbl}</span></span>
        <strong style="color:${t.sc.limite?'#8b93a8':'#f97316'}">${fmt(t.serv)} · ${pct.toFixed(0)}%</strong></div>
      <div style="height:9px;border-radius:99px;background:var(--surface3);overflow:hidden">
        <div style="height:100%;width:${pct.toFixed(1)}%;border-radius:99px;background:${t.sc.limite?'repeating-linear-gradient(45deg,#4d5568,#4d5568 4px,#2a2f3d 4px,#2a2f3d 8px)':'linear-gradient(90deg,#facc15,#f97316)'}"></div></div>
    </div>`;
  }).join('');
  const senza = cab.filter(c=>!scenarioMinimo(c));
  return `
    <div style="margin-top:22px;padding-top:16px;border-top:1px solid var(--border-strong)">
      <div class="panel-title" style="margin-bottom:3px">⚡ Quale CER copre il fabbisogno — scenari per tipologia di edificato</div>
      <div class="table-sub" style="margin-bottom:14px">Una comunità energetica si costituisce attorno a soggetti reali: l'ente gestore ERP, il Comune, le imprese. Qui si legge quanta parte della domanda vulnerabile copre ciascuna configurazione e qual è la <strong>minima sufficiente</strong> per ogni cabina. Il residenziale privato compare solo come <em>caso limite</em>: richiederebbe l'adesione volontaria di migliaia di condomini e non costituisce uno scenario di piano.</div>
      <div style="margin-bottom:16px;max-width:720px">${barre}</div>
      <div style="overflow-x:auto">
      <table style="font-size:12.5px">
        <thead><tr><th>Cabina</th><th class="num">Vulnerabili</th>
          ${SCENARI.map(sc=>`<th style="text-align:center;font-size:10px${sc.limite?';color:var(--text-faint);font-style:italic':''}">${sc.n}</th>`).join('')}
          <th>Configurazione minima</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      ${senza.length ? `<div style="margin-top:12px;padding:11px 14px;border-radius:10px;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.3);font-size:12px;line-height:1.55;color:var(--text-muted)">
        ⚠️ <strong style="color:#f87171">${senza.map(c=>c.id.replace('AC001E00','')).join(', ')}</strong>: nessuna configurazione istituzionale copre da sola l'intero fabbisogno.
        ${senza.map(c=>`In ${c.id.replace('AC001E00','')} la configurazione integrata arriva al <strong>${scenarioCab(c,['erp','pub','ind']).cop.toFixed(0)}%</strong>`).join('; ')}.
        Il residuo richiede l'apertura ai prosumer residenziali, la riqualificazione energetica del patrimonio ERP per abbassare la domanda, o accordi con cabine limitrofe.</div>` : ''}
    </div>`;
}

function buildPrioPanel(){
  const el = document.getElementById('cross-panel');
  if(!el || !hasFer()) return;
  const inCross = s => isSitoRapido(s);
  const isVul   = s => isVulnSec(s);
  const both  = DATA.sezioni.filter(s=>inCross(s) && isVul(s)).sort((a,b)=>sezPV(b)-sezPV(a));
  const onlyP = DATA.sezioni.filter(s=>inCross(s) && !isVul(s));
  const onlyV = DATA.sezioni.filter(s=>!inCross(s) && isVul(s));
  const fvT = s => s.fv_tot || 0;
  const vulnInBoth = both.reduce((a,s)=>a+sezPV(s),0);
  const vulnTot = DATA.sezioni.reduce((a,s)=>a+sezPV(s),0);
  // La soluzione per cabina: dove installare e quanti vulnerabili si servono
  const sol = DATA.cabine.map(c=>({c, ...cabSolution(c)}))
                         .filter(x=>x.siti>0 || x.popV>0)
                         .sort((a,b)=>b.serviti-a.serviti);
  const totServiti = sol.reduce((a,x)=>a+x.serviti,0);
  const box = (col,n,t,sub) => `<div style="flex:1 1 150px;padding:12px 14px;border-radius:12px;background:${col}1a;border:1px solid ${col}55">
      <div style="font-family:var(--font-display);font-size:26px;color:${col};line-height:1">${n}</div>
      <div style="font-size:12px;font-weight:600;margin-top:2px">${t}</div>
      <div style="font-size:10.5px;color:var(--text-muted);line-height:1.4;margin-top:3px">${sub}</div></div>`;
  const rows = both.slice(0,10).map((s,i)=>`
    <tr onclick="openCabina('${s.cab}');setTimeout(()=>zoomSez('${s.id}'),700)">
      <td style="color:#f97316;font-weight:700">${i+1}</td>
      <td><span class="sez-id">${shortSez(s.id)}</span></td>
      <td><span class="cabina-code" style="font-size:10.5px">${String(s.cab).replace('AC001E00','')}</span></td>
      <td class="num">${fmt1(normPv(s))}</td>
      <td class="num">${s.ivsm}</td>
      <td class="num" style="color:#fb923c;font-weight:600">${fmt(sezPV(s))}</td>
      <td class="num">${fvT(s)>0?fmt1(fvT(s))+' MWh':'<span style="color:var(--text-faint)">tetti privati</span>'}</td>
    </tr>`).join('');
  el.innerHTML = `
    <div class="section-title">🎯 Aree prioritarie per la CER — dove si può produrre <em>e</em> serve davvero</div>
    <div class="panel" style="border-top:3px solid #f97316">
      <div class="panel-header"><div>
        <div class="panel-title">Sovrapposizione di offerta e domanda</div>
        <div class="table-sub">Alle sezioni ammissibili e produttive dello step 6 si somma la vulnerabilità sociale, considerata solo oltre la soglia <strong>IVSM > ${THR}</strong>.</div>
      </div></div>
      <div class="panel-body">
        <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px">
          ${box('#f97316', fmt(both.length), 'Priorità massima', 'area idonea + alta energia + vulnerabilità')}
          ${box('#facc15', fmt(onlyP.length), 'Solo offerta', 'si può produrre, ma la fragilità sociale è altrove')}
          ${box('#ef4444', fmt(onlyV.length), 'Solo domanda', 'popolazione fragile senza siti produttivi ammissibili')}
          ${box('#fb923c', fmt(vulnInBoth), 'Vulnerabili raggiunti', `su ${fmt(vulnTot)} in città${vulnTot?` · ${(vulnInBoth/vulnTot*100).toFixed(1)}%`:''}`)}
        </div>
        ${both.length ? `<table style="font-size:13px">
          <thead><tr><th style="width:30px">#</th><th>Sezione</th><th>Cabina</th><th class="num">Energia</th><th class="num">IVSM</th><th class="num">Vulnerabili</th><th class="num">Tetti censiti</th></tr></thead>
          <tbody>${rows}</tbody></table>`
        : `<div style="padding:14px;font-size:12.5px;color:var(--text-muted);line-height:1.6;background:var(--surface2);border-radius:10px">
            <strong>Quasi nessuna sezione è insieme sito ottimale e luogo di fragilità.</strong> Non è un errore del metodo:
            a Napoli le superfici migliori per produrre e i quartieri più fragili <em>non coincidono nello spazio</em>.
            Per questo la risposta non è la sovrapposizione, ma la <strong>condivisione dentro la cabina primaria</strong>,
            quantificata qui sotto.</div>` }

        ${buildScenariHtml(box, vulnTot)}
        <div style="font-size:10.5px;color:var(--text-faint);padding:10px 2px 0;line-height:1.5">La soglia di vulnerabilità è regolabile nel pannello a sinistra (60 · 70 · 80): cambiandola l'intera sintesi si aggiorna.</div>
      </div>
    </div>`;
}

// ---------- ✖️ Step 6: intersezione idonee × alta producibilità (scala urbana) ----------
function buildCrossPanel(){
  const el = document.getElementById('cross-panel');
  if(!el || !hasFer()) return;
  const sel = crossSections(), thr = crossThreshold();
  const fvT = s => s.fv_tot || (s.fv_mwh||0)+(s.fv_pub||0)+(s.fv_ind||0);
  const nIdon = DATA.sezioni.filter(s=>normStatus(s).code==='fac').length;
  const totMwh = sel.reduce((a,s)=>a+fvT(s),0);
  const vulnTot = sel.reduce((a,s)=>a+sezPV(s),0);
  const byCab = {};
  sel.forEach(s=>{ byCab[s.cab] = (byCab[s.cab]||0)+1; });
  const cabRows = Object.entries(byCab).sort((a,b)=>b[1]-a[1]).slice(0,6).map(([cab,n])=>{
    const c = DATA.cabine.find(x=>x.id===cab);
    const pr = c ? cabPrio(c) : null;
    return `<span onclick="openCabina('${cab}')" style="cursor:pointer;display:inline-flex;align-items:center;gap:6px;padding:5px 11px;border-radius:99px;background:var(--surface2);border:1px solid var(--border);font-size:11.5px">
      <strong class="cabina-code">${cab.replace('AC001E00','')}</strong> ${n} sez.
      ${pr?`<span style="color:${pr.color};font-weight:700">${pr.tier}</span>`:''}</span>`;
  }).join(' ');
  const top = sel.slice(0,8).map((s,i)=>`
    <tr onclick="openCabina('${s.cab}');setTimeout(()=>zoomSez('${s.id}'),700)">
      <td style="color:#facc15;font-weight:700">${i+1}</td>
      <td><span class="sez-id">${shortSez(s.id)}</span></td>
      <td><span class="cabina-code" style="font-size:10.5px">${String(s.cab).replace('AC001E00','')}</span></td>
      <td class="num">${fmt1(normPv(s))}</td>
      <td class="num">${fvT(s)>0?fmt1(fvT(s))+' MWh':'<span style="color:var(--text-faint)">tetti privati</span>'}</td>
      <td class="num">${sezPV(s)>0?`<span style="color:#fb923c">👥 ${fmt(sezPV(s))}</span>`:'<span style="color:var(--text-faint)">—</span>'}</td>
    </tr>`).join('');
  el.innerHTML = `
    <div class="section-title">✖️ Intersezione a scala urbana — aree idonee <em>e</em> ad alta producibilità</div>
    <div class="panel" style="border-top:3px solid #facc15">
      <div class="panel-header" style="flex-wrap:wrap;gap:14px">
        <div>
          <div class="panel-title">Le aree prioritarie per la CER a Napoli</div>
          <div class="table-sub">Sezioni che soddisfano <strong>entrambi</strong> i requisiti: ricadono in area idonea del DM 21/06/2024 <em>e</em> appartengono al <strong>quarto più produttivo</strong> fra le idonee (soglia S<sub>s</sub> ≥ ${fmt1(thr)}/100).</div>
        </div>
        <div style="display:flex;gap:22px;flex-wrap:wrap;text-align:right">
          <div><div style="font-family:var(--font-display);font-size:26px;color:#facc15;line-height:1">${fmt(sel.length)}</div><div style="font-size:10.5px;color:var(--text-muted)">sezioni prioritarie</div></div>
          <div><div style="font-family:var(--font-display);font-size:26px;color:#22c55e;line-height:1">${fmt(nIdon)}</div><div style="font-size:10.5px;color:var(--text-muted)">idonee totali</div></div>
          <div><div style="font-family:var(--font-display);font-size:26px;color:var(--accent2);line-height:1">${fmt(Math.round(totMwh))}</div><div style="font-size:10.5px;color:var(--text-muted)">MWh/a sui tetti censiti</div></div>
          <div><div style="font-family:var(--font-display);font-size:26px;color:#fb923c;line-height:1">${fmt(vulnTot)}</div><div style="font-size:10.5px;color:var(--text-muted)">vulnerabili nelle stesse sezioni</div></div>
        </div>
      </div>
      <div class="panel-body" style="padding:12px 16px">
        <div style="font-size:11.5px;color:var(--text-muted);margin-bottom:8px">Distribuzione per cabina primaria — click per entrare:</div>
        <div style="display:flex;gap:7px;flex-wrap:wrap;margin-bottom:14px">${cabRows}</div>
        <table style="font-size:13px">
          <thead><tr><th style="width:30px">#</th><th>Sezione</th><th>Cabina</th><th class="num">Energia (0-100)</th><th class="num">Tetti censiti</th><th class="num">Vulnerabili</th></tr></thead>
          <tbody>${top || '<tr><td colspan="6" style="text-align:center;padding:14px;color:var(--text-muted)">Nessuna sezione soddisfa entrambi i requisiti</td></tr>'}</tbody>
        </table>
      </div>
    </div>`;
}
function setCabStep(n, btn){
  cabStep = n;
  document.querySelectorAll('[data-cabstep]').forEach(b=>b.classList.remove('active'));
  if(btn) btn.classList.add('active');
  const setColor = m => { mapColorMode = m;
    document.querySelectorAll('#view-cabina [data-color]').forEach(b=>b.classList.toggle('active', b.dataset.color===m)); };
  const setPhase = p => { normPhase = p;
    document.querySelectorAll('[data-phase]').forEach(b=>b.classList.toggle('active', b.dataset.phase===p)); };
  const srcBar = document.getElementById('src-bar');
  if(srcBar) srcBar.style.display = n===3 ? 'flex' : 'none';
  if(n===2){ setColor('norm');    setPhase('all'); showBuildings=false; ivsmOverlay=false; prioOverlay=false; normOverlay=true; }
  if(n===3){ setColor('fv');      setPhase('all'); showBuildings=true;  ivsmOverlay=false; prioOverlay=false; normOverlay=false; fvSource='tot';
             document.querySelectorAll('.src-btn').forEach(b=>b.classList.toggle('active', b.dataset.src==='tot')); }
  if(n===4){ setColor('hiprod');  setPhase('all'); showBuildings=false; ivsmOverlay=false; prioOverlay=false; normOverlay=false; }
  if(n===5){ setColor('prioloc'); setPhase('all'); showBuildings=false; ivsmOverlay=false; prioOverlay=false; normOverlay=true; }
  // step 6: la vulnerabilità si legge senza i vincoli sull'impianto
  if(n===6){ setColor('vuln');    setPhase('all'); showBuildings=false; ivsmOverlay=true;  prioOverlay=false; normOverlay=false; }
  // step 7: nessun segnaposto — la sintesi è già tutta nel colore, i marker
  // (top produzione / top vulnerabilità) confondevano la lettura
  if(n===7){ setColor('prio');    setPhase('all'); showBuildings=false; ivsmOverlay=false; prioOverlay=false; normOverlay=false; }
  if(n===8 || n===9){ setColor('prio'); setPhase('all'); showBuildings=false; ivsmOverlay=false; prioOverlay=false; normOverlay=false; }
  ['btn-bld','btn-prio','btn-ivsm-ov'].forEach((id,k)=>{
    const el = document.getElementById(id);
    if(el) el.classList.toggle('active', [showBuildings, prioOverlay, ivsmOverlay][k]);
  });
  const hint = document.getElementById('phase-hint');
  if(hint) hint.innerHTML = {
    2: STEP_HINT[2] + ' <em>Le sezioni bloccate restano beneficiarie: il vincolo riguarda l\'impianto, non le persone.</em>',
    3: STEP_HINT[3],
    4: STEP_HINT[4],
    5: STEP_HINT[5],
    6: STEP_HINT[6] + ' <em>I contorni dei vincoli sono spenti: qui conta solo la fragilità sociale.</em>',
    7: STEP_HINT[7],
  }[n] || '';
  if(activeCabina){
    const c = DATA.cabine.find(x=>x.id===activeCabina);
    const sez = DATA.sezioni.filter(s=>s.cab===activeCabina);
    drawSezLayer(sez); drawBuildings(); buildSitiOttimali(c, sez);
    if(n>=5){ const el = document.getElementById('siti-ottimali');
              if(el) setTimeout(()=>el.scrollIntoView({behavior:'smooth', block:'start'}), 400); }
  }
}

// Accende/spegne i perimetri PAI sulla mappa città dai pulsanti dedicati
function togglePai(key, btn){
  if(!napoliMap || !napoliMap._pai || !napoliMap._pai[key]) return;
  const on = !napoliMap.hasLayer(napoliMap._pai[key]);
  setPai(napoliMap, key, on);
  if(btn) btn.classList.toggle('active', on);
}

// ---------- Granularità mappa città: cabine ↔ sezioni (tavola di piano) ----------
function setNapoliGran(g, btn){
  napoliGranularity = g;
  document.querySelectorAll('[data-napoli-gran]').forEach(b=>b.classList.remove('active'));
  if(btn) btn.classList.add('active');
  // "Copertura vuln." è un indicatore di cabina: in vista sezioni si passa a FER/IVSM
  const covBtn = document.querySelector('[data-napoli-color="cov"]');
  if(covBtn) covBtn.style.display = g==='sez' ? 'none' : '';
  if(g==='sez' && napoliColorMode==='cov'){
    napoliColorMode = hasFer() ? 'fer' : 'priorita';
    document.querySelectorAll('[data-napoli-color]').forEach(b=>b.classList.remove('active'));
    const nb = document.querySelector(`[data-napoli-color="${napoliColorMode}"]`);
    if(nb) nb.classList.add('active');
  }
  drawNapoli();
}

function drawNapoli(){
  if(napoliGranularity==='sez') drawNapoliSezioni();
  else drawNapoliCabine();
  drawCityBuildings();
}

// Colore per sezione nella tavola città
function getNapoliSezColor(s, mode, maxes){
  if(mode==='best'){
    // 🎯 Aree prioritarie: SOLO sezioni in area idonea, colorate per producibilità.
    // Tutto il resto si spegne → il messaggio è immediato anche per i non esperti.
    if(normStatus(s).code !== 'fac') return '#232936';
    const pv = normPv(s);
    return pv===null ? '#232936' : rampColor(COLORS_FV, pv/100);
  }
  if(mode==='mun'){
    return s.mun ? MUN_COLORS[(s.mun-1)%10] : '#232936';
  }
  if(mode==='ambiti' || mode==='top10'){
    const idx = ambitoDiSezione();
    const a = idx[s.id];
    if(a === undefined) return '#232936';
    if(mode==='top10') return a < 10 ? '#f97316' : '#3a3320';
    return '#facc15';
  }
  if(mode==='hiprod'){
    // Step 4 — le sezioni più produttive della città (indice > 60)
    return isHiProd(s) ? rampColor(COLORS_FV, prodIndex(s)/100) : '#232936';
  }
  if(mode==='prioloc'){
    // Step 5 — alta producibilità × area idonea: la localizzazione ottimale
    if(!isHiProd(s)) return '#232936';
    return isIdonea(s) ? '#facc15' : '#1f5bab';
  }
  if(mode==='prio'){
    // Step 7 — sintesi: offerta ottimale e domanda sociale.
    // Il viola distingue nettamente la vulnerabilità dal rosso dei vincoli normativi.
    const off = isSitoRapido(s);
    const vul = isVulnSec(s);
    if(off && vul) return '#f97316';   // entrambi → priorità massima
    if(off)        return '#facc15';   // solo offerta ottimale
    if(vul)        return '#a855f7';   // solo domanda sociale
    return '#232936';
  }
  if(mode==='cross'){
    // (compatibilità) intersezione idonee × producibilità normalizzata
    if(normStatus(s).code !== 'fac') return '#232936';
    const pv = normPv(s);
    if(pv===null) return '#232936';
    return pv >= crossThreshold() ? '#facc15' : '#1f5bab';
  }
  if(mode==='norm'){
    const st = normStatus(s);
    return st.code==='na' ? NORM_COLORS.na : st.color;
  }
  if(mode==='fer'){
    const fer = normFer(s);
    return fer===null ? NORM_COLORS.na : rampColor(COLORS_FER, fer/100);
  }
  if(mode==='cer'){
    const cab = DATA.cabine.find(c=>c.id===s.cab);
    return cab ? (CER_COLORS[cerConfig(cab)]||'#8b93a8') : '#8b93a8';
  }
  if(mode==='vuln'){
    const t = Math.sqrt(sezPV(s)/Math.max(maxes.pv,1));   // sqrt: distribuzione molto asimmetrica
    return rampColor(COLORS_VULN, t);
  }
  if(mode==='ivsm'){
    // Classi IVSM del quadro metodologico: <20 molto bassa … >80 molto alta
    if(!s.pop) return '#232936';
    return rampColor(COLORS_IVSM, (s.ivsm||0)/100);
  }
  if(mode==='fv'){
    const fv = s.fv_tot || 0;
    return rampColor(COLORS_FV, Math.sqrt(fv/Math.max(maxes.fv,1)));
  }
  // 'priorita' → IVSM della sezione
  return rampColor(COLORS_IVSM, (s.ivsm||0)/100);
}

// Tavola città per sezioni censuarie: 4.200+ poligoni su canvas + perimetri cabine
function drawNapoliSezioni(){
  if(!napoliMap) return;
  if(napoliLayer){ napoliMap.removeLayer(napoliLayer); napoliLayer=null; }
  const renderer = L.canvas({padding:0.3});
  const maxes = {
    pv: Math.max(...DATA.sezioni.map(s=>sezPV(s)), 1),
    fv: Math.max(...DATA.sezioni.map(s=>s.fv_tot||0), 1),
  };
  const features = DATA.sezioni.filter(s=>s.geom && s.geom.length>=3).map(s=>({
    type:'Feature', properties:{ id:s.id, cab:s.cab },
    geometry:{ type:'Polygon', coordinates:[s.geom] }
  }));
  const byId = {}; DATA.sezioni.forEach(s=>byId[s.id]=s);
  const sezGeo = L.geoJSON({type:'FeatureCollection',features}, {
    renderer,
    style: f => {
      const s = byId[f.properties.id];
      const st = hasNorm() ? normStatus(s).code : 'na';
      const blk = cityNormBorders && st === 'blk';
      const fac = cityNormBorders && st === 'fac';
      return { fillColor:getNapoliSezColor(s, napoliColorMode, maxes),
               color: blk ? '#ef4444' : fac ? '#22c55e' : 'rgba(255,255,255,.10)',
               weight: blk ? 0.9 : fac ? 0.9 : 0.3, fillOpacity: 0.8 };
    },
  });
  // Un solo tooltip e un solo handler per l'intero mosaico (5.000+ poligoni):
  // bindTooltip con funzione riceve il layer sotto il puntatore.
  sezGeo.bindTooltip(layer => {
    const s = byId[layer.feature.properties.id];
    const nst = normStatus(s), fer = normFer(s);
    return `
      <div style="font-family:DM Sans;font-size:11.5px;line-height:1.45">
        <strong>Sez. ${shortSez(s.id)}</strong> · cabina ${String(s.cab).replace('AC001E00','')}${s.empty?' · <span style="color:#8b93a8">non abitata</span>':''}<br>
        ${s.empty?'solo valutazione localizzativa':'IVSM <strong>'+s.ivsm+'</strong> · vuln (>'+THR+'): '+fmt(sezPV(s))+' · FV Σ '+fmt1(s.fv_tot||0)+' MWh'}${
        hasNorm() ? `<br><span style="color:${nst.color}">${nst.icon} ${nst.short}</span>${fer!==null?` · 🏆 FER ${fmt1(fer)}`:''}` : ''}${
        s.cab && s.cab!=='NONE' ? '<br><em style="color:#8b93a8">Click → drill-down cabina + zoom</em>' : ''}
      </div>`;
  }, {sticky:true, className:'leaflet-tooltip-custom'});
  sezGeo.on('click', e => {
    const s = byId[e.layer.feature.properties.id];
    if(s && s.cab && s.cab!=='NONE'){ openCabina(s.cab); setTimeout(()=>zoomSez(s.id), 650); }
  });
  // Perimetri delle cabine primarie sopra la tavola (unità legale di condivisione)
  const cabFeatures = DATA.cabine.filter(c=>c.rings && c.rings.length).map(c=>({
    type:'Feature', properties:{},
    geometry: c.rings.length===1 ? {type:'Polygon',coordinates:[c.rings[0]]}
                                 : {type:'MultiPolygon',coordinates:c.rings.map(r=>[r])}
  }));
  const boundary = L.geoJSON({type:'FeatureCollection',features:cabFeatures},
    {interactive:false, style:{fill:false, color:'#ffffff', weight:2, opacity:.9}});
  const labels = L.layerGroup(DATA.cabine.filter(c=>c.c).map(c=>{
    const ico = L.divIcon({className:'napoli-label',
      html:`<div style="font-family:'SF Mono',Menlo,monospace;font-size:10px;font-weight:700;color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.9);background:rgba(14,17,23,.55);padding:2px 5px;border-radius:4px;white-space:nowrap;border:1px solid rgba(255,255,255,.15)">${c.id.replace('AC001E00','')}</div>`,
      iconSize:[40,16], iconAnchor:[20,8]});
    return L.marker([c.c[1], c.c[0]], {icon:ico, interactive:false});
  }));
  napoliLayer = L.layerGroup([sezGeo, boundary, labels]).addTo(napoliMap);
  try{ napoliMap.fitBounds(sezGeo.getBounds(), {padding:[20,20]}); }catch(e){}
  updateNapoliLegend();
}

// ---------- Calcolo domanda energetica con filtro IVSM ----------
// cabId: null → tutta Napoli (vista home, ma calcolo conservato per consistenza)
//        '<id>' → cabina specifica
// VINCOLO NORMATIVO: il FV disponibile per i vulnerabili filtrati è SEMPRE
// il FV-ERP TOTALE della cabina (anche se filtriamo solo alcune sezioni per IVSM)
// perché i vulnerabili possono utilizzare l'energia prodotta in tutta la cabina.
function updateDemand(cabId){
  // le sezioni non abitate (mosaico display-only) non entrano nel calcolo domanda
  const sez = (cabId ? DATA.sezioni.filter(s=>s.cab===cabId) : DATA.sezioni).filter(s=>!s.empty);
  const sezTot = sez.length;
  const flt = sez.filter(s=>s.ivsm>=ivsmRange.lo && s.ivsm<=ivsmRange.hi);
  const popVuln = flt.reduce((a,s)=>a+s.pop_vuln, 0);
  const demandKwh = popVuln * params.cons_kwh;
  const demandMwh = demandKwh / 1000;

  // FV disponibile della FONTE SELEZIONATA: totale cabina (vincolo normativo CER:
  // l'energia condivisa è utilizzabile da tutti i membri sotto la stessa cabina)
  const srcLbl = SRC[fvSource].label;
  let fvAvail, fvBlk = 0;
  if(cabId){
    const cab = DATA.cabine.find(c=>c.id===cabId);
    fvAvail = cab ? cabFV(cab) : 0;
    if(cab && hasNorm()) fvBlk = cabFvBlk(cab);
  } else {
    fvAvail = DATA.cabine.reduce((a,c)=>a+cabFV(c), 0);
    if(hasNorm()) fvBlk = DATA.cabine.reduce((a,c)=>a+cabFvBlk(c), 0);
  }
  // Con layer normativo caricato la copertura usa solo il FV ATTIVABILE
  // (escluso quello in aree non idonee, bloccante per l'installazione)
  const fvUsable = Math.max(0, fvAvail - fvBlk);
  const cov = demandMwh>0 ? (fvUsable/demandMwh*100) : 0;

  const lbl = document.getElementById('d-cmp-lbl');
  if(lbl) lbl.textContent = cabId
      ? `FV ${srcLbl} totale della cabina`
      : `FV ${srcLbl} totale di Napoli`;

  document.getElementById('d-sez-flt').textContent = fmt(flt.length);
  const sezSubEl = document.getElementById('d-sez-flt-sub');
  if(sezSubEl) sezSubEl.textContent = `su ${fmt(sezTot)} totali della cabina`;
  document.getElementById('d-pop-flt').textContent = fmt(popVuln);

  document.getElementById('d-demand').innerHTML = demandMwh>=1000
    ? (demandMwh/1000).toFixed(2)+' <span style="font-size:14px;color:var(--text-muted)">GWh/a</span>'
    : fmt1(demandMwh)+' <span style="font-size:14px;color:var(--text-muted)">MWh/a</span>';
  const demandSub = document.getElementById('d-demand-sub');
  if(demandSub) demandSub.textContent = `${fmt(popVuln)} pers. × ${fmt(params.cons_kwh)} kWh · IVSM ${ivsmRange.lo}–${ivsmRange.hi}`;

  const fvLblEl = document.querySelector('#d-fv-avail') && document.querySelector('#d-fv-avail').previousElementSibling;
  if(fvLblEl) fvLblEl.textContent = hasNorm() ? `FV ${srcLbl} attivabile` : `FV ${srcLbl} cabina`;
  document.getElementById('d-fv-avail').textContent = fmtEnergy(fvUsable);
  const normEl = document.getElementById('d-fv-norm');
  if(normEl){
    normEl.style.display = hasNorm() && fvBlk>0 ? 'block' : 'none';
    if(hasNorm() && fvBlk>0) normEl.innerHTML = `🚫 esclusi <strong style="color:#f87171">${fmtEnergy(fvBlk)}</strong> in aree non idonee (DM 21/06/2024)`;
  }
  document.getElementById('d-cov').textContent = demandMwh>0 ? cov.toFixed(2)+'%' : '—';
  document.getElementById('d-cov').style.color = cov>=100 ? 'var(--success)' : cov>=50 ? 'var(--warning)' : 'var(--danger)';
  document.getElementById('d-balance').textContent = cov>=100 ? '✅ FV sufficiente' : cov>=50 ? '⚠️ Copertura parziale' : '❌ FV insufficiente';
}

function updateIvsmRange(){
  const loEl = document.getElementById('ivsm-range-lo');
  const hiEl = document.getElementById('ivsm-range-hi');
  let lo = parseInt(loEl.value);
  let hi = parseInt(hiEl.value);
  if(lo > hi){ [lo, hi] = [hi, lo]; loEl.value = lo; hiEl.value = hi; }
  ivsmRange.lo = lo; ivsmRange.hi = hi;
  document.getElementById('ivsm-lo').textContent = lo;
  document.getElementById('ivsm-hi').textContent = hi;
  const track = document.getElementById('ivsm-track');
  track.style.left = lo+'%';
  track.style.width = (hi-lo)+'%';
  updateDemand(activeCabina);
}

// ---------- Drill-down cabina ----------
function openCabina(id){
  activeCabina = id;
  const c = DATA.cabine.find(x=>x.id===id);
  if(!c) return;
  document.getElementById('view-comune').style.display='none';
  document.getElementById('view-cabina').style.display='block';
  document.getElementById('sidebar-title').textContent = 'Cabina selezionata';
  buildSidebar();

  const v = cabPrio(c);
  document.getElementById('detail-id').textContent = c.id;
  document.getElementById('detail-sub').textContent = `${fmt(c.pop_tot)} abitanti · ${fmt(cabPopVuln(c))} vulnerabili (IVSM>${THR}) · ${fmt(c.sez_count)} sezioni · IVSM medio ${c.ivsm_avg} · ${c.area_km2} km²`;
  document.getElementById('detail-badge').className = 'badge '+v.cls;
  document.getElementById('detail-badge').textContent = `Priorità ${v.tier} · ${v.label} (${fmt(cabPopVuln(c))} vuln.)`;

  updateDemand(c.id);

  // metriche
  document.getElementById('m-pop').textContent = fmt(c.pop_tot);
  document.getElementById('m-pop-sub').textContent = `Densità ~${fmt(Math.round(c.pop_tot/c.sez_count))} ab./sez.`;
  updateVulnMetric(c);
  document.getElementById('m-erp').textContent = fmt(c.erp_buildings);
  document.getElementById('m-erp-sub').textContent = fmt(c.sup_erp_m2)+' m² tetti';
  updateFvMetric(c);

  // profilo
  document.getElementById('d-sez').textContent = fmt(c.sez_count);
  document.getElementById('d-p1zero').textContent = fmt(c.sez_p1_zero);
  document.getElementById('d-erp').textContent = fmt(c.erp_buildings);
  document.getElementById('d-sup').textContent = fmt(c.sup_erp_m2)+' m²';
  document.getElementById('d-ivsm').textContent = c.ivsm_avg;
  document.getElementById('d-consumo').textContent = (c.cons_tot_mwh/1000).toFixed(1)+' GWh/a';

  // Bilancio CER
  const cop = c.cov_vuln_pct;
  document.getElementById('fv-copertura').textContent = cop+'%';
  document.getElementById('fv-bar').style.width = Math.min(100,cop)+'%';
  document.getElementById('fv-vuln-mwh').textContent = fmt(c.fv_to_vuln_mwh)+' MWh';
  document.getElementById('fv-nonvuln-mwh').textContent = fmt(c.fv_to_nonvuln_mwh)+' MWh';
  document.getElementById('fv-res-mwh').textContent = fmt(c.fv_residual_mwh)+' MWh';
  const consMwh = params.cons_kwh / 1000;
  const persSat = Math.round(c.fv_to_vuln_mwh / consMwh);
  document.getElementById('fv-vuln-pers').textContent = fmt(Math.min(persSat, c.pop_vuln))+' / '+fmt(c.pop_vuln);
  document.getElementById('fv-co2').textContent = fmt(Math.round(c.fv_erp_mwh*0.33))+' t/a';

  const sezOfCab = DATA.sezioni.filter(s=>s.cab===id);
  const sezPrio = sezOfCab.filter(s=>s.priorita>0).length;
  document.getElementById('fv-prio').textContent = fmt(sezPrio);

  buildCerCard(c);
  buildSrcBalance(c);
  buildTopFV(c, sezOfCab);
  buildTopVuln(c, sezOfCab);
  buildTopMatch(c, sezOfCab);
  buildDovePerChi(c, sezOfCab);
  buildSitiOttimali(c, sezOfCab);

  // Mappa sezioni — si apre sempre allo step 2 (aree idonee), poi si avanza
  setTimeout(()=>{ initMap(c, sezOfCab);
    setCabStep(cabStep, document.querySelector(`[data-cabstep="${cabStep}"]`)); }, 50);

  buildRecommendation(c, sezOfCab);

  window.scrollTo({top:0, behavior:'smooth'});
}

function updateFvMetric(c){
  const m = SRC[fvSource];
  document.getElementById('m-fv-lbl').textContent = `Potenziale FV · ${m.label}`;
  document.getElementById('m-fv').textContent = fmt(Math.round(m.cabFv(c)));
  document.getElementById('m-fv-sub').textContent =
    `MWh/a · ERP ${fmt(Math.round(c.fv_erp_mwh))} · Pubbl. ${fmt(Math.round(c.fv_pub_mwh||0))} · Ind. ${fmt(Math.round(c.fv_ind_mwh||0))}`;
}

// ---------- Selettore fonte FV ----------
function setFvSource(s, btn){
  fvSource = s;
  document.querySelectorAll('.src-btn').forEach(b=>b.classList.remove('active'));
  if(btn) btn.classList.add('active');
  if(!activeCabina) return;
  const c = DATA.cabine.find(x=>x.id===activeCabina);
  const sez = DATA.sezioni.filter(x=>x.cab===activeCabina);
  updateFvMetric(c);
  updateDemand(activeCabina);
  buildTopFV(c, sez);
  buildTopMatch(c, sez);
  buildDovePerChi(c, sez);
  buildSitiOttimali(c, sez);
  drawSezLayer(sez);
  buildRecommendation(c, sez);
}

function setThr(t, btn){
  THR = t;
  _prioBreaks = {};   // i tier C1/C2/C3 dipendono dalla soglia → ricalcola Jenks
  document.querySelectorAll('.thr-btn').forEach(b=>b.classList.remove('active'));
  if(btn) btn.classList.add('active');
  buildAlertHighIvsm();
  buildSidebar();
  buildTable();
  if(napoliMap) drawNapoli();
  if(activeCabina){
    const c = DATA.cabine.find(x=>x.id===activeCabina);
    const sez = DATA.sezioni.filter(x=>x.cab===activeCabina);
    buildCerCard(c);
    buildSrcBalance(c);
    buildTopVuln(c, sez);
    buildTopFV(c, sez);
    buildTopMatch(c, sez);
    buildDovePerChi(c, sez);
    buildSitiOttimali(c, sez);
    drawSezLayer(sez);
    updateVulnMetric(c);
    buildRecommendation(c, sez);
  }
}

function updateVulnMetric(c){
  const t = cabTHR(c);
  document.getElementById('m-vuln').textContent = fmt(t.pop_vuln || c.pop_vuln);
  document.getElementById('m-vuln-pct').textContent =
    `IVSM > ${THR} · ${c.pop_tot>0 ? ((t.pop_vuln||c.pop_vuln)/c.pop_tot*100).toFixed(1) : 0}% del totale`;
}

// ---------- Scheda "CER consigliata" (logica v5) ----------
function buildCerCard(c){
  const el = document.getElementById('cer-card');
  if(!el) return;
  const cf = cerConfig(c), fe = feasib(c), col = CER_COLORS[cf] || '#8b93a8';
  const t = cabTHR(c);
  const tot = c.fv_tot_mwh || 1;
  const seg = (v,color) => `<div style="height:100%;width:${(v/tot*100).toFixed(1)}%;background:${color}"></div>`;
  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">
      <div>
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-faint);font-weight:700;margin-bottom:4px">⚡ Configurazione CER consigliata</div>
        <div style="font-family:var(--font-display);font-size:22px;color:${col}">${cf}</div>
      </div>
      <span class="feas-badge ${fe.cls}" style="color:${fe.color};border-color:${fe.color}55">● ${fe.lbl} <span style="opacity:.7">(IVSM>${THR})</span></span>
    </div>
    <div style="font-size:12.5px;color:var(--text-muted);line-height:1.55;margin:8px 0 10px">${cerDesc(c)}</div>
    <div style="display:flex;height:10px;border-radius:99px;overflow:hidden;background:var(--surface3)">
      ${seg(c.fv_erp_mwh,'#2db885')}${seg(c.fv_pub_mwh,'#58a6ff')}${seg(c.fv_ind_mwh,'#e3b341')}
    </div>
    <div style="display:flex;gap:14px;margin-top:6px;font-size:11px;color:var(--text-muted);flex-wrap:wrap">
      <span><span style="color:#2db885">■</span> ERP ${fmt(Math.round(c.fv_erp_mwh))} MWh (${(c.fv_erp_mwh/tot*100).toFixed(0)}%)</span>
      <span><span style="color:#58a6ff">■</span> Pubblico ${fmt(Math.round(c.fv_pub_mwh))} MWh (${(c.fv_pub_mwh/tot*100).toFixed(0)}%)</span>
      <span><span style="color:#e3b341">■</span> Industriale ${fmt(Math.round(c.fv_ind_mwh))} MWh (${(c.fv_ind_mwh/tot*100).toFixed(0)}%)</span>
    </div>` + buildCabNormStrip(c);
}

// Striscia normativa nella card CER: quanto FV della cabina è bloccato da aree non idonee
function buildCabNormStrip(c){
  if(!hasNorm()) return '';
  const n = cabNorm(c);
  const col = n.pctFvBlk>=25?'#ef4444':n.pctFvBlk>=10?'#fbbf24':'#22c55e';
  return `
    <div style="margin-top:10px;padding:10px 12px;border-radius:10px;background:rgba(239,68,68,${n.pctFvBlk>=10?'.07':'.03'});border:1px solid ${col}33;font-size:11.5px;line-height:1.5;color:var(--text-muted)">
      ⚖️ <strong>Filtro normativo (DM 21/06/2024):</strong>
      <strong style="color:${col}">${fmt1(n.pctFvBlk)}%</strong> del potenziale FV della cabina ricade in <strong>aree non idonee</strong>
      (${fmt(n.nBlk)} sezioni bloccate su ${fmt(n.nSez)} · ${fmt(Math.round(n.fvBlk.tot))} MWh/a non attivabili in via prioritaria).
      Sezioni facilitate in area idonea: <strong style="color:#22c55e">${fmt(n.nFac)}</strong> — iter semplificato.
    </div>`;
}

// ---------- Bilancio per fonte alla soglia selezionata (dati v5) ----------
function buildSrcBalance(c){
  const el = document.getElementById('src-balance');
  if(!el) return;
  const t = cabTHR(c);
  const row = (icon, name, cov, sat, res, color) => `
    <div style="margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px">
        <span style="font-weight:600">${icon} ${name}</span>
        <span style="font-weight:700;color:${color}">${Math.min(100,Math.round(cov||0))}% copertura</span>
      </div>
      <div style="height:9px;border-radius:99px;background:var(--surface3);overflow:hidden">
        <div style="height:100%;width:${Math.min(100,cov||0)}%;background:${color};border-radius:99px"></div>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-muted);margin-top:3px">
        <span>${fmt(sat||0)} pers. soddisfatte</span>
        <span>surplus ${fmtEnergy(Math.max(0,res||0))}</span>
      </div>
    </div>`;
  el.innerHTML = `
    <div class="row-data" style="margin-bottom:10px"><span class="row-label">Pers. vulnerabili (IVSM>${THR})</span><span class="row-value" style="color:var(--warning);font-weight:700">${fmt(t.pop_vuln||0)}</span></div>
    <div class="row-data" style="margin-bottom:12px"><span class="row-label">Consumo vulnerabile</span><span class="row-value">${fmtEnergy(t.cons_vuln||0)}</span></div>
    ${row('🏠','ERP', t.cov_erp, t.sat_erp, t.res_erp, '#2db885')}
    ${row('🏛','Pubblici', t.cov_pub, t.sat_pub, t.res_pub, '#58a6ff')}
    ${row('🏭','Industriali', t.cov_ind, t.sat_ind, t.res_ind, '#e3b341')}`;
}

function togglePrio(btn){
  prioOverlay = !prioOverlay;
  btn.classList.toggle('active', prioOverlay);
  if(activeCabina){
    drawSezLayer(DATA.sezioni.filter(s=>s.cab===activeCabina));
  }
}
function toggleNorm(btn){
  normOverlay = !normOverlay;
  btn.classList.toggle('active', normOverlay);
  if(activeCabina){
    drawSezLayer(DATA.sezioni.filter(s=>s.cab===activeCabina));
  }
}

// ---------- Fasi del percorso normativo (mappa cabina) ----------
function setNormPhase(p, btn){
  normPhase = p;
  document.querySelectorAll('[data-phase]').forEach(b=>b.classList.remove('active'));
  if(btn) btn.classList.add('active');
  // la fase "interseca" implica la lettura per FER_100
  if(p==='cross' && hasFer() && mapColorMode!=='fer'){
    mapColorMode = 'fer';
    document.querySelectorAll('#view-cabina .map-toolbar [data-color]').forEach(b=>b.classList.remove('active'));
    const fb = document.querySelector('#view-cabina [data-color="fer"]');
    if(fb) fb.classList.add('active');
  }
  const hint = document.getElementById('phase-hint');
  if(hint){
    hint.innerHTML = {
      all:  'Quadro completo della cabina: tutte le sezioni, nessun filtro normativo applicato alla visualizzazione.',
      excl: '① <strong style="color:#f87171">Esclusione</strong> — le sezioni in area <strong>non idonea</strong> si spengono: qui l\'impianto non è localizzabile (DM 21/06/2024). Restano in gioco idonee e ordinarie.',
      idon: '② <strong style="color:#22c55e">Aree idonee in evidenza</strong> — le sezioni con procedura semplificata sono accese e bordate di verde; le ordinarie restano sullo sfondo come alternativa ammissibile.',
      cross:'③ <strong style="color:#facc15">Intersezione idonee × producibilità</strong> — le sezioni ammissibili sono colorate per <strong>FER_100 (CER_OFFER_100)</strong>: le più dorate sono le <strong>sezioni prioritarie per l\'installazione</strong>.',
    }[p] || '';
    if(ivsmOverlay) hint.innerHTML += ' <span style="color:#fb923c">④ 👥 IVSM attivo: il bordo arancione segna le sezioni vulnerabili — <em>per chi</em> si produce.</span>';
  }
  if(activeCabina) drawSezLayer(DATA.sezioni.filter(s=>s.cab===activeCabina));
}
function toggleIvsmOverlay(btn){
  ivsmOverlay = !ivsmOverlay;
  if(btn) btn.classList.toggle('active', ivsmOverlay);
  setNormPhase(normPhase, document.querySelector(`[data-phase="${normPhase}"]`));
  if(activeCabina){
    const c = DATA.cabine.find(x=>x.id===activeCabina);
    buildSitiOttimali(c, DATA.sezioni.filter(s=>s.cab===activeCabina));
  }
}
// La sezione ha popolazione vulnerabile rilevante alla soglia corrente?
const isVulnSez = s => sezPV(s) > 0 && (s.ivsm||0) >= THR;

// ---------- Priorità CER: top FV / top vulnerabilità / nuclei ----------
// FILTRO NORMATIVO (DM 21/06/2024): le sezioni in area prevalentemente NON idonea
// sono BLOCCANTI per l'installazione → escluse dal ranking "DOVE" e dai nuclei.
// Il ranking "PER CHI" (vulnerabilità/IVSM) NON è filtrato: i residenti restano
// beneficiari della CER a prescindere dalla classe normativa della loro sezione.
function computePrio(sez){
  const instOk = s => !isBlocked(s);   // sempre true se layer normativo non caricato
  const byFV   = [...sez].filter(s=>sezFV(s)>0 && instOk(s)).sort((a,b)=>sezFV(b)-sezFV(a));
  const byVuln = [...sez].filter(s=>sezPV(s)>0).sort((a,b)=>sezPV(b)-sezPV(a));
  const blockedFV = hasNorm() ? sez.filter(s=>sezFV(s)>0 && isBlocked(s)) : [];
  const fvBlockedMwh = blockedFV.reduce((a,s)=>a+sezFV(s),0);
  const topFV5   = byFV.slice(0,5);
  const topVuln5 = byVuln.slice(0,5);
  const fv10   = new Set(byFV.slice(0,10).map(s=>s.id));
  const vuln10 = new Set(byVuln.slice(0,10).map(s=>s.id));
  // Nucleo = sezione in top-10 per ENTRAMBE le dimensioni → installa qui, per questi
  // (solo sezioni normativamente attivabili: un nucleo in area non idonea non è credibile)
  const nuclei = sez.filter(s=>fv10.has(s.id) && vuln10.has(s.id) && instOk(s))
                    .sort((a,b)=>(sezFV(b)*b.pop_vuln)-(sezFV(a)*a.pop_vuln));
  return {
    topFV5, topVuln5, nuclei, blockedFV, fvBlockedMwh,
    fvSet: new Set(topFV5.map(s=>s.id)),
    vulnSet: new Set(topVuln5.map(s=>s.id)),
    nucleoSet: new Set(nuclei.map(s=>s.id)),
    blkSet: new Set(blockedFV.map(s=>s.id)),
  };
}

// ---------- Pannello "Dove installare · Per chi" ----------
function buildDovePerChi(c, sez){
  const pr = computePrio(sez);
  const m = SRC[fvSource];
  document.getElementById('dove-sub').textContent = `Fonte: ${m.label} · click per zoom sulla sezione`;

  const doveEl = document.getElementById('dove-list');
  doveEl.innerHTML = (pr.topFV5.map((s,i)=>{
    const star = pr.nucleoSet.has(s.id);
    const kwp = kwpFromMwh(sezFV(s));
    const ns = normStatus(s);
    const ferV = normFer(s);
    const normTag = hasNorm() ? ` · <span style="color:${ns.color}">${ns.icon} ${ns.short}</span>${ferV!==null?` · <span style="color:#facc15">🏆 ${fmt1(ferV)}</span>`:''}` : '';
    return `<div class="prio-item${star?' is-nucleo':''}" onclick="zoomSez('${s.id}')">
      <span class="prio-rank">${i+1}</span>
      <span class="prio-main">
        <span class="prio-id">${star?'⭐ ':''}${shortSez(s.id)}</span>
        <div class="prio-meta">${m.icon} ${fmt(m.b(s))} edifici · ${fmt(Math.round(m.sup(s)))} m² tetto · ~${fmt(Math.round(kwp))} kWp${normTag}</div>
      </span>
      <span class="prio-val">${fmt1(sezFV(s))}<br><span style="font-size:10px;font-weight:400;color:var(--text-faint)">MWh/a</span></span>
    </div>`;
  }).join('') || '<div class="prio-empty">Nessuna sezione con FV > 0 per questa fonte</div>')
  + (hasNorm() && pr.blockedFV.length ? `
    <div style="margin-top:8px;padding:9px 11px;border-radius:10px;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.3);font-size:11.5px;line-height:1.5;color:var(--text-muted)">
      🚫 <strong style="color:#f87171">${fmt(pr.blockedFV.length)} sezioni escluse dal ranking</strong> perché in area prevalentemente <strong>non idonea</strong> (DM 21/06/2024): ${fmt1(pr.fvBlockedMwh)} MWh/a di potenziale ${m.label} qui non attivabile in via prioritaria. I residenti restano beneficiari CER.
    </div>` : '');

  const chiEl = document.getElementById('perchi-list');
  chiEl.innerHTML = pr.topVuln5.map((s,i)=>{
    const star = pr.nucleoSet.has(s.id);
    const pct = s.pop>0 ? (sezPV(s)/s.pop*100).toFixed(1)+'%' : '—';
    return `<div class="prio-item${star?' is-nucleo':''}" onclick="zoomSez('${s.id}')">
      <span class="prio-rank">${i+1}</span>
      <span class="prio-main">
        <span class="prio-id">${star?'⭐ ':''}${shortSez(s.id)}</span>
        <div class="prio-meta">IVSM ${s.ivsm} · ${pct} della sezione · ${fmt(s.fam)} famiglie</div>
      </span>
      <span class="prio-val">${fmt(sezPV(s))}<br><span style="font-size:10px;font-weight:400;color:var(--text-faint)">vuln. >${THR}</span></span>
    </div>`;
  }).join('') || '<div class="prio-empty">Nessuna popolazione vulnerabile registrata</div>';

  const box = document.getElementById('nucleo-box');
  if(pr.nuclei.length){
    const links = pr.nuclei.slice(0,4).map(s=>
      `<span class="sez-id" onclick="zoomSez('${s.id}')">${shortSez(s.id)}</span> (${fmt1(sezFV(s))} MWh · ${fmt(sezPV(s))} vuln.)`
    ).join(' · ');
    box.style.display='block';
    box.innerHTML = `⭐ <strong>Nuclei di avvio consigliati</strong> — sezioni contemporaneamente in top-10 per produzione FV ${m.label} <em>e</em> per popolazione vulnerabile: qui la CER produce dove serve. ${links}`;
  } else {
    box.style.display='block';
    box.innerHTML = `⭐ <strong>Nessun nucleo diretto</strong> — in questa cabina le sezioni ad alta produzione ${m.label} non coincidono con quelle più vulnerabili. La CER dovrà <strong>trasferire l'energia dentro la cabina</strong>: installazione nelle sezioni ☀️ a sinistra, beneficiari nelle sezioni 👥 a destra (consentito dal perimetro di cabina primaria).`;
  }
}

// ---------- 🏆 Siti ottimali: graduatoria tecnico-normativa FER_100 ----------
// Risponde a: "nelle aree idonee, dove si produce di più?" — classifica le sezioni
// per FER_100 = (N_s + S_s)/2 (paper, Sez. 3.2), escludendo le bloccate.
function buildSitiOttimali(c, sez){
  const wrap = document.getElementById('siti-ottimali');
  if(!wrap) return;
  if(!hasFer()){ wrap.style.display='none'; return; }
  wrap.style.display='block';
  // Il ranking usa FER_100 (baseline urbana: S_s dal DSM su TUTTO l'edificato);
  // il FV mostrato è il Σ delle 3 fonti censite — se 0, la sezione resta attivabile
  // tramite prosumer privati (tetti residenziali non ERP/pubblici/industriali).
  const fvT = s => s.fv_tot || (s.fv_mwh||0)+(s.fv_pub||0)+(s.fv_ind||0);
  const cand = sez.filter(s=>normFer(s)!==null && !isBlocked(s))
                  .sort((a,b)=>normFer(b)-normFer(a) || fvT(b)-fvT(a));
  const top = cand.slice(0,8);
  const excl = sez.filter(s=>normFer(s)!==null && isBlocked(s) && normFer(s)>= (top.length? normFer(top[top.length-1]) : 0)).length;
  const n = cabNorm(c);
  const medal = i => i===0?'🥇':i===1?'🥈':i===2?'🥉':`<span style="opacity:.75">${i+1}</span>`;
  const rows = top.map((s,i)=>{
    const st = normStatus(s), fer = normFer(s), pv = normPv(s), ns = normNs(s);
    const ft = fvT(s), kwp = kwpFromMwh(ft);
    const fvTxt = ft>0
      ? `Σ ${fmt1(ft)} MWh/a · ~${fmt(Math.round(kwp))} kWp`
      : (s.empty ? `<em>sezione non abitata — sito impianto puro (cave/industriale/infrastrutture)</em>`
                 : `<span style="color:#fbbf24">⚠ produzione su edificato privato — tetti non censiti nell'SSD</span>`);
    const vTag = ivsmOverlay
      ? (sezPV(s)>0
          ? `<span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:99px;background:rgba(251,146,60,.18);color:#fb923c;border:1px solid rgba(251,146,60,.45)">👥 ${fmt(sezPV(s))} vuln. · IVSM ${s.ivsm}</span>`
          : `<span style="font-size:10px;padding:2px 8px;border-radius:99px;background:var(--surface3);color:var(--text-faint)">nessun vulnerabile in sezione</span>`)
      : '';
    return `
    <div class="sito-row" onclick="zoomSez('${s.id}')">
      <div class="sito-rank">${medal(i)}</div>
      <div class="sito-main">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span class="prio-id">${shortSez(s.id)}</span>
          <span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:99px;background:${st.color}22;color:${st.color};border:1px solid ${st.color}55">${st.icon} ${st.short}</span>
          ${vTag}
        </div>
        <div class="prio-meta">N<sub>s</sub> ${fmt1(ns)} · S<sub>s</sub> ${pv!==null?fmt1(pv):'—'} · ${fvTxt}</div>
        <div class="fer-bar"><div class="fer-bar-fill" style="width:${Math.min(100,fer)}%"></div></div>
      </div>
      <div class="sito-score">${fmt1(fer)}<div style="font-size:9px;font-weight:400;color:var(--text-faint);letter-spacing:.05em">FER_100</div></div>
    </div>`;
  }).join('');
  const nGap = top.filter(s=>fvT(s)===0 && !s.empty).length;
  wrap.innerHTML = `
    <div class="section-title">🏆 Sezioni prioritarie per l'installazione — esito del percorso normativo</div>
    <div class="panel" style="border-top:3px solid #facc15">
      <div class="panel-header" style="flex-wrap:wrap;gap:8px">
        <div>
          <div class="panel-title">FER_100 = (N<sub>s</sub> + S<sub>s</sub>)/2 · campo GIS <strong>CER_OFFER_100</strong></div>
          <div class="table-sub">Esito di: esclusione aree non idonee → evidenza aree idonee → intersezione con la producibilità. ${ivsmOverlay?'👥 Spunta IVSM attiva: accanto a ogni sito trovi <em>per chi</em> si produce.':'Attiva “④ 👥 Spunta IVSM” sopra la mappa per vedere anche <em>per chi</em>.'} Click per zoom.</div>
        </div>
        <div style="display:flex;gap:14px;font-size:11.5px;color:var(--text-muted);align-items:center">
          <span>FER medio cabina <strong style="color:#facc15;font-size:15px">${n.ferAvg!==null?fmt1(n.ferAvg):'—'}</strong></span>
          <span>✅ idonee <strong style="color:#22c55e">${fmt(n.nFac)}</strong></span>
          <span>🚫 bloccate <strong style="color:#f87171">${fmt(n.nBlk)}</strong></span>
        </div>
      </div>
      <div class="panel-body" style="padding:10px 14px">
        ${rows || '<div class="prio-empty">Nessuna sezione con FER_100 disponibile in questa cabina</div>'}
        ${excl>0?`<div style="font-size:11px;color:var(--text-muted);padding:8px 4px 2px">🚫 ${fmt(excl)} sezioni con FER_100 comparabile escluse perché in area prevalentemente non idonea (vincolo DM 21/06/2024).</div>`:''}
        ${nGap>0?`<div style="font-size:11px;color:var(--text-muted);padding:6px 4px 2px;line-height:1.5">⚠ ${fmt(nGap)} di questi siti hanno <strong>S<sub>s</sub> alto ma nessun tetto censito</strong>: la producibilità viene dal DSM sull'intero edificato, mentre l'SSD contabilizza in MWh solo ERP, pubblico e industriale. Sono sezioni da attivare con <strong>prosumer residenziali privati</strong> — caricando il layer degli edifici residenziali diventerebbero quantificabili anche in MWh.</div>`:''}
        <div style="font-size:10.5px;color:var(--text-faint);padding:6px 4px 0;line-height:1.5">Metodologia: N<sub>s</sub> = eleggibilità normativa (pesi 1 · 0,5 · 0 per aree idonee · ordinarie · non idonee, DM 21/06/2024); S<sub>s</sub> = produzione FV normalizzata 0-100 dell'<strong>intero edificato</strong> (radiazione da DSM); media semplice come da framework FER_100 del paper — nel progetto ArcGIS il valore corrisponde al campo <strong>CER_OFFER_100</strong>. Il Σ MWh/a indica i soli tetti censiti ERP/pubblici/industriali.</div>
      </div>
    </div>`;
}

// Zoom su una sezione dalla lista / tabelle
function zoomSez(id){
  const s = DATA.sezioni.find(x=>x.id==id || x.id==Number(id));
  if(!s) return;
  if(map && s.c && s.c.length===2){
    map.flyTo([s.c[1], s.c[0]], 16, {duration:.8});
  }
  openSezPopup(id);
}

// Funzione utility per tornare alla home Napoli dalla cabina (futuro)
function backToNapoli(){
  document.getElementById('view-cabina').style.display='none';
  document.getElementById('view-comune').style.display='block';
  document.getElementById('sidebar-title').textContent = 'Seleziona cabina primaria';
  activeCabina = null;
  if(map){ map.remove(); map=null; }
  buildSidebar();
  setTimeout(()=>{
    if(napoliMap){ napoliMap.invalidateSize(); }
    else { buildNapoliMap(); }
  }, 50);
  window.scrollTo({top:0, behavior:'smooth'});
}

// ---------- Top tables ----------
function buildTopFV(c, sez){
  const tb = document.getElementById('top-fv-body');
  const m = SRC[fvSource];
  const pr = computePrio(sez);
  // Le sezioni bloccate (aree non idonee) escono dalla top-10 installabile
  const top = sez.filter(s=>sezFV(s)>0 && !isBlocked(s)).sort((a,b)=>sezFV(b)-sezFV(a)).slice(0,10);
  let html = top.map(s=>{
    const ns = normStatus(s);
    return `
    <tr onclick="zoomSez('${s.id}')">
      <td><span class="sez-id">${pr.nucleoSet.has(s.id)?'⭐ ':''}${shortSez(s.id)}</span>${hasNorm()&&ns.code==='fac'?' <span title="Area idonea — iter semplificato">✅</span>':''}</td>
      <td class="num">${fmt1(sezFV(s))}</td>
      <td class="num">${fmt(m.b(s))}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="3" style="color:var(--text-muted);text-align:center;padding:14px">Nessuna sezione con FV ${m.label} &gt; 0 in questa cabina</td></tr>`;
  if(hasNorm() && pr.blockedFV.length){
    html += `<tr><td colspan="3" style="font-size:11px;color:#f87171;background:rgba(239,68,68,.06);text-align:center">🚫 ${fmt(pr.blockedFV.length)} sezioni con FV in aree non idonee escluse (${fmt1(pr.fvBlockedMwh)} MWh/a bloccati)</td></tr>`;
  }
  tb.innerHTML = html;
}
function buildTopVuln(c, sez){
  const tb = document.getElementById('top-vuln-body');
  const pr = computePrio(sez);
  const top = sez.filter(s=>sezPV(s)>0).sort((a,b)=>sezPV(b)-sezPV(a)).slice(0,10);
  tb.innerHTML = top.map(s=>`
    <tr onclick="zoomSez('${s.id}')">
      <td><span class="sez-id">${pr.nucleoSet.has(s.id)?'⭐ ':''}${shortSez(s.id)}</span></td>
      <td class="num">${fmt(sezPV(s))}</td>
      <td class="num">${s.pop>0?((sezPV(s)/s.pop*100).toFixed(1)+'%'):'—'}</td>
    </tr>`).join('') || '<tr><td colspan="3" style="color:var(--text-muted);text-align:center;padding:14px">Nessuna sezione con popolazione vulnerabile registrata</td></tr>';
}
function buildTopMatch(c, sez){
  const tb = document.getElementById('top-match-body');
  const maxFV = Math.max(...sez.map(s=>sezFV(s)), 1);
  const maxVuln = Math.max(...sez.map(s=>sezPV(s)), 1);
  // Il match "installa qui, per questi" si azzera nelle sezioni bloccate:
  // lì l'impianto non si può localizzare in via prioritaria (l'IVSM resta invariato).
  sez.forEach(s => s._match = isBlocked(s) ? 0 : (sezFV(s)/maxFV) * (sezPV(s)/maxVuln) * 100);
  const top = sez.filter(s=>s._match>0).sort((a,b)=>b._match-a._match).slice(0,12);
  tb.innerHTML = top.map(s=>{
    const v = getVulnLabel(s.pop>0?(s.pop_vuln/s.pop*100):0);
    const ns = normStatus(s);
    return `<tr onclick="zoomSez('${s.id}')">
      <td><span class="sez-id">${shortSez(s.id)}</span>${hasNorm()&&ns.code==='fac'?' <span title="Area idonea — iter semplificato">✅</span>':''}</td>
      <td><span class="match-bar"><span class="match-bar-fill" style="width:${Math.min(100,s._match)}%"></span></span><span style="font-variant-numeric:tabular-nums">${s._match.toFixed(1)}</span></td>
      <td class="num">${fmt1(sezFV(s))}</td>
      <td class="num">${fmt(sezPV(s))}</td>
      <td class="num">${s.ivsm}</td>
      <td class="num">${s.pop>0?((s.pop_vuln/s.pop*100).toFixed(1)+'%'):'—'}</td>
      <td><span class="badge ${v.cls}">${s.cer_class||v.label}</span></td>
    </tr>`;
  }).join('') || '<tr><td colspan="7" style="color:var(--text-muted);text-align:center;padding:14px">Nessuna sezione con match FV ↔ Vulnerabilità in questa cabina</td></tr>';
}

function shortSez(id){
  if(!id) return '—';
  const s = String(id);
  return s.length>8 ? '…'+s.slice(-8) : s;
}

// ---------- Mappa Leaflet (sezioni cabina) ----------
const COLORS_MATCH = ['#1e2535','#4338ca','#7c3aed','#c026d3','#ec4899','#ef4444'];
// Energia producibile: rampa sequenziale bianco → blu scuro.
// I valori massimi restano i più saturi e si staccano nettamente dallo sfondo.
const COLORS_FV    = ['#f4f9ff','#c9def3','#93bfe4','#528fcd','#1f5bab','#0a2f75'];
const COLORS_VULN  = ['#1e2535','#7c2d12','#ea580c','#f97316','#fb923c','#fbbf24'];
const COLORS_IVSM  = ['#1e2535','#1d4ed8','#3b82f6','#fbbf24','#f97316','#ef4444'];
// FER_100 (tecnica×normativa): notte → oro, stile tavola di piano "idoneità localizzativa"
const COLORS_FER   = ['#1e2535','#312e81','#1d4ed8','#0e7490','#65a30d','#facc15'];

function rampColor(scheme, t){
  const i = Math.min(scheme.length-1, Math.floor(t*scheme.length));
  return scheme[i];
}
function getColorForSez(s, mode, max){
  if(mode==='norm'){
    const st = normStatus(s);
    return st.code==='na' ? NORM_COLORS.na : st.color;
  }
  if(mode==='fer'){
    const fer = normFer(s);
    return fer===null ? NORM_COLORS.na : rampColor(COLORS_FER, fer/100);
  }
  if(mode==='best'){
    // Producibilità nelle sole aree ammissibili (stessa lettura della scala urbana)
    if(normStatus(s).code!=='fac') return '#232936';
    const pv = normPv(s);
    return pv===null ? '#232936' : rampColor(COLORS_FV, pv/100);
  }
  if(mode==='hiprod') return isHiProd(s) ? rampColor(COLORS_FV, prodIndex(s)/100) : '#232936';
  if(mode==='prioloc'){
    if(!isHiProd(s)) return '#232936';
    return isIdonea(s) ? '#facc15' : '#1f5bab';
  }
  if(mode==='cross' || mode==='prio'){
    // stessi criteri della scala urbana, applicati alle sezioni della cabina
    const st = normStatus(s).code, pv = normPv(s);
    if(mode==='cross'){
      if(st!=='fac' || pv===null) return '#232936';
      return pv >= crossThreshold() ? '#facc15' : '#1f5bab';
    }
    const off = isSitoRapido(s), vul = isVulnSec(s);
    if(off && vul) return '#f97316';
    if(off)        return '#facc15';
    if(vul)        return '#a855f7';
    return '#232936';
  }
  let t = 0;
  if(mode==='match') t = (s._match||0)/Math.max(max,1);
  else if(mode==='fv') t = sezFV(s)/Math.max(max,1);
  else if(mode==='vuln') t = sezPV(s)/Math.max(max,1);
  else if(mode==='ivsm') t = (s.ivsm||0)/100;
  t = Math.min(1, Math.max(0, t));
  const scheme = mode==='match'?COLORS_MATCH:mode==='fv'?COLORS_FV:mode==='vuln'?COLORS_VULN:COLORS_IVSM;
  return rampColor(scheme, t);
}

// Pattern SVG a tratteggio rosso per le sezioni in aree non idonee (bloccanti).
// Iniettato nei <defs> del renderer SVG della mappa; applicato via CSS class.
function ensureHatchPattern(m){
  const svg = m && m.getPanes().overlayPane.querySelector('svg');
  if(!svg || svg.querySelector('#hatch-blk')) return;
  const defs = document.createElementNS('http://www.w3.org/2000/svg','defs');
  defs.innerHTML = `<pattern id="hatch-blk" patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(45)">
      <rect width="8" height="8" fill="rgba(127,29,29,.55)"></rect>
      <line x1="0" y1="0" x2="0" y2="8" stroke="#ef4444" stroke-width="3.2"></line>
    </pattern>`;
  svg.insertBefore(defs, svg.firstChild);
}

function initMap(c, sez){
  if(map){ map.remove(); }
  map = L.map('map', {zoomControl:true, attributionControl:false}).setView([40.85,14.27], 13);
  addBaseLayers(map, false);

  drawSezLayer(sez);
  drawBuildings();
  if(sezLayer){
    try{ map.fitBounds(sezLayer.getBounds(), {padding:[20,20]}); }catch(e){}
  }
  const legend = L.control({position:'bottomright'});
  legend.onAdd = () => {
    const div = L.DomUtil.create('div','legend');
    updateLegend(div);
    legend._div = div;
    return div;
  };
  legend.addTo(map);
  map._legend = legend;
}

function updateLegend(div){
  div = div || (map && map._legend && map._legend._div);
  if(!div) return;
  if(mapColorMode==='norm'){
    div.innerHTML = `<strong>Fattibilità normativa · DM 21/06/2024</strong>` +
      `<div class="legend-row"><span class="legend-swatch" style="background:${NORM_COLORS.fac}"></span>✅ Idonea — iter semplificato</div>` +
      `<div class="legend-row"><span class="legend-swatch" style="background:${NORM_COLORS.ord}"></span>📋 Ordinaria — iter standard</div>` +
      `<div class="legend-row"><span class="legend-swatch" style="background:${NORM_COLORS.blk}"></span>🚫 Non idonea — bloccante</div>` +
      (hasNorm()?'':'<div class="legend-row" style="color:var(--text-faint)">layer non ancora caricato</div>') +
      `<div style="font-size:10px;color:var(--text-faint);margin-top:4px;max-width:180px;line-height:1.4">Classe prevalente per superficie · Piattaforma Aree Idonee (GSE)</div>`;
    return;
  }
  const labels = {
    match: ['Match FV ↔ Vuln.', ['basso','','','','','alto']],
    fv:    [`Energia producibile · ${SRC[fvSource].label} (MWh/a)`, ['nessuna','','','','','massima']],
    vuln:  [`Pop. vulnerabile IVSM>${THR}`, ['0','','','','','max']],
    ivsm:  ['IVSM (0-100)', ['0','20','40','60','80','100']],
    fer:   ['🏆 FER_100 = (N_s + S_s)/2', ['0','20','40','60','80','100']],
    cross: ['✖️ Intersezione idonee × energia', []],
    prio:  ['🎯 Aree prioritarie per la CER', []],
  };
  if(mapColorMode==='cross' || mapColorMode==='prio'){
    const rows = mapColorMode==='cross'
      ? [['#facc15','idonea e molto produttiva'], ['#1f5bab','idonea, meno produttiva'], ['#232936','fuori intersezione']]
      : [['#f97316','<strong>priorità massima</strong> — produce e serve'], ['#facc15','sito ottimale (offerta)'],
         ['#a855f7',`IVSM > ${THR} (domanda sociale)`], ['#232936','fuori sintesi']];
    div.innerHTML = `<strong>${labels[mapColorMode][0]}</strong>` +
      rows.map(([c,l])=>`<div class="legend-row"><span class="legend-swatch" style="background:${c}"></span>${l}</div>`).join('') +
      (normOverlay && hasNorm() ? `<div style="border-top:1px solid rgba(255,255,255,.15);margin-top:6px;padding-top:6px"></div>
        <div class="legend-row"><span class="legend-swatch" style="background:repeating-linear-gradient(45deg,#7f1d1d,#7f1d1d 3px,#ef4444 3px,#ef4444 5px)"></span>🚫 area non idonea</div>` : '') +
      // i segnaposti sulla mappa vanno sempre dichiarati, altrimenti la legenda non corrisponde
      (prioOverlay ? `<div style="border-top:1px solid rgba(255,255,255,.15);margin-top:6px;padding-top:6px"></div>
        <div class="legend-row">☀️ top produzione FV</div>
        <div class="legend-row">👥 top vulnerabilità</div>
        <div class="legend-row">⭐ nucleo di avvio CER</div>` : '');
    return;
  }
  if(mapColorMode==='best'){
    div.innerHTML = `<strong>Producibilità nelle aree ammissibili</strong>` +
      COLORS_FV.map((c,i)=>`<div class="legend-row"><span class="legend-swatch" style="background:${c}"></span>${['poca energia','','','','','molta energia'][i]}</div>`).join('') +
      `<div class="legend-row" style="margin-top:4px"><span class="legend-swatch" style="background:#232936"></span>ordinaria / non idonea (spenta)</div>`;
    return;
  }
  const scheme = mapColorMode==='match'?COLORS_MATCH:mapColorMode==='fv'?COLORS_FV:mapColorMode==='vuln'?COLORS_VULN:mapColorMode==='fer'?COLORS_FER:COLORS_IVSM;
  if(!labels[mapColorMode]) return;      // modo senza legenda dedicata: nessun errore
  const [title, ticks] = labels[mapColorMode];
  div.innerHTML = `<strong>${title}</strong>` +
    scheme.map((col,i)=>`<div class="legend-row"><span class="legend-swatch" style="background:${col}"></span>${ticks[i]||''}</div>`).join('') +
    (mapColorMode==='fer' ? `<div style="font-size:10px;color:var(--text-faint);margin-top:4px;max-width:190px;line-height:1.4">Idoneità localizzativa: normativa (aree idonee) × produttività dei tetti. Le sezioni migliori sono oro.</div>` : '') +
    (normOverlay && hasNorm() ? `<div style="border-top:1px solid rgba(255,255,255,.15);margin-top:6px;padding-top:6px"></div>
      <div class="legend-row"><span class="legend-swatch" style="background:repeating-linear-gradient(45deg,#7f1d1d,#7f1d1d 3px,#ef4444 3px,#ef4444 5px)"></span>🚫 area non idonea (bloccante)</div>` : '') +
    (prioOverlay ? `<div style="border-top:1px solid rgba(255,255,255,.15);margin-top:6px;padding-top:6px"></div>
      <div class="legend-row">☀️ top produzione FV</div>
      <div class="legend-row">👥 top vulnerabilità</div>
      <div class="legend-row">⭐ nucleo di avvio CER</div>` : '');
}

function drawSezLayer(sez){
  if(sezLayer){ map.removeLayer(sezLayer); }
  if(prioMarkers){ map.removeLayer(prioMarkers); prioMarkers=null; }
  const maxFV = Math.max(...sez.map(s=>sezFV(s)), 1);
  const maxVuln = Math.max(...sez.map(s=>sezPV(s)), 1);
  sez.forEach(s => s._match = isBlocked(s) ? 0 : (sezFV(s)/maxFV) * (sezPV(s)/maxVuln) * 100);
  const maxMatch = Math.max(...sez.map(s=>s._match), 1);
  const max = {match:maxMatch, fv:maxFV, vuln:maxVuln, ivsm:100, norm:100, fer:100}[mapColorMode];

  const pr = computePrio(sez);
  const m = SRC[fvSource];

  const features = sez.filter(s=>s.geom && s.geom.length>=3).map(s=>({
    type:'Feature',
    properties: { ...s },
    geometry: { type:'Polygon', coordinates:[s.geom] }
  }));
  sezLayer = L.geoJSON({type:'FeatureCollection',features}, {
    style: f => {
      const s = f.properties;
      const st = hasNorm() ? normStatus(s).code : 'na';
      const blocked = hasNorm() && st === 'blk';
      // Tratteggio bloccante: sezioni in area prevalentemente non idonea,
      // visibile in OGNI modalità colore quando l'overlay vincoli è attivo
      const blk = normOverlay && blocked;
      let base = {
        fillColor: getColorForSez(s, mapColorMode, max),
        color: blk ? '#ef4444' : 'rgba(255,255,255,.18)',
        weight: blk ? 1.6 : 0.5,
        fillOpacity: s.empty ? 0.5 : 0.75,   // sezioni non abitate: tessere più tenui
        className: blk ? 'norm-blk-hatch' : '',
      };
      if(blk) base.dashArray = '4 3';

      // ---- Fasi del percorso normativo ----
      if(hasNorm() && normPhase !== 'all'){
        if(blocked){
          // ① escluse: spente, fuori gioco (restano leggibili come vincolo)
          return {fillColor:'#20242e', color:'rgba(239,68,68,.45)', weight:0.9,
                  fillOpacity:0.14, dashArray:'3 3', className:''};
        }
        if(normPhase === 'idon' || normPhase === 'cross'){
          if(st === 'fac'){                       // ② idonee accese e bordate
            base.color = '#22c55e'; base.weight = 2.2; base.fillOpacity = 0.92;
          } else {                                 // ordinarie in secondo piano
            base.fillOpacity = 0.3; base.color = 'rgba(255,255,255,.12)'; base.weight = 0.5;
          }
        }
      }

      if(prioOverlay && !(normPhase !== 'all' && blocked)){
        if(pr.nucleoSet.has(s.id)) base = {...base, color:'#ffffff', weight:2.6, fillOpacity:Math.max(base.fillOpacity,0.85)};
        else if(pr.fvSet.has(s.id))base = {...base, color:'#22d3ee', weight:2.2, fillOpacity:Math.max(base.fillOpacity,0.82)};
        else if(pr.vulnSet.has(s.id))base = {...base, color:'#fb923c', weight:2.2, fillOpacity:Math.max(base.fillOpacity,0.82)};
      }
      // ④ "per chi": il bordo arancione marca le sezioni vulnerabili, sempre in cima
      if(ivsmOverlay && isVulnSez(s)){
        base = {...base, color:'#fb923c', weight:2.6, dashArray:null,
                fillOpacity:Math.max(base.fillOpacity, 0.6)};
      }
      return base;
    },
    onEachFeature: (f, layer) => {
      const s = f.properties;
      layer.on('click', ()=>openSezPopup(s.id));
      const tags = [];
      if(pr.nucleoSet.has(s.id)) tags.push('⭐ nucleo di avvio CER');
      else { if(pr.fvSet.has(s.id)) tags.push('☀️ top produzione'); if(pr.vulnSet.has(s.id)) tags.push('👥 top vulnerabilità'); }
      const nst = normStatus(s);
      const ferV = normFer(s);
      const normLine = hasNorm() ? `<br><span style="color:${nst.color}">${nst.icon} ${nst.lbl}</span> · N<sub>s</sub> ${normNs(s)!==null?fmt1(normNs(s)):'—'}${ferV!==null?` · 🏆 FER ${fmt1(ferV)}`:''}` : '';
      layer.bindTooltip(`
        <div style="font-family:DM Sans;font-size:12px">
          <strong>${shortSez(s.id)}</strong>${s.empty?' <span style="color:#8b93a8">· non abitata</span>':''}${tags.length?'<br><span style="color:#fbbf24">'+tags.join(' · ')+'</span>':''}${normLine}<br>
          ${s.empty?'Sezione senza residenti — solo valutazione localizzativa':'Pop: '+fmt(s.pop)+' · Vuln (IVSM>'+THR+'): '+fmt(sezPV(s))}<br>
          FV ${m.label}: ${fmt1(sezFV(s))} MWh · Match: ${(s._match||0).toFixed(1)}
        </div>`, {sticky:true, className:'leaflet-tooltip-custom'});
      layer.on('mouseover', e=>e.target.setStyle({weight:3, color:'#fff'}));
      layer.on('mouseout', e=>sezLayer.resetStyle(e.target));
    }
  }).addTo(map);
  ensureHatchPattern(map);

  // Marker priorità (☀ dove installare · 👥 per chi · ⭐ nucleo)
  if(prioOverlay){
    prioMarkers = L.layerGroup();
    const mk = (s, cls, glyph, title) => {
      if(!s.c || s.c.length!==2) return;
      const ico = L.divIcon({className:'prio-marker', html:`<div class="pm ${cls}" title="${title}">${glyph}</div>`, iconSize:[26,26], iconAnchor:[13,13]});
      const mrk = L.marker([s.c[1], s.c[0]], {icon:ico});
      mrk.on('click', ()=>openSezPopup(s.id));
      prioMarkers.addLayer(mrk);
    };
    pr.topFV5.filter(s=>!pr.nucleoSet.has(s.id)).forEach(s=>mk(s,'pm-fv','☀️','Top produzione FV'));
    pr.topVuln5.filter(s=>!pr.nucleoSet.has(s.id)).forEach(s=>mk(s,'pm-vuln','👥','Top vulnerabilità'));
    pr.nuclei.forEach(s=>mk(s,'pm-star','⭐','Nucleo di avvio CER'));
    prioMarkers.addTo(map);
  }
  updateLegend();
}

// ---------- 🏢 Impronte degli edifici sulla mappa della cabina ----------
function toggleBuildings(btn){
  showBuildings = !showBuildings;
  if(btn) btn.classList.toggle('active', showBuildings);
  drawBuildings();
}
function drawBuildings(){
  if(!map) return;
  if(bldLayer){ map.removeLayer(bldLayer); bldLayer = null; }
  const note = document.getElementById('bld-note');
  if(!showBuildings || !FOOTPRINTS || !activeCabina){ if(note) note.style.display='none'; return; }
  const idx = bldBySez();
  const sezIds = DATA.sezioni.filter(s=>s.cab===activeCabina).map(s=>s.id);
  const list = [];
  sezIds.forEach(id=>{ const arr = idx[id]; if(arr) list.push(...arr); });
  if(note){
    note.style.display = 'block';
    const per = {r:0,e:0,p:0,i:0}; list.forEach(b=>per[b[0]]++);
    note.innerHTML = bldLegendHtml(`<strong>${fmt(list.length)} edifici</strong> nella cabina — clicca un perimetro per la scheda`, per);
  }
  const renderer = L.canvas({padding:0.3});
  const polys = list.map(b=>{
    const col = BLD_COLORS[b[0]] || '#94a3b8';
    const p = L.polygon(decodeRing(b[3]), {renderer,
      color:'#0b0e14', weight:0.7, opacity:0.85,        // contorno scuro: il perimetro si legge
      fillColor: col, fillOpacity: 0.95});
    p._b = b;
    return p;
  });
  // featureGroup (non layerGroup): propaga gli eventi dei poligoni figli con e.layer,
  // condizione necessaria perché tooltip e click sui singoli edifici funzionino.
  bldLayer = L.featureGroup(polys).addTo(map);
  bindBldInteractions(bldLayer);
  // le sezioni passano in secondo piano: gli edifici devono restare leggibili
  if(sezLayer) sezLayer.setStyle({fillOpacity:0.28});
}

// Legenda dei quattro tipi di edificio, con conteggi quando disponibili
function bldLegendHtml(title, per){
  const item = k => `<span style="display:inline-flex;align-items:center;gap:5px">
      <span style="width:13px;height:13px;border-radius:3px;background:${BLD_COLORS[k]};border:1px solid #0b0e14;display:inline-block"></span>
      ${BLD_LABELS[k]}${per && per[k]!==undefined ? ` <strong>${fmt(per[k])}</strong>` : ''}</span>`;
  return `🏢 ${title}
    <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:7px">
      ${['e','p','i','r'].filter(k=>!per || per[k]).map(item).join('')}
    </div>`;
}

// Tooltip + click su ogni edificio: apre la scheda con superficie, tipo e stima kWp
const bldName = b => (b[4] || '').trim();
const bldUso  = b => (b[5] || '').trim();
function bindBldInteractions(group){
  group.bindTooltip(layer => {
    const b = layer._b || [];
    const nome = bldName(b), uso = bldUso(b);
    return `<div style="font-family:DM Sans;font-size:11.5px;line-height:1.45">
      <strong style="color:${BLD_COLORS[b[0]]}">${nome || BLD_LABELS[b[0]] || 'Edificio'}</strong><br>
      ${nome ? BLD_LABELS[b[0]] + (uso ? ' · ' + uso : '') + '<br>' : (uso ? uso + '<br>' : '')}
      superficie tetto ~${fmt(b[2]||0)} m²<br>
      <em style="color:#8b93a8">click per la scheda completa</em></div>`;
  }, {sticky:true, className:'leaflet-tooltip-custom'});
  group.on('click', e => { const l = e.layer || e.propagatedFrom; if(l && l._b) openBldPopup(l._b); });
}

// Scheda dell'edificio: cosa è, quanta superficie, quanto potrebbe produrre
function openBldPopup(b){
  const [tipo, sid, area] = b;
  const nome = bldName(b), uso = bldUso(b);
  const s = DATA.sezioni.find(x=>x.id===sid);
  // stima: metà della copertura utilizzabile, 20% efficienza, PR 0,85 (coefficienti del paper)
  const kwp  = area * 0.5 * 0.20;                    // ~0,1 kWp per m² di impronta
  const mwh  = kwp * KWH_PER_KWP() / 1000;
  const st   = s ? normStatus(s) : null;
  const el = document.getElementById('sp-content');
  document.getElementById('sp-id').textContent = `edificio in sezione ${sid || '—'}`;
  const h3 = document.querySelector('#sez-popup h3');
  if(h3) h3.innerHTML = `<span style="color:${BLD_COLORS[tipo]}">■</span> ${nome || BLD_LABELS[tipo] || 'Edificio'}`;
  el.innerHTML = `
    ${nome ? `<div style="font-size:12px;color:var(--text-muted);margin:-8px 0 10px">${BLD_LABELS[tipo]}${uso?' · '+uso:''}</div>` : ''}
    <div style="padding:10px 12px;border-radius:10px;background:var(--surface2);border-left:3px solid ${BLD_COLORS[tipo]};margin-bottom:10px;font-size:12px;line-height:1.5;color:var(--text-muted)">
      Uso prevalente: <strong style="color:${BLD_COLORS[tipo]}">${uso || BLD_LABELS[tipo]}</strong>${
      tipo==='e'?' — edilizia residenziale pubblica: <em>il patrimonio su cui la CER solidale può essere ancorata</em>':
      tipo==='p'?' — patrimonio pubblico: <em>promotore istituzionale ideale per avviare la comunità</em>':
      tipo==='i'?' — capannone o copertura produttiva: <em>grandi superfici, ottime per il surplus da condividere</em>':
                 ' — edilizia residenziale privata: <em>i prosumer che possono aderire alla comunità</em>'}
    </div>
    ${nome ? `<div class="row-data"><span class="row-label">Denominazione</span><span class="row-value" style="text-align:right;max-width:60%">${nome}</span></div>` : ''}
    <div class="row-data"><span class="row-label">Superficie del tetto</span><span class="row-value">${fmt(area||0)} m²</span></div>
    <div class="row-data"><span class="row-label">Potenza installabile stimata</span><span class="row-value" style="color:${BLD_COLORS[tipo]};font-weight:700">~${fmt(Math.round(kwp))} kWp</span></div>
    <div class="row-data"><span class="row-label">Producibilità annua stimata</span><span class="row-value">${fmt1(mwh)} MWh/a</span></div>
    <div style="font-size:10.5px;color:var(--text-faint);margin:6px 0 10px;line-height:1.45">Stima indicativa: 50% della copertura utilizzabile × 20% di efficienza × ${fmt(KWH_PER_KWP())} kWh/kWp (coefficienti del framework).</div>
    ${s ? `<div class="row-data" style="border-top:1px solid var(--border-strong);padding-top:10px"><span class="row-label" style="font-weight:600;color:var(--accent2)">Sezione ${shortSez(s.id)}</span><span class="row-value"><button class="toolbar-btn" style="font-size:11px" onclick="openSezPopup(${s.id})">apri scheda sezione →</button></span></div>
    <div class="row-data"><span class="row-label">Quadro normativo</span><span class="row-value" style="color:${st.color}">${st.icon} ${st.short}</span></div>
    <div class="row-data"><span class="row-label">Vulnerabilità (IVSM)</span><span class="row-value">${s.pop? s.ivsm : '—'}</span></div>` : ''}`;
  document.getElementById('sez-popup').classList.add('visible');
}

// Edifici sulla mappa città: solo da zoom ravvicinato e limitati alla vista corrente
function toggleCityBuildings(btn){
  cityBuildings = !cityBuildings;
  if(btn) btn.classList.toggle('active', cityBuildings);
  drawCityBuildings();
}
function drawCityBuildings(){
  if(!napoliMap) return;
  if(cityBldLayer){ napoliMap.removeLayer(cityBldLayer); cityBldLayer = null; }
  const note = document.getElementById('city-bld-note');
  if(!cityBuildings || !FOOTPRINTS){ if(note) note.style.display='none'; return; }
  const z = napoliMap.getZoom();
  if(note){
    note.style.display = 'block';
    note.innerHTML = z < BLD_ZOOM_MIN
      ? `🔍 <strong>Ingrandisci di ${BLD_ZOOM_MIN - z} livelli</strong> (rotellina o pulsante +) per vedere i perimetri dei ${fmt(FOOTPRINTS.b.length)} edifici — residenziali, ERP, pubblici e industriali — e cliccarli per la scheda. In alternativa entra in una cabina: lì sono sempre visibili.`
      : bldLegendHtml('Perimetri degli edifici visibili nell\'inquadratura');
  }
  if(z < BLD_ZOOM_MIN) return;
  const bb = napoliMap.getBounds(), S = FOOTPRINTS.scale;
  const renderer = L.canvas({padding:0.2});
  const polys = [];
  for(const b of FOOTPRINTS.b){
    const lon = b[3][0]/S, lat = b[3][1]/S;
    if(lat < bb.getSouth() || lat > bb.getNorth() || lon < bb.getWest() || lon > bb.getEast()) continue;
    const p = L.polygon(decodeRing(b[3]), {renderer, color:'#0b0e14', weight:0.6, opacity:0.8,
      fillColor: BLD_COLORS[b[0]], fillOpacity:0.95});
    p._b = b; polys.push(p);
    if(polys.length > 15000) break;         // limite di sicurezza sul rendering
  }
  cityBldLayer = L.featureGroup(polys).addTo(napoliMap);
  bindBldInteractions(cityBldLayer);
}

function setMapColor(mode, btn){
  mapColorMode = mode;
  document.querySelectorAll('#view-cabina .map-toolbar .toolbar-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  if(activeCabina){
    const sez = DATA.sezioni.filter(s=>s.cab===activeCabina);
    drawSezLayer(sez);
  }
}

// ---------- Popup dettaglio sezione ----------
function openSezPopup(id){
  const s = DATA.sezioni.find(x=>x.id==id || x.id==Number(id));
  if(!s) return;
  const h3 = document.querySelector('#sez-popup h3');
  if(h3) h3.textContent = 'Sezione censuaria';    // il popup è condiviso con la scheda edificio
  document.getElementById('sp-id').textContent = String(s.id);
  const pctVuln = s.pop>0?((s.pop_vuln/s.pop*100).toFixed(1)+'%'):'—';
  document.getElementById('sp-content').innerHTML = `
    ${s.empty?'<div style="padding:8px 10px;border-radius:8px;background:rgba(139,147,168,.12);border:1px solid rgba(139,147,168,.3);font-size:11.5px;color:var(--text-muted);margin-bottom:10px">🏜 <strong>Sezione non abitata</strong> — nessun residente: rilevante solo come possibile sito impianto (valutazione normativa e FER_100 qui sotto).</div>':''}
    <div class="row-data"><span class="row-label">Popolazione totale</span><span class="row-value">${fmt(s.pop)}</span></div>
    <div class="row-data"><span class="row-label">Famiglie</span><span class="row-value">${fmt(s.fam)}</span></div>
    <div class="row-data"><span class="row-label">Pop. vulnerabile</span><span class="row-value">${fmt(s.pop_vuln)} (${pctVuln})</span></div>
    <div class="row-data"><span class="row-label">Vuln. per soglia IVSM</span><span class="row-value" style="font-size:12px">&gt;60: ${fmt(s.pv60||0)} · &gt;70: ${fmt(s.pv70||0)} · &gt;80: ${fmt(s.pv80||0)}</span></div>
    <div class="row-data"><span class="row-label">IVSM 2021</span><span class="row-value">${s.ivsm} · ${s.ivsm_class}</span></div>
    <div class="row-data"><span class="row-label">Pop. ≥70 anni</span><span class="row-value">${s.old70}%</span></div>
    <div class="row-data"><span class="row-label">Bassa scolarità</span><span class="row-value">${s.edu_low}%</span></div>
    <div class="row-data"><span class="row-label">Disoccupazione</span><span class="row-value">${s.emp_vuln}%</span></div>
    ${buildNormBox(s)}
    ${buildRoofBoxes(s)}
    <div class="row-data" style="border-top:1px solid var(--border-strong);margin-top:8px;padding-top:10px"><span class="row-label" style="font-weight:600;color:var(--accent2)">Bilancio FV / consumi</span></div>
    <div class="row-data"><span class="row-label">Energia producibile totale</span><span class="row-value" style="color:var(--success)">${fmt1(s.fv_tot||0)} MWh/a</span></div>
    <div class="row-data"><span class="row-label">Consumo elettrico stimato</span><span class="row-value">${fmt1(s.cons_tot)} MWh/a</span></div>
    <div class="row-data"><span class="row-label">FV → vulnerabili</span><span class="row-value">${fmt1(s.fv_to_vuln)} MWh</span></div>
    <div class="row-data"><span class="row-label">Copertura vuln.</span><span class="row-value">${s.cov_vuln}%</span></div>
    <div class="row-data"><span class="row-label">Classe CER</span><span class="row-value"><span class="badge ${s.priorita>0?'badge-blue':'badge-gray'}">${s.cer_class||'—'}</span></span></div>
    ${buildSezDemandHtml(s)}
  `;
  document.getElementById('sez-popup').classList.add('visible');
}
function closeSezPopup(){ document.getElementById('sez-popup').classList.remove('visible'); }

// Box "Fattibilità normativa" nel popup sezione — DM 21/06/2024 · Piattaforma Aree Idonee.
// Vale per la LOCALIZZAZIONE DELL'IMPIANTO; non modifica IVSM né platea beneficiari.
function buildNormBox(s){
  if(!hasNorm() || !s.nrm){
    const msg = hasNorm()
      ? 'dato non disponibile per questa sezione'
      : 'layer aree idonee non caricato';
    return `<div class="row-data" style="border-top:1px solid var(--border-strong);margin-top:8px;padding-top:10px"><span class="row-label">⚖️ Quadro normativo</span><span class="row-value" style="color:var(--text-faint)">${msg}</span></div>`;
  }
  const st = normStatus(s);
  const i=(s.nrm&&s.nrm.i)||0, o=(s.nrm&&s.nrm.o)||0, n=(s.nrm&&s.nrm.n)||0;
  const ns = normNs(s);
  const seg = (v,color) => v>0?`<div style="height:100%;width:${v.toFixed(1)}%;background:${color}" title="${v.toFixed(1)}%"></div>`:'';
  const verdict = {
    blk: `🚫 <strong>Sezione bloccante per l'impianto</strong>: superficie prevalentemente in <strong>aree non idonee</strong> (regimi di tutela paesaggistica/ambientale, D.Lgs. 42/2004). Iter autorizzativo fortemente penalizzato: localizzare l'impianto nelle sezioni limitrofe attivabili. <em>I residenti restano beneficiari CER: la vulnerabilità (IVSM) non è influenzata dalla classe normativa.</em>`,
    fac: `✅ <strong>Sezione facilitata</strong>: superficie prevalentemente in <strong>aree idonee</strong> ex art. 20 D.Lgs. 199/2021 — procedure autorizzative <strong>semplificate</strong> e tempi ridotti. Sito prioritario per l'installazione dell'impianto CER.`,
    ord: `📋 <strong>Area ordinaria</strong>: installazione ammissibile con iter autorizzativo standard e valutazione caso per caso.`,
  }[st.code] || '';
  return `
    <div style="margin-top:10px;padding:12px;background:var(--surface2);border:1px solid ${st.color}44;border-left:3px solid ${st.color};border-radius:10px">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:${st.color};font-weight:700;margin-bottom:8px">⚖️ Fattibilità normativa — DM 21/06/2024</div>
      <div style="display:flex;height:10px;border-radius:99px;overflow:hidden;background:var(--surface3);margin-bottom:6px">
        ${seg(i,NORM_COLORS.fac)}${seg(o,NORM_COLORS.ord)}${seg(n,NORM_COLORS.blk)}
      </div>
      <div style="display:flex;gap:10px;font-size:10.5px;color:var(--text-muted);flex-wrap:wrap;margin-bottom:8px">
        <span><span style="color:${NORM_COLORS.fac}">■</span> Idonea ${fmt1(i)}%</span>
        <span><span style="color:${NORM_COLORS.ord}">■</span> Ordinaria ${fmt1(o)}%</span>
        <span><span style="color:${NORM_COLORS.blk}">■</span> Non idonea ${fmt1(n)}%</span>
      </div>
      <div class="row-data"><span class="row-label">Classe prevalente</span><span class="row-value" style="color:${st.color};font-weight:700">${st.icon} ${st.short}${s.nrm.est?' <span style="font-size:10px;color:var(--text-faint)">(stimata da perimetri)</span>':''}</span></div>
      <div class="row-data"><span class="row-label">Indice N<sub>s</sub> (Eq.1 · 1/0,5/0)</span><span class="row-value">${ns!==null?fmt1(ns)+' / 100':'—'}</span></div>
      ${normPv(s)!==null?`<div class="row-data"><span class="row-label">S<sub>s</sub> · produzione normalizzata</span><span class="row-value">${fmt1(normPv(s))} / 100</span></div>`:''}
      ${normFer(s)!==null?`<div class="row-data"><span class="row-label">🏆 FER_100 = (N<sub>s</sub>+S<sub>s</sub>)/2</span><span class="row-value" style="color:#facc15;font-weight:700;font-size:15px">${fmt1(normFer(s))}</span></div>`:''}
      <div style="font-size:11px;color:var(--text-muted);line-height:1.5;margin-top:8px">${verdict}</div>
    </div>`;
}

// Box "tetti — dove installare": uno per fonte con superficie > 0.
// Potenza stimata: kWp ≈ producibilità annua / (kWh/kWp di Napoli, default 1.400).
function buildRoofBoxes(s){
  const defs = [
    { key:'erp', icon:'🏠', name:'Tetti ERP',        b:s.erp_b,  sup:s.sup_erp,  fv:s.fv_mwh, col:'#06b6d4', extra:`<div class="row-data"><span class="row-label">% area ERP/totale sezione</span><span class="row-value">${s.erp_pct}%</span></div>` },
    { key:'pub', icon:'🏛', name:'Tetti pubblici',   b:s.pub_b,  sup:s.sup_pub,  fv:s.fv_pub, col:'#a855f7', extra:'' },
    { key:'ind', icon:'🏭', name:'Tetti industriali',b:s.ind_b,  sup:s.sup_ind,  fv:s.fv_ind, col:'#f59e0b', extra:'' },
  ];
  const boxes = defs.filter(d=>(d.sup||0)>0 || (d.fv||0)>0).map(d=>{
    const kwp = kwpFromMwh(d.fv||0);
    return `
    <div style="margin-top:10px;padding:12px;background:var(--surface2);border:1px solid ${d.col}44;border-left:3px solid ${d.col};border-radius:10px">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:${d.col};font-weight:700;margin-bottom:8px">${d.icon} ${d.name} — dove installare</div>
      <div class="row-data"><span class="row-label">Edifici</span><span class="row-value">${fmt(d.b||0)}</span></div>
      <div class="row-data"><span class="row-label">Superficie coperture</span><span class="row-value">${fmt(Math.round(d.sup||0))} m²</span></div>
      ${d.extra}
      <div class="row-data"><span class="row-label">Potenza installabile stimata</span><span class="row-value" style="color:${d.col};font-weight:700">~${fmt(Math.round(kwp))} kWp</span></div>
      <div class="row-data"><span class="row-label">Producibilità annua</span><span class="row-value">${fmt1(d.fv||0)} MWh/a</span></div>
    </div>`;
  }).join('');
  if(!boxes) return `<div class="row-data" style="border-top:1px solid var(--border-strong);margin-top:8px;padding-top:10px"><span class="row-label">Coperture utilizzabili</span><span class="row-value" style="color:var(--text-muted)">nessuna in questa sezione</span></div>`;
  return `<div class="row-data" style="border-top:1px solid var(--border-strong);margin-top:8px;padding-top:10px"><span class="row-label" style="font-weight:600;color:var(--accent2)">Coperture per l'installazione FV</span></div>` + boxes +
    `<div style="font-size:10.5px;color:var(--text-faint);margin-top:6px;line-height:1.4">Stima potenza: producibilità annua ÷ ${fmt(KWH_PER_KWP())} kWh/kWp (Napoli).</div>`;
}

function buildSezDemandHtml(s){
  const demandMwh = (s.pop_vuln||0) * params.cons_kwh / 1000;
  const fv = s.fv_mwh || 0;
  const cov = demandMwh>0 ? (fv/demandMwh*100) : 0;
  const bal = cov>=100 ? '✅' : cov>=50 ? '⚠️' : '❌';
  const colCov = cov>=100 ? 'var(--success)' : cov>=50 ? 'var(--warning)' : 'var(--danger)';
  const demStr = demandMwh>=1000 ? (demandMwh/1000).toFixed(2)+' GWh/a' : fmt1(demandMwh)+' MWh/a';
  const fvStr  = fv>=1000 ? (fv/1000).toFixed(2)+' GWh/a' : fmt1(fv)+' MWh/a';
  return `
    <div style="margin-top:14px;padding:12px;background:linear-gradient(135deg,var(--surface2),rgba(168,85,247,.08));border:1px solid rgba(168,85,247,.25);border-radius:10px">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:#c084fc;font-weight:600;margin-bottom:8px">🎯 Domanda energetica della sezione</div>
      <div class="row-data"><span class="row-label">Pop. vulnerabile</span><span class="row-value">${fmt(s.pop_vuln)} pers.</span></div>
      <div class="row-data"><span class="row-label">Consumo procapite</span><span class="row-value">${fmt(params.cons_kwh)} kWh/a</span></div>
      <div class="row-data"><span class="row-label">Domanda totale</span><span class="row-value" style="color:#c084fc;font-weight:700">${demStr}</span></div>
      <div class="row-data"><span class="row-label">FV-ERP della sezione</span><span class="row-value">${fvStr}</span></div>
      <div class="row-data" style="border-top:1px solid var(--border-strong);margin-top:6px;padding-top:8px">
        <span class="row-label">Copertura ${bal}</span>
        <span class="row-value" style="color:${colCov};font-weight:700;font-size:15px">${demandMwh>0?cov.toFixed(1)+'%':'—'}</span>
      </div>
    </div>`;
}

// ---------- Raccomandazione ----------
function buildRecommendation(c, sez){
  const top = sez.filter(s=>(s._match||0)>0).sort((a,b)=>b._match-a._match)[0];
  const sezConErp = sez.filter(s=>s.erp_b>0).length;
  const fvTotMwh = c.fv_erp_mwh;
  const persSat = Math.round(c.fv_to_vuln_mwh * 1000 / params.cons_kwh);
  const cop = c.cov_vuln_pct;

  const cf = cerConfig(c), fe = feasib(c);
  const pr = cabPrio(c), popV = cabPopVuln(c);
  let title, text, tags=[];
  if(pr.tier === 'C1'){
    title = '🔴 Cabina C1 — CER solidale ad alta priorità';
    text = `Cabina in <strong>tier C1</strong> (Jenks sul numero di vulnerabili): <strong>${fmt(popV)} residenti vulnerabili</strong> alla soglia IVSM>${THR} (IVSM medio ${c.ivsm_avg}). Sono presenti <strong>${fmt(c.erp_buildings)} edifici ERP</strong> distribuiti su ${sezConErp} sezioni, con potenziale FV stimato di <strong>${fmt(fvTotMwh)} MWh/a</strong>. Concentrare l'attivazione della CER sulle sezioni con il match FV↔vulnerabilità più alto (vedi tabella sopra). La copertura energetica stimata per i vulnerabili è del <strong>${cop}%</strong>, sufficiente a soddisfare circa ${fmt(persSat)} persone.`;
    tags = ['Priorità C1', `${fmt(popV)} vulnerabili`, `${persSat} pers. coperte`, `FV ${(fvTotMwh/1000).toFixed(1)} GWh/a`];
  } else if(pr.tier === 'C2'){
    title = '🟠 Cabina C2 — CER a media priorità';
    text = `Cabina in <strong>tier C2</strong>: <strong>${fmt(popV)} residenti vulnerabili</strong> (IVSM>${THR}, IVSM medio ${c.ivsm_avg}). Disponibili <strong>${fmt(c.erp_buildings)} edifici ERP</strong> e ${fmt(fvTotMwh)} MWh/a di potenziale FV. Strategia consigliata: <strong>CER con anchor ERP</strong> + estensione progressiva ai prosumer residenziali privati per saturare il bilancio energetico (oggi il FV residuo è ${fmt(c.fv_residual_mwh)} MWh). Fronte di programmazione a medio termine.`;
    tags = ['Priorità C2', `${fmt(popV)} vulnerabili`, `Residuo ${fmt(c.fv_residual_mwh)} MWh`];
  } else {
    title = '🟢 Cabina C3 — CER pilota / opportunistica';
    text = `Cabina in <strong>tier C3</strong>: vulnerabilità concentrata limitata (<strong>${fmt(popV)} residenti</strong> a IVSM>${THR}). La cabina ha comunque ${fmt(c.erp_buildings)} edifici ERP attivabili e un potenziale FV di <strong>${fmt(fvTotMwh)} MWh/a</strong>, prevalentemente esportabile in rete. Contesto ideale come <strong>pilota di governance</strong> a bassa complessità prima di scalare ai territori C1, con eventuale quota solidale verso altre cabine.`;
    tags = ['Priorità C3', `${fmt(popV)} vulnerabili`, `Export rete ${fmt(c.fv_residual_mwh)} MWh`];
  }

  if(top){
    const m = SRC[fvSource];
    text += `<br><br>🎯 Sezione consigliata come <strong>nucleo di avvio</strong> (fonte ${m.label}): <span class="sez-id" onclick="zoomSez('${top.id}')" style="cursor:pointer;text-decoration:underline dotted">${shortSez(top.id)}</span> — ${fmt1(sezFV(top))} MWh FV su ${fmt(m.b(top))} edifici, ${fmt(top.pop_vuln)} persone vulnerabili (match score ${top._match.toFixed(1)}/100).`;
  }
  const extraFv = (c.fv_pub_mwh||0)+(c.fv_ind_mwh||0);
  if(extraFv>0){
    text += `<br><br>➕ Potenziale aggiuntivo nella cabina oltre l'ERP: <strong>${fmt(Math.round(c.fv_pub_mwh||0))} MWh/a</strong> da tetti pubblici e <strong>${fmt(Math.round(c.fv_ind_mwh||0))} MWh/a</strong> da coperture industriali — attivabili come produttori terzi della stessa CER (vincolo di cabina primaria rispettato).`;
  }
  if(hasNorm()){
    const n = cabNorm(c);
    if(n.nBlk>0){
      text += `<br><br>⚖️ <strong>Vincolo normativo (DM 21/06/2024):</strong> ${fmt(n.nBlk)} sezioni della cabina ricadono in aree prevalentemente <strong style="color:#f87171">non idonee</strong> e sono bloccanti per la localizzazione dell'impianto (${fmt(Math.round(n.fvBlk.tot))} MWh/a di potenziale non attivabile in via prioritaria). Le classifiche "dove installare" e i nuclei di avvio qui sopra già escludono queste sezioni; ${fmt(n.nFac)} sezioni in <strong style="color:#22c55e">area idonea</strong> godono invece di iter semplificato. La platea dei beneficiari (IVSM) resta invariata.`;
    } else {
      text += `<br><br>⚖️ <strong>Vincolo normativo (DM 21/06/2024):</strong> nessuna sezione della cabina è bloccata da aree non idonee; ${fmt(n.nFac)} sezioni in area idonea con iter semplificato.`;
    }
  }
  text = `⚡ <strong style="color:${CER_COLORS[cf]}">${cf}</strong> — ${cerDesc(c)} <span style="color:${fe.color};font-weight:600">${fe.lbl}</span> alla soglia IVSM>${THR}.<br><br>` + text;
  document.getElementById('rec-title').innerHTML = title;
  document.getElementById('rec-text').innerHTML = text;
  document.getElementById('rec-tags').innerHTML = tags.map(t=>`<span class="badge badge-blue">${t}</span>`).join('');
}

// ---------- 🧭 Percorso guidato a esclusione ----------
// Traduce in 5 passi la logica del framework: cabine per vulnerabili → esclusione
// aree non idonee → drill-down sezioni per producibilità → incrocio FER_100 → dove × per chi.
let wizStep = 0;
const WIZ_STEPS_NEW = [
  { t:'Step 1 · Perimetrazione dei confini', d:STEP_HINT[1] },
  { t:'Step 2 · Aree idonee e non idonee (fattori normativi e urbanistici)', d:STEP_HINT[2] },
  { t:'Step 3 · Mappatura dei tetti (fattori climatici e ambientali)', d:STEP_HINT[3] },
  { t:'Step 4 · Indice di povertà energetica (fattori socio-economici)', d:STEP_HINT[4] },
  { t:'Step 5 · Aree prioritarie per la CER', d:STEP_HINT[5] },
  { t:'Dentro la cabina prioritaria', d:'Scendiamo alla scala operativa nella cabina con più residenti vulnerabili: qui la stessa sequenza si applica alle singole sezioni, fino alla graduatoria dei siti dove installare e all\'indicazione di <strong>per chi</strong> si produce.' },
];
const WIZ_STEPS_OLD = [
  { t:'1 · Le cabine primarie — priorità per vulnerabili',
    d:'Si parte dai 12 perimetri legali di condivisione dell\'energia. Colore = tier C1/C2/C3 (Jenks) sul <strong>numero di residenti vulnerabili</strong> alla soglia IVSM scelta: le rosse sono i territori dove la CER serve a più persone.' },
  { t:'2 · Esclusione — le aree non idonee escono dal gioco',
    d:'Sovrapponiamo i perimetri <strong style="color:#f87171">non idonei</strong> del DM 21/06/2024 (tutele paesaggistiche e ambientali): lì l\'impianto è bloccato. Il colore delle cabine mostra quanta parte del loro potenziale FV resta intrappolata nel vincolo.' },
  { t:'3 · Dentro la cabina — escludo le aree non idonee',
    d:'Entriamo nella cabina a priorità più alta (o in quella che scegli dalla lista) e applichiamo la fase <strong style="color:#f87171">① esclusione</strong>: le sezioni in area non idonea <strong>si spengono</strong>. Il colore mostra la <strong style="color:#22d3ee">producibilità FV</strong> di ciò che resta in gioco.' },
  { t:'4 · Evidenzio le aree idonee',
    d:'Fase <strong style="color:#22c55e">② aree idonee</strong>: restano accese e bordate di verde le sezioni a procedura semplificata (art. 20 D.Lgs. 199/2021); le ordinarie scivolano sullo sfondo come alternativa comunque ammissibile.' },
  { t:'5 · Interseco idonee × producibilità → i siti prioritari',
    d:'Fase <strong style="color:#facc15">③ intersezione</strong>: le sezioni ammissibili si colorano per <strong>FER_100 / CER_OFFER_100</strong>. Le più dorate sono le <strong>sezioni prioritarie per l\'installazione</strong>; sotto la mappa trovi la graduatoria completa.' },
  { t:'6 · Spunto l\'IVSM — e so anche per chi',
    d:'Fase <strong style="color:#fb923c">④ per chi</strong>: il bordo arancione marca le sezioni con popolazione vulnerabile, che compare anche accanto a ogni sito in graduatoria. I beneficiari restano tali <em>ovunque si trovino</em>, anche in area non idonea: l\'energia si condivide in tutta la cabina.' },
];
const WIZ_STEPS = WIZ_STEPS_NEW;
function wizStart(){ wizStep = 1; wizApply(); }
function wizClose(){ wizStep = 0; const b = document.getElementById('wiz-bar'); if(b) b.classList.remove('visible'); }
function wizNext(){ if(wizStep < WIZ_STEPS.length){ wizStep++; wizApply(); } else wizClose(); }
function wizPrev(){ if(wizStep > 1){ wizStep--; wizApply(); } }
function wizClickBtn(sel){ const b = document.querySelector(sel); if(b) b.click(); }
function wizApply(){
  const s = wizStep;
  if(!s) return;
  const inHome = document.getElementById('view-cabina').style.display==='none' || document.getElementById('view-comune').style.display!=='none';
  // Il tour ripercorre i 5 step della metodologia e chiude nella cabina prioritaria
  if(s <= 5){
    const go = () => setCityStep(s, document.querySelector(`[data-citystep="${s}"]`));
    if(!inHome){ backToNapoli(); setTimeout(go, 400); } else go();
    const el = document.getElementById('napoli-map-container');
    if(el) setTimeout(()=>el.scrollIntoView({behavior:'smooth', block:'center'}), 200);
  } else {
    const top = [...DATA.cabine].sort((a,b)=>cabPopVuln(b)-cabPopVuln(a))[0];
    const go = () => setCabStep(5, document.querySelector('[data-cabstep="5"]'));
    if(!activeCabina){ openCabina(top.id); setTimeout(go, 600); } else go();
  }
  wizRender();
}
function wizRender(){
  const bar = document.getElementById('wiz-bar');
  if(!bar) return;
  const st = WIZ_STEPS[wizStep-1];
  bar.classList.add('visible');
  bar.innerHTML = `
    <div class="wiz-dots">${WIZ_STEPS.map((_,i)=>`<span class="wiz-dot${i+1===wizStep?' on':''}${i+1<wizStep?' done':''}"></span>`).join('')}</div>
    <div class="wiz-title">${st.t}</div>
    <div class="wiz-text">${st.d}</div>
    <div class="wiz-btns">
      <button class="toolbar-btn" onclick="wizPrev()" ${wizStep===1?'disabled style="opacity:.35"':''}>← Indietro</button>
      <button class="toolbar-btn" onclick="wizClose()">✕ Chiudi</button>
      <button class="toolbar-btn active" onclick="wizNext()">${wizStep===WIZ_STEPS.length?'✔ Concludi':'Avanti →'}</button>
    </div>`;
}

// ---------- 🔎 Ambiti di intervento e zoom di progetto ----------
// Un impianto CER non si progetta su una sezione isolata ma su un isolato: le sezioni
// prioritarie contigue vengono raggruppate in ambiti, scala alla quale si può passare
// dalla pianificazione al progetto (elenco degli edifici, potenza, soggetti).
const RIG_TIPI = () => (DATA.meta && DATA.meta.rigenerazione) || {};
const AMB_DIST = 350;      // metri: distanza entro cui due sezioni fanno lo stesso ambito
let _ambiti = null;
function metriTra(a, b){
  const dx = (a[0]-b[0]) * Math.cos(40.85*Math.PI/180) * 111320;
  const dy = (a[1]-b[1]) * 111320;
  return Math.hypot(dx, dy);
}
function computeAmbiti(){
  if(_ambiti) return _ambiti;
  const sez = DATA.sezioni.filter(s=>isSitoRapido(s) && s.c);
  const visto = new Set(), out = [];
  sez.forEach(s0=>{
    if(visto.has(s0.id)) return;
    const grp = [s0]; visto.add(s0.id);
    for(let i=0; i<grp.length; i++){
      sez.forEach(s=>{
        if(visto.has(s.id)) return;
        if(metriTra(grp[i].c, s.c) <= AMB_DIST){ grp.push(s); visto.add(s.id); }
      });
    }
    // statistiche dell'ambito
    const idx = bldBySez();
    const bld = [];
    grp.forEach(s=>{ const a = idx[s.id]; if(a) bld.push(...a); });
    const sup = {r:0,e:0,p:0,i:0};
    bld.forEach(b=>{ sup[b[0]] = (sup[b[0]]||0) + (b[2]||0); });
    const mwh = grp.reduce((a,s)=>a+(s.fv_tot||0), 0);
    const cabs = [...new Set(grp.map(s=>s.cab))].filter(c=>c && c!=='NONE');
    const muns = [...new Set(grp.map(s=>s.mun).filter(Boolean))];
    const rig  = {};
    grp.forEach(s=>{ if(s.rig) rig[s.rig] = (rig[s.rig]||0)+1; });
    const rigTop = Object.entries(rig).sort((a,b)=>b[1]-a[1])[0];
    // Tipologia di CER dell'ambito: dal mix effettivo dell'edificato che vi ricade
    const q = {erp:0, pub:0, ind:0, res:0};
    grp.forEach(s=>{ q.erp+=s.fv_mwh||0; q.pub+=s.fv_pub||0; q.ind+=s.fv_ind||0; q.res+=s.fv_res||0; });
    const popA = grp.reduce((x,s)=>x+(s.pop||0),0);
    const popVA = grp.reduce((x,s)=>x+sezPV(s),0);
    const tipo = cerTipologia(q, popA, popVA);
    const lats = grp.map(s=>s.c[1]), lons = grp.map(s=>s.c[0]);
    out.push({ sez:grp, n:grp.length, bld, sup, mwh, cabs, muns, q, tipo, popA, popVA,
               rig: rigTop ? rigTop[0] : null,
               kwp: kwpFromMwh(mwh),
               vulnCab: cabs.reduce((a,id)=>{ const c = DATA.cabine.find(x=>x.id===id); return a + (c?cabPopVuln(c):0); }, 0),
               bounds: [[Math.min(...lats)-0.002, Math.min(...lons)-0.002],
                        [Math.max(...lats)+0.002, Math.max(...lons)+0.002]] });
  });
  // vulnerabili effettivamente servibili con l'energia dell'ambito, dentro le sue cabine
  const consPro = params.cons_kwh/1000;
  out.forEach(a=>{
    a.serviti = Math.min(a.vulnCab, consPro>0 ? Math.floor(a.mwh/consPro) : 0);
    a.tier = a.cabs.map(id=>{ const c = DATA.cabine.find(x=>x.id===id); return c?cabPrio(c).tier:'C3'; })
                   .sort()[0] || 'C3';        // il tier più alto fra le cabine toccate
    a.mwhRap = a.sez.filter(isSitoRapido).reduce((x,s)=>x+(s.fv_tot||0), 0);
    a.quotaRap = a.mwh>0 ? a.mwhRap/a.mwh*100 : 0;   // parte attivabile con iter semplificato
  });
  // PRIORITÀ DI INTERVENTO: guida il numero di vulnerabili presenti nelle cabine
  // servite dall'ambito (criterio sociale). A parità di bisogno viene prima chi può
  // partire più in fretta, cioè chi ha più energia in area idonea: la copertura da sola
  // non discrimina più, perché con tutte le aree ammissibili è ovunque totale.
  out.sort((a,b)=> b.vulnCab - a.vulnCab || b.mwhRap - a.mwhRap || b.mwh - a.mwh);
  out.forEach((a,i)=>a.id = i);
  _ambiti = out;
  return out;
}

// indice sezione → posizione dell'ambito nella classifica finale
let _ambIdx = null;
function ambitoDiSezione(){
  if(_ambIdx) return _ambIdx;
  _ambIdx = {};
  ambitiOrdinati().forEach((a, rank)=>{ a.sez.forEach(s=>{ _ambIdx[s.id] = rank; }); });
  return _ambIdx;
}
// La classifica è già quella di computeAmbiti: priorità per vulnerabili in cabina
function ambitiOrdinati(){ return computeAmbiti(); }

function buildAmbitiPanel(){
  const el = document.getElementById('ambiti-panel');
  if(!el) return;
  const amb = computeAmbiti();
  const R = RIG_TIPI();
  const rows = amb.slice(0,12).map(a=>{
    const r = a.rig && R[a.rig];
    const mixTot = a.q.erp+a.q.pub+a.q.ind+a.q.res || 1;
    const quote = [['ERP',a.q.erp,'#2db885'],['Pub',a.q.pub,'#58a6ff'],['Ind',a.q.ind,'#e3b341'],['Res',a.q.res,'#8fa3bf']]
      .filter(x=>x[1]/mixTot>0.02)
      .map(([n,v,c])=>`<span style="color:${c}">${n} ${(v/mixTot*100).toFixed(0)}%</span>`).join(' · ');
    const TC = {C1:'#ef4444', C2:'#fb923c', C3:'#8b93a8'};
    return `<tr onclick="openAmbito(${a.id})">
      <td style="font-weight:700;color:#facc15">${a.id+1}</td>
      <td class="num" style="color:#a855f7;font-weight:600">${fmt(a.vulnCab)}
          <span style="color:${TC[a.tier]};font-size:10px;font-weight:700"> ${a.tier}</span></td>
      <td class="num">${fmt(a.n)}</td>
      <td class="num">${fmt(a.bld.length)}</td>
      <td class="num">${fmt(Math.round(a.mwh))}</td>
      <td><span style="color:${a.tipo.col};font-size:11.5px;font-weight:600">${a.tipo.n}</span>
          <div style="font-size:10px;color:var(--text-faint)">${quote}</div></td>
      <td>${r?`<span style="color:${r.col};font-size:11px">${r.n}</span>`:'<span style="color:var(--text-faint)">—</span>'}</td>
      <td style="font-size:11px">${a.cabs.map(c=>c.replace('AC001E00','')).join(' · ')}</td>
      <td class="num" style="color:#f97316;font-weight:600">${fmt(a.serviti)}</td>
      <td><span class="toolbar-btn" style="font-size:11px">🔎 apri</span></td>
    </tr>`;
  }).join('');
  const totMwh = amb.reduce((a,x)=>a+x.mwh,0);
  el.innerHTML = `
    <div class="section-title">🔎 Ambiti di intervento — dalla pianificazione al progetto</div>
    <div class="table-wrap" style="border-top:3px solid #facc15">
      <div class="table-header"><div>
        <div class="table-title">${fmt(amb.length)} ambiti prioritari</div>
        <div class="table-sub">Sezioni prioritarie contigue (entro ${AMB_DIST} m) raggruppate in ambiti di progetto: è la scala a cui si dimensiona un impianto e si scrive un bando. Click su una riga per lo <strong>zoom sugli edifici</strong>.</div>
      </div>
      <div style="text-align:right"><div style="font-family:var(--font-display);font-size:24px;color:#facc15;line-height:1">${(totMwh/1000).toFixed(1)}</div><div style="font-size:10.5px;color:var(--text-muted)">GWh/a complessivi</div></div></div>
      <table>
        <thead><tr><th>#</th><th class="num">Vuln. in cabina</th><th class="num">Sezioni</th><th class="num">Edifici</th><th class="num">MWh/a</th>
          <th>Tipologia di CER e mix dell'edificato</th><th>Rigenerazione abilitata</th><th>Cabine</th><th class="num">Serviti</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// ---------- Step 9: indicazioni per il PAESC ----------
function buildPaescPanel(){
  const el = document.getElementById('paesc-panel');
  if(!el) return;
  const cab = [...DATA.cabine].sort((a,b)=>cabSolution(b).serviti - cabSolution(a).serviti);
  const tot = cab.reduce((a,c)=>{ const s = cabSolution(c); return {mwh:a.mwh+s.mwh, serv:a.serviti+s.serviti, serviti:a.serviti+s.serviti}; }, {mwh:0, serviti:0}).mwh;
  const totServ = cab.reduce((a,c)=>a+cabSolution(c).serviti, 0);
  const rows = cab.map(c=>{
    const s = cabSolution(c), pr = cabPrio(c), t = cerTipoOf(c);
    return `<tr>
      <td><span class="cabina-code">${c.id.replace('AC001E00','')}</span> <span style="color:${pr.color};font-size:10px;font-weight:700">${pr.tier}</span></td>
      <td><span style="color:${t.col};font-size:11.5px">${t.n}</span></td>
      <td class="num">${s.mwh>0?fmt(Math.round(s.mwh)):'—'}</td>
      <td class="num">${fmt(Math.round(s.mwh*CO2_T_MWH))}</td>
      <td class="num" style="color:#f97316;font-weight:600">${fmt(s.serviti)}</td>
      <td><button class="toolbar-btn" style="font-size:11px" onclick="event.stopPropagation();buildSchedaPaesc('${c.id}')">📄 scheda</button></td>
    </tr>`;
  }).join('');
  el.innerHTML = `
    <div class="section-title">📄 Indicazioni per il PAESC — dalle aree prioritarie alle schede d'azione</div>
    <div class="table-wrap" style="border-top:3px solid #1f5bab">
      <div class="table-header"><div>
        <div class="table-title">Dodici schede d'azione, una per ambito di cabina</div>
        <div class="table-sub">Ogni scheda riporta obiettivo, tipologia di CER e promotori, quadro di ammissibilità, siti individuati, risultati attesi in MWh/a e t CO₂/a, tempi e indicatori di monitoraggio. Formato stampabile A4, pronto per l'allegato al piano.</div>
      </div>
      <div style="display:flex;gap:20px;text-align:right;flex-wrap:wrap">
        <div><div style="font-family:var(--font-display);font-size:24px;color:var(--accent2);line-height:1">${(tot/1000).toFixed(1)}</div><div style="font-size:10.5px;color:var(--text-muted)">GWh/a in gioco</div></div>
        <div><div style="font-family:var(--font-display);font-size:24px;color:#22c55e;line-height:1">${fmt(Math.round(tot*CO2_T_MWH))}</div><div style="font-size:10.5px;color:var(--text-muted)">t CO₂/a evitate</div></div>
        <div><div style="font-family:var(--font-display);font-size:24px;color:#f97316;line-height:1">${fmt(totServ)}</div><div style="font-size:10.5px;color:var(--text-muted)">vulnerabili serviti</div></div>
      </div></div>
      <table><thead><tr><th>Cabina</th><th>Tipologia di CER</th><th class="num">MWh/a</th><th class="num">t CO₂/a</th><th class="num">Vulnerabili serviti</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table>
    </div>`;
}

// ---------- Step 10: i dieci ambiti prioritari, sintesi del framework ----------
function buildTop10Panel(){
  const el = document.getElementById('top10-panel');
  if(!el) return;
  const ord = ambitiOrdinati().slice(0,10);
  const R = RIG_TIPI();
  const TCOL = {C1:'#ef4444', C2:'#fb923c', C3:'#8b93a8'};
  const rows = ord.map((a,i)=>{
    const r = a.rig && R[a.rig];
    const cop = a.vulnCab>0 ? a.serviti/a.vulnCab*100 : 0;
    return `<tr onclick="openAmbito(${a.id})">
      <td><span style="display:inline-flex;width:24px;height:24px;border-radius:50%;background:#f97316;color:#1a1204;
        align-items:center;justify-content:center;font-weight:700;font-size:12px">${i+1}</span></td>
      <td class="num" style="font-weight:700;color:#a855f7">${fmt(a.vulnCab)}</td>
      <td><span style="color:${TCOL[a.tier]};font-weight:700;font-size:11.5px">${a.tier}</span></td>
      <td class="num" style="color:#f97316;font-weight:700">${fmt(a.serviti)}</td>
      <td><span style="display:inline-block;width:56px;height:6px;border-radius:99px;background:var(--surface3);overflow:hidden;vertical-align:middle;margin-right:6px"><span style="display:block;height:100%;width:${Math.min(100,cop).toFixed(0)}%;background:${cop>=100?'#22c55e':cop>=50?'#facc15':'#f97316'}"></span></span>${cop.toFixed(0)}%</td>
      <td class="num" style="color:${a.quotaRap>=30?'#22c55e':a.quotaRap>=5?'#facc15':'#8b93a8'}">${a.quotaRap>=1?a.quotaRap.toFixed(0)+'%':'—'}</td>
      <td class="num">${fmt(Math.round(a.mwh))}</td>
      <td><span style="color:${a.tipo.col};font-size:11.5px">${a.tipo.n}</span></td>
      <td style="font-size:11px">${r?`<span style="color:${r.col}">${r.n}</span>`:'—'}</td>
      <td style="font-size:11px">${a.cabs.map(c=>c.replace('AC001E00','')).join(' · ')}<div style="color:var(--text-faint)">Munic. ${a.muns.join(' · ')}</div></td>
      <td><span class="toolbar-btn" style="font-size:11px">🔎 zoom</span></td>
    </tr>`;
  }).join('');
  const sMwh = ord.reduce((a,x)=>a+x.mwh,0), sServ = ord.reduce((a,x)=>a+x.serviti,0);
  const vulnTot = DATA.sezioni.reduce((a,s)=>a+sezPV(s),0);
  el.innerHTML = `
    <div class="section-title">🏁 I dieci ambiti prioritari — esito del framework</div>
    <div class="table-wrap" style="border-top:3px solid #f97316">
      <div class="table-header"><div>
        <div class="table-title">Dove far partire la CER a Napoli</div>
        <div class="table-sub">Ambiti ordinati per <strong>numero di residenti vulnerabili presenti nelle cabine</strong> che ciascuno attraversa — il criterio di priorità sociale del framework. L'energia producibile e la quota di domanda coperta sono riportate accanto, come misura di quanto l'ambito riesce a rispondere a quel bisogno. Click per lo zoom di progetto.</div>
      </div>
      <div style="display:flex;gap:20px;text-align:right;flex-wrap:wrap">
        <div><div style="font-family:var(--font-display);font-size:24px;color:#facc15;line-height:1">${(sMwh/1000).toFixed(1)}</div><div style="font-size:10.5px;color:var(--text-muted)">GWh/a dai primi 10</div></div>
        <div><div style="font-family:var(--font-display);font-size:24px;color:#f97316;line-height:1">${fmt(sServ)}</div><div style="font-size:10.5px;color:var(--text-muted)">vulnerabili servibili · ${vulnTot?(sServ/vulnTot*100).toFixed(0):0}% della città</div></div>
      </div></div>
      <table><thead><tr><th>#</th><th class="num">Vulnerabili in cabina</th><th>Tier</th><th class="num">Servibili</th><th>Copertura</th><th class="num">Iter rapido</th><th class="num">MWh/a</th>
        <th>Tipologia di CER</th><th>Rigenerazione</th><th>Cabine</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table>
    </div>
    <div style="font-size:11px;color:var(--text-faint);padding:8px 4px 0;line-height:1.5">Con i soli primi dieci ambiti — ${fmt(ord.reduce((a,x)=>a+x.bld.length,0))} edifici in tutto — si raggiunge il ${vulnTot?(sServ/vulnTot*100).toFixed(0):0}% della popolazione vulnerabile della città. È la misura di quanto una strategia concentrata possa rendere più di un'azione diffusa.</div>`;
}

// ---- Zoom di progetto su un ambito ----
let ambMap = null;
function openAmbito(id){
  const a = computeAmbiti()[id];
  if(!a) return;
  const R = RIG_TIPI(), r = a.rig && R[a.rig];
  const perTipo = ['e','p','i','r'].filter(k=>a.sup[k]>0).map(k=>{
    const n = a.bld.filter(b=>b[0]===k).length;
    return `<tr><td><span style="display:inline-block;width:11px;height:11px;border-radius:3px;background:${BLD_COLORS[k]};margin-right:7px"></span>${BLD_LABELS[k]}</td>
      <td class="num">${fmt(n)}</td><td class="num">${fmt(Math.round(a.sup[k]))} m²</td>
      <td class="num">~${fmt(Math.round(a.sup[k]*0.5*0.20))} kWp</td></tr>`;
  }).join('');
  const grandi = [...a.bld].sort((x,y)=>(y[2]||0)-(x[2]||0)).slice(0,10).map((b,i)=>`
    <tr><td>${i+1}</td><td>${bldName(b) || BLD_LABELS[b[0]]}</td>
      <td><span style="color:${BLD_COLORS[b[0]]}">${BLD_LABELS[b[0]]}</span>${bldUso(b)?' · '+bldUso(b):''}</td>
      <td class="num">${fmt(b[2]||0)} m²</td><td class="num">~${fmt(Math.round((b[2]||0)*0.1))} kWp</td></tr>`).join('');
  document.getElementById('ambito-body').innerHTML = `
    <div class="amb-head">
      <div>
        <div class="amb-eyebrow">Ambito di intervento ${a.id+1} · zoom di progetto</div>
        <h2 class="amb-title">${fmt(a.n)} sezioni prioritarie · ${fmt(a.bld.length)} edifici</h2>
        <div class="amb-sub">Cabine ${a.cabs.map(c=>c.replace('AC001E00','')).join(' · ')} · Municipalità ${a.muns.join(' · ')}
          ${r?` · <span style="color:${r.col}">${r.n}</span>`:''}</div>
      </div>
      <div class="amb-kpi">
        <div><b>${fmt(Math.round(a.mwh))}</b><span>MWh/anno</span></div>
        <div><b>${fmt(Math.round(a.kwp))}</b><span>kWp stimati</span></div>
        <div><b>${fmt(Math.min(a.vulnCab, Math.floor(a.mwh/(params.cons_kwh/1000))))}</b><span>vulnerabili servibili</span></div>
      </div>
    </div>
    <div class="amb-note" style="border-left-color:${a.tipo.col}">⚡ <strong style="color:${a.tipo.col}">${a.tipo.n}</strong> — ${a.tipo.d}
      <div style="margin-top:6px;color:var(--text-faint)">Promotori: ${a.tipo.p}. Mix dell'edificato:
      ${[['ERP',a.q.erp,'#2db885'],['pubblico',a.q.pub,'#58a6ff'],['produttivo',a.q.ind,'#e3b341'],['residenziale',a.q.res,'#8fa3bf']]
        .filter(x=>x[1]>0).sort((x,y)=>y[1]-x[1])
        .map(([n,v,c])=>`<span style="color:${c}">${n} ${(v/((a.q.erp+a.q.pub+a.q.ind+a.q.res)||1)*100).toFixed(0)}%</span>`).join(' · ')}.</div>
    </div>
    ${r?`<div class="amb-note">🏗 <strong>${r.n}</strong> — ${r.d}</div>`:''}
    <div id="amb-map"></div>
    <div class="amb-cols">
      <div>
        <h3 class="amb-h3">Coperture disponibili per categoria</h3>
        <table class="amb-tab"><thead><tr><th>Categoria</th><th class="num">Edifici</th><th class="num">Superficie</th><th class="num">Potenza</th></tr></thead>
        <tbody>${perTipo}</tbody></table>
      </div>
      <div>
        <h3 class="amb-h3">Le dieci coperture maggiori</h3>
        <table class="amb-tab"><thead><tr><th>#</th><th>Edificio</th><th>Tipo</th><th class="num">Tetto</th><th class="num">kWp</th></tr></thead>
        <tbody>${grandi}</tbody></table>
      </div>
    </div>
    <div class="amb-foot">Potenza stimata con 50% di copertura utilizzabile e 20% di efficienza; producibilità dal modello di radiazione solare. I vulnerabili servibili sono calcolati sul perimetro delle cabine interessate, entro cui l'energia può essere condivisa.</div>`;
  document.getElementById('ambito-overlay').classList.add('visible');
  setTimeout(()=>{
    if(ambMap){ ambMap.remove(); ambMap = null; }
    ambMap = L.map('amb-map', {zoomControl:true, attributionControl:false});
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      {maxZoom:19}).addTo(ambMap);
    ambMap.fitBounds(a.bounds);
    // sezioni dell'ambito
    L.geoJSON({type:'FeatureCollection', features:a.sez.filter(s=>s.geom&&s.geom.length>=3).map(s=>({
      type:'Feature', properties:{}, geometry:{type:'Polygon', coordinates:[s.geom]}}))},
      {interactive:false, style:{color:'#facc15', weight:2, fill:false, dashArray:'5 4'}}).addTo(ambMap);
    // edifici cliccabili
    const rend = L.canvas({padding:0.3});
    const polys = a.bld.map(b=>{
      const p = L.polygon(decodeRing(b[3]), {renderer:rend, color:'#0b0e14', weight:0.7,
        fillColor:BLD_COLORS[b[0]], fillOpacity:0.95});
      p._b = b; return p;
    });
    const g = L.featureGroup(polys).addTo(ambMap);
    bindBldInteractions(g);
    setTimeout(()=>ambMap.invalidateSize(), 150);
  }, 60);
}
function closeAmbito(ev){
  const ov = document.getElementById('ambito-overlay');
  if(ov && (!ev || ev.target===ov || ev.target.closest('.ambito-close'))){
    ov.classList.remove('visible');
    if(ambMap){ ambMap.remove(); ambMap = null; }
  }
}

// ---------- 🏛 Lettura per Municipalità ----------
// La cabina è il perimetro tecnico-legale della condivisione; la Municipalità è
// l'unità della governance urbana. I due reticoli non coincidono, e mostrarlo è
// parte del risultato: una CER "di quartiere" attraversa più ambiti elettrici.
const MUN_COLORS = ['#60a5fa','#f472b6','#34d399','#fbbf24','#a78bfa',
                    '#fb7185','#22d3ee','#a3e635','#fb923c','#c084fc'];
const munNome = m => (DATA.meta.municipalita && DATA.meta.municipalita[String(m)]) || ('Municipalità '+m);
let _munAgg = null;
function munAgg(){
  if(_munAgg) return _munAgg;
  const a = {};
  DATA.sezioni.forEach(s=>{
    const m = s.mun; if(!m) return;
    const o = a[m] || (a[m] = {mun:m, sez:0, pop:0, popV:0, erp:0, pub:0, ind:0, res:0,
                               siti:0, mwhSiti:0, cabs:{}, nFac:0, nBlk:0});
    o.sez++; o.pop += s.pop||0; o.popV += sezPV(s);
    o.erp += s.fv_mwh||0; o.pub += s.fv_pub||0; o.ind += s.fv_ind||0; o.res += s.fv_res||0;
    const st = normStatus(s).code;
    if(st==='fac') o.nFac++; else if(st==='blk') o.nBlk++;
    if(isSitoAttivabile(s)){ o.siti++; o.mwhSiti += s.fv_tot||0; }
    if(s.cab && s.cab!=='NONE') o.cabs[s.cab] = (o.cabs[s.cab]||0)+1;
  });
  _munAgg = a;
  return a;
}
function buildMunPanel(){
  const el = document.getElementById('mun-panel');
  if(!el) return;
  const a = munAgg();
  const list = Object.values(a).sort((x,y)=>x.mun-y.mun);
  const consPro = params.cons_kwh/1000;
  const rows = list.map(o=>{
    const t = cerTipologia({erp:o.erp, pub:o.pub, ind:o.ind, res:o.res}, o.pop, o.popV);
    const serviti = Math.min(o.popV, consPro>0 ? Math.floor(o.mwhSiti/consPro) : 0);
    const cabs = Object.entries(o.cabs).sort((x,y)=>y[1]-x[1]);
    return `<tr>
      <td><span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${MUN_COLORS[(o.mun-1)%10]};margin-right:7px"></span><strong>${o.mun}</strong></td>
      <td style="font-size:11.5px;line-height:1.35">${munNome(o.mun)}</td>
      <td class="num">${fmt(o.pop)}</td>
      <td class="num" style="color:#a855f7">${fmt(o.popV)}</td>
      <td><span style="font-size:11px;font-weight:600;color:${t.col}">${t.n}</span>
          <div style="font-size:10px;color:var(--text-faint)">${t.p}</div></td>
      <td class="num">${fmt(o.siti)}</td>
      <td class="num">${o.mwhSiti>0?fmt(Math.round(o.mwhSiti)):'—'}</td>
      <td class="num" style="color:#f97316;font-weight:600">${fmt(serviti)}</td>
      <td style="font-size:10.5px;color:var(--text-muted)">${cabs.length} cabine<div style="color:var(--text-faint)">${cabs.slice(0,3).map(([c,n])=>c.replace('AC001E00','')+' ('+n+')').join(' · ')}</div></td>
    </tr>`;
  }).join('');
  const nCab = list.map(o=>Object.keys(o.cabs).length);
  el.innerHTML = `
    <div class="section-title">🏛 Lettura per Municipalità — tipologia di CER e attuazione</div>
    <div class="table-wrap" style="border-top:3px solid var(--accent)">
      <div class="table-header"><div>
        <div class="table-title">Le 10 Municipalità di Napoli</div>
        <div class="table-sub">La <strong>tipologia di CER</strong> deriva dal mix dell'edificato — ERP, pubblico, produttivo, residenziale — che determina chi può fare da produttore di avvio. Ogni Municipalità è attraversata da più cabine primarie: la configurazione va costruita sull'intersezione dei due perimetri.</div>
      </div></div>
      <table>
        <thead><tr><th>M.</th><th>Denominazione</th><th class="num">Abitanti</th><th class="num">Vulnerabili</th>
          <th>Tipologia di CER e promotori</th><th class="num">Siti</th><th class="num">MWh/a</th><th class="num">Serviti</th><th>Cabine</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div style="font-size:11px;color:var(--text-faint);padding:8px 4px 0;line-height:1.5">I due reticoli non coincidono: le Municipalità sono attraversate da un minimo di ${Math.min(...nCab)} a un massimo di ${Math.max(...nCab)} cabine primarie. Nessuna CER può quindi coincidere con un confine amministrativo: la governance urbana e il perimetro di condivisione vanno tenuti insieme in sede di accordo.</div>`;
}

// ---------- 📄 Scheda d'azione PAESC per ambito di cabina ----------
// Formato delle schede del Piano d'Azione per l'Energia Sostenibile e il Clima:
// obiettivo, soggetto responsabile, risultati attesi in MWh/a e t CO₂/a, tempi,
// indicatori di monitoraggio. È il documento che porta l'esito dell'SSD dentro
// lo strumento di programmazione energetica comunale.
const CO2_T_MWH = 0.33;      // fattore di emissione del mix elettrico (da allineare al BEI)
const EUR_KWP   = 1100;      // costo parametrico impianto su copertura (€/kWp)

function schedaRegia(c, sez){
  // Chi può attuare: la fonte prevalente determina il soggetto responsabile
  const siti = sez.filter(isSitoAttivabile);
  const q = {erp:0, pub:0, ind:0, res:0};
  siti.forEach(s=>{ q.erp+=s.fv_mwh||0; q.pub+=s.fv_pub||0; q.ind+=s.fv_ind||0; q.res+=s.fv_res||0; });
  const tot = q.erp+q.pub+q.ind+q.res || 1;
  const reg = [
    {k:'pub', n:'Patrimonio comunale', s:'Comune di Napoli — azione diretta su scuole, uffici e impianti sportivi', mwh:q.pub},
    {k:'erp', n:'Edilizia residenziale pubblica', s:'Ente gestore ERP con il Comune — configurazione solidale a beneficio degli assegnatari', mwh:q.erp},
    {k:'ind', n:'Coperture produttive', s:'Partenariato pubblico-privato con le imprese insediate', mwh:q.ind},
    {k:'res', n:'Edilizia residenziale privata', s:'Condomini e amministratori, con ESCo o sportello energia comunale', mwh:q.res},
  ].filter(r=>r.mwh>0).sort((a,b)=>b.mwh-a.mwh);
  return {reg, tot, siti};
}

function buildSchedaPaesc(cabId){
  const c = DATA.cabine.find(x=>x.id===cabId);
  if(!c) return;
  const sez = DATA.sezioni.filter(s=>s.cab===cabId);
  const pr = cabPrio(c), sol = cabSolution(c), n = cabNorm(c);
  const {reg, siti} = schedaRegia(c, sez);
  const kwp  = kwpFromMwh(sol.mwh);
  const co2  = sol.mwh * CO2_T_MWH;
  const costo = kwp * EUR_KWP;
  const tempi = {C1:['Breve termine (entro 2 anni)','azione prioritaria: massima concentrazione di popolazione vulnerabile'],
                 C2:['Medio termine (2-4 anni)','secondo fronte di attuazione, dopo il consolidamento delle esperienze C1'],
                 C3:['Lungo termine / sperimentale','contesto a bassa complessità, adatto a testare il modello di governance']}[pr.tier];
  const topSiti = siti.sort((a,b)=>(b.fv_tot||0)-(a.fv_tot||0)).slice(0,8);
  const tipo = cerTipoOf(c);
  const mixTot = (c.fv_erp_mwh||0)+(c.fv_pub_mwh||0)+(c.fv_ind_mwh||0)+(c.fv_res_mwh||0) || 1;
  const mixTxt = [['ERP', c.fv_erp_mwh], ['pubblico', c.fv_pub_mwh], ['produttivo', c.fv_ind_mwh],
                  ['residenziale privato', c.fv_res_mwh]]
                 .filter(x=>(x[1]||0)>0).sort((a,b)=>b[1]-a[1])
                 .map(([n,v])=>`${n} ${(v/mixTot*100).toFixed(0)}%`).join(' · ');
  // Municipalità attraversate dall'ambito: il raccordo con la governance urbana
  const mc = {};
  sez.forEach(s=>{ if(s.mun) mc[s.mun] = (mc[s.mun]||0)+1; });
  const munTxt = Object.entries(mc).sort((a,b)=>b[1]-a[1])
    .map(([m,n])=>`<strong>${m}</strong> ${munNome(m).split(' · ')[0]} (${(n/sez.length*100).toFixed(0)}%)`).join(' · ') || '—';
  const row = (l,v) => `<tr><th style="text-align:left;padding:5px 10px 5px 0;font-weight:600;color:#444;width:38%">${l}</th><td style="padding:5px 0">${v}</td></tr>`;

  const el = document.getElementById('scheda-body');
  el.innerHTML = `
    <div class="sch-head">
      <div>
        <div class="sch-eyebrow">Comune di Napoli · PAESC — Piano d'Azione per l'Energia Sostenibile e il Clima</div>
        <h1 class="sch-title">Scheda d'azione · Comunità Energetica Rinnovabile</h1>
        <div class="sch-sub">Ambito della cabina primaria <strong>${c.id}</strong> — priorità <strong>${pr.tier} · ${pr.label}</strong></div>
      </div>
      <div class="sch-code">CER<br>${c.id.replace('AC001E00','')}</div>
    </div>

    <h2 class="sch-h2">1 · Inquadramento territoriale</h2>
    <table class="sch-tab">
      ${row('Perimetro di riferimento', `Area della cabina primaria ${c.id} — unità entro cui la normativa consente la condivisione dell'energia (art. 31 D.Lgs. 199/2021)`)}
      ${row('Estensione', `${c.area_km2} km² · ${fmt(c.sez_count)} sezioni censuarie abitate`)}
      ${row('Popolazione residente', `${fmt(c.pop_tot)} abitanti`)}
      ${row('Popolazione in condizione di vulnerabilità', `${fmt(sol.popV)} abitanti (IVSM > ${THR}) — pari al ${c.pop_tot?(sol.popV/c.pop_tot*100).toFixed(1):0}% dei residenti`)}
      ${row('Municipalità interessate', munTxt)}
      ${row('Classificazione di priorità', `${pr.tier} — ${pr.label}; classificazione per numero assoluto di residenti vulnerabili (Jenks su 12 ambiti)`)}
    </table>

    <h2 class="sch-h2">2 · Tipologia di comunità energetica</h2>
    <table class="sch-tab">
      ${row('Configurazione proposta', `<strong style="color:#1f5bab">${tipo.n}</strong>`)}
      ${row('Motivazione', tipo.d)}
      ${row('Promotori', tipo.p)}
      ${row('Mix delle coperture', mixTxt)}
      ${row('Configurazione minima sufficiente', sol.scenMin
        ? `<strong>${sol.scenMin.n}</strong> — ${sol.scenMin.lbl}: già da sola copre il fabbisogno elettrico stimato dei residenti vulnerabili dell'ambito`
        : `Nessuna configurazione istituzionale copre da sola l'intero fabbisogno: con ERP, patrimonio pubblico e coperture produttive insieme si raggiunge il <strong>${sol.cop.toFixed(0)}%</strong>. Il residuo richiede l'apertura ai prosumer residenziali o la riqualificazione energetica del patrimonio ERP.`)}
      ${row('Copertura per configurazione', SCENARI.filter(x=>!x.limite).map(sc=>
        `${sc.n} ${scenarioCab(c, sc.k).cop.toFixed(0)}%`).join(' · '))}
    </table>

    <h2 class="sch-h2">3 · Obiettivo dell'azione</h2>
    <p class="sch-p">Costituire una Comunità Energetica Rinnovabile a finalità solidale nell'ambito della cabina primaria ${c.id},
    localizzando gli impianti fotovoltaici sulle coperture che presentano la maggiore producibilità e ricadono in
    <strong>aree idonee</strong> ai sensi del DM 21 giugno 2024, e destinando l'energia condivisa in via prioritaria ai
    nuclei familiari in condizione di vulnerabilità socio-materiale residenti nell'ambito.</p>

    <h2 class="sch-h2">4 · Quadro di ammissibilità normativa</h2>
    <table class="sch-tab">
      ${row('Riferimenti', 'DM 21/06/2024 (Decreto Aree Idonee), attuativo dell\'art. 20 D.Lgs. 199/2021 — Piattaforma Aree Idonee MASE/GSE')}
      ${row('Sezioni in area idonea', `${fmt(n.nFac)} — procedura autorizzativa semplificata`)}
      ${row('Sezioni in area non idonea', `${fmt(n.nBlk)} — installazione esclusa dalla programmazione; i residenti restano beneficiari della condivisione`)}
      ${row('Quota di potenziale non attivabile', `${fmt1(n.pctFvBlk)}% del fotovoltaico dell'ambito ricade in aree non idonee`)}
    </table>

    <h2 class="sch-h2">5 · Siti individuati per l'installazione</h2>
    ${topSiti.length ? `<table class="sch-tab sch-grid">
      <thead><tr><th>Sezione</th><th>Uso prevalente</th><th class="r">Producibilità</th><th class="r">Energia (MWh/a)</th></tr></thead>
      <tbody>${topSiti.map(s=>{
        const u = [['ERP',s.fv_mwh||0],['Pubblico',s.fv_pub||0],['Industriale',s.fv_ind||0],['Residenziale',s.fv_res||0]]
                  .sort((a,b)=>b[1]-a[1])[0][0];
        return `<tr><td>${s.id}</td><td>${u}</td><td class="r">${fmt1(prodIndex(s))}/100</td><td class="r">${fmt(Math.round(s.fv_tot||0))}</td></tr>`;
      }).join('')}</tbody></table>
      ${siti.length>8?`<p class="sch-note">Elenco dei primi 8 siti per producibilità; l'ambito ne conta complessivamente ${fmt(siti.length)}.</p>`:''}`
      : `<p class="sch-p">Nell'ambito non risultano sezioni che uniscano alta producibilità e ammissibilità in area idonea.
         L'attuazione richiede il ricorso ad aree ordinarie con iter autorizzativo standard, oppure accordi di
         condivisione con ambiti limitrofi.</p>`}

    <h2 class="sch-h2">6 · Risultati attesi</h2>
    <table class="sch-tab">
      ${row('Potenza installabile stimata', `${fmt(Math.round(kwp))} kWp`)}
      ${row('Produzione da fonte rinnovabile', `<strong>${fmt(Math.round(sol.mwh))} MWh/anno</strong>`)}
      ${row('Emissioni di CO₂ evitate', `<strong>${fmt(Math.round(co2))} t CO₂/anno</strong> <span class="sch-small">(fattore ${CO2_T_MWH} t/MWh — da allineare al fattore dell'inventario base delle emissioni)</span>`)}
      ${row('Popolazione vulnerabile servita', `<strong>${fmt(sol.serviti)} persone</strong> su ${fmt(sol.popV)} — copertura del ${sol.popV?Math.min(100,sol.serviti/sol.popV*100).toFixed(0):0}% della domanda`)}
      ${row('Investimento parametrico', `${(costo/1e6).toFixed(2)} M€ <span class="sch-small">(${EUR_KWP} €/kWp, stima di larga massima)</span>`)}
    </table>

    <h2 class="sch-h2">7 · Soggetti responsabili e regia</h2>
    ${reg.length ? `<table class="sch-tab sch-grid">
      <thead><tr><th>Categoria di copertura</th><th>Soggetto responsabile</th><th class="r">Quota</th></tr></thead>
      <tbody>${reg.map(r=>`<tr><td>${r.n}</td><td>${r.s}</td><td class="r">${(r.mwh/reg.reduce((a,x)=>a+x.mwh,0)*100).toFixed(0)}%</td></tr>`).join('')}</tbody>
    </table>` : '<p class="sch-p">Da definire in sede di progettazione, in assenza di siti ottimali nell\'ambito.</p>'}
    <p class="sch-note">Coordinamento generale: Comune di Napoli — Servizio Energia, in raccordo con l'ente gestore del patrimonio ERP e il distributore di rete.</p>

    <h2 class="sch-h2">8 · Tempi di attuazione</h2>
    <table class="sch-tab">
      ${row('Orizzonte', `<strong>${tempi[0]}</strong>`)}
      ${row('Motivazione', tempi[1])}
      ${row('Fasi', '1) manifestazione d\'interesse e individuazione dei membri · 2) studio di fattibilità sui siti elencati · 3) costituzione del soggetto giuridico · 4) progettazione e autorizzazioni · 5) realizzazione e attivazione della configurazione')}
    </table>

    <h2 class="sch-h2">9 · Indicatori di monitoraggio</h2>
    <table class="sch-tab sch-grid">
      <thead><tr><th>Indicatore</th><th>Unità</th><th class="r">Valore obiettivo</th></tr></thead>
      <tbody>
        <tr><td>Potenza fotovoltaica installata nell'ambito</td><td>kWp</td><td class="r">${fmt(Math.round(kwp))}</td></tr>
        <tr><td>Energia condivisa annua</td><td>MWh/a</td><td class="r">${fmt(Math.round(sol.mwh))}</td></tr>
        <tr><td>Membri della configurazione in condizione di vulnerabilità</td><td>persone</td><td class="r">${fmt(sol.serviti)}</td></tr>
        <tr><td>Emissioni evitate</td><td>t CO₂/a</td><td class="r">${fmt(Math.round(co2))}</td></tr>
        <tr><td>Quota di domanda vulnerabile coperta</td><td>%</td><td class="r">${sol.popV?Math.min(100,sol.serviti/sol.popV*100).toFixed(0):0}</td></tr>
      </tbody>
    </table>

    <h2 class="sch-h2">10 · Fonti dei dati</h2>
    <p class="sch-note">Perimetri delle cabine primarie: GSE, mappa interattiva delle cabine primarie · Classificazione delle aree:
    Piattaforma Aree Idonee MASE/GSE, DM 21/06/2024 · Producibilità fotovoltaica: modello di radiazione solare su modello digitale
    di superficie, coefficiente netto 0,085 · Vulnerabilità: indice IVSM rielaborato su Censimento ISTAT 2021 e patrimonio ERP
    comunale · Consumo di riferimento: ${fmt(params.cons_kwh)} kWh per abitante/anno.<br>
    Elaborazione: SSD Energia Urbana v8 — ${new Date().toLocaleDateString('it-IT')}.</p>`;
  document.getElementById('scheda-overlay').classList.add('visible');
}
function closeScheda(ev){
  const ov = document.getElementById('scheda-overlay');
  if(ov && (!ev || ev.target===ov || ev.target.closest('.scheda-close'))) ov.classList.remove('visible');
}
function stampaScheda(){ window.print(); }

// ---------- ℹ️ Metodologia (modal) ----------
function openMetodo(){
  const ov = document.getElementById('metodo-overlay');
  if(ov) ov.classList.add('visible');
}
function closeMetodo(ev){
  const ov = document.getElementById('metodo-overlay');
  if(ov && (!ev || ev.target===ov || ev.target.closest('.metodo-close'))) ov.classList.remove('visible');
}
function navHome(btn){
  if(document.getElementById('view-cabina').style.display!=='none') backToNapoli();
  document.querySelectorAll('.header-nav .nav-btn').forEach(b=>b.classList.remove('active'));
  if(btn) btn.classList.add('active');
}

// ---------- Parametri ----------
function updateParam(key, val){
  if(key==='cons'){
    params.cons_kwh = parseInt(val);
    document.getElementById('lbl-cons').textContent = fmt(parseInt(val))+' kWh/anno';
  }
  updateDemand(activeCabina);
  if(activeCabina) openCabina(activeCabina);
}
