# Consegna del progetto — SSD per le CER di Napoli (v8)

Documento per chi riprende il lavoro su un altro computer, da solo o con un assistente
come Claude Code. Contiene stato, architettura, comandi e decisioni prese finora.
Autore del lavoro: Valerio Martinelli (dottorato, Università Federico II — DICEA).

---

## 1. Cos'è

Un **sistema di supporto alle decisioni** che individua dove conviene attivare
Comunità Energetiche Rinnovabili a Napoli, incrociando tre famiglie di fattori:

1. **urbanistico-normativi** — perimetri delle 12 cabine primarie (unità legale di
   condivisione, D.Lgs. 199/2021) e classificazione aree idonee / ordinarie / non
   idonee del **DM 21/06/2024**, da Piattaforma Aree Idonee MASE-GSE;
2. **climatico-ambientali** — potenziale fotovoltaico dei tetti da modello digitale
   di superficie, distinto per ERP · pubblico · industriale · residenziale;
3. **socio-economici** — indice di vulnerabilità sociale e materiale (IVSM) per
   sezione censuaria, come misura della povertà energetica.

L'esito è la graduatoria delle sezioni dove installare (indicatore **FER_100**) e
l'indicazione di chi ne beneficia.

L'interfaccia è organizzata sui **6 step** della metodologia di dottorato
(vedi `Presentazione 2 anni e mezzo_lunedi.pptx`, slide 118-166).

## 2. Regola da non violare

> **L'IVSM non è mai filtrato dalla normativa.**
> Le aree non idonee bloccano la *localizzazione dell'impianto*, mai la platea dei
> beneficiari: i residenti di quelle sezioni restano membri della CER, perché
> l'energia si condivide dentro tutta la cabina primaria.

## 3. File del progetto

| File | Ruolo |
|---|---|
| `index.html` + `app.js` | interfaccia (versione di sviluppo) |
| `dataset.json` | 5.689 sezioni + 12 cabine, con quadro normativo per sezione |
| `aree_overlay.json` | perimetri PAI semplificati (25 idonee, 476 non idonee) |
| `footprints.json` | impronte di 35.131 edifici, compresse (2,5 MB) |
| `merge_aree_idonee.py` | integra i dati normativi nel dataset |
| `build_footprints.py` | estrae le impronte degli edifici dai GeoJSON |
| `build_standalone.py` | genera il file unico distribuibile |
| `esporta_conversazione.py` | esporta la cronologia di lavoro in HTML leggibile |
| `SSD-v8-Napoli-standalone.html` | **il prodotto finito**, apribile con doppio click |

**Importante:** consegnare sempre lo standalone. La versione di sviluppo, aperta con
doppio click, viene bloccata dal browser (protocollo `file://`).

## 4. Dati di origine

Cartella `C:\Progetti_GIS\GIS_lisbona\napoli\Geodatabase\` (da copiare insieme al
progetto se si vuole rigenerare tutto):

- `Renewable energy supply baseline.geojson` — 164 MB, per sezione: `FRAZ_IDON`,
  `FRAZ_NONID`, `FER_SCORE`, `PV_tot_100_`, `CER_OFFER_100`
- `Aree_idonee.geojson` / `Aree non idonee.geojson` — perimetri PAI
- `Residential_build.geojson`, `Edificato_ERP__…`, `tetti_pubblico__…`,
  `tetti_industriali__…` — impronte degli edifici
- `ERP_sezioni_final_FeaturesToJSO.geojson` — geometrie di tutte le sezioni

### Trappole nei nomi dei campi (verificate)

- `FER_100` nell'export ArcGIS **non** è il composito: vale `FER_SCORE × 100`.
- `PV_tot_100` è vuoto: il campo valido è **`PV_tot_100_`** (con underscore finale).
- Il composito tecnica × normativa è **`CER_OFFER_100`** = (FER_SCORE×100 + PV_tot_100_)/2.
- `SEZ21` è nullo in 790 righe: il codice sta in `SEZ`; `SEZ2021` porta il prefisso 63049.
- `FRAZ_NONID` arriva a 1,80 per vincoli sovrapposti → va limitato a 1.

## 5. Comandi

```bash
# 1. dati normativi + sezioni non abitate + copertura per posizione
python merge_aree_idonee.py \
  --scores "…\Renewable energy supply baseline.geojson" \
  --geom   "…\ERP_sezioni_final_FeaturesToJSO.geojson" \
  --idonee "…\Aree_idonee.geojson" \
  --non-idonee "…\Aree non idonee.geojson"

# 2. impronte degli edifici
python build_footprints.py

# 3. file unico da distribuire
python build_standalone.py
```

## 6. Decisioni metodologiche prese

- **N_s** (eleggibilità normativa) = media pesata 1 · 0,5 · 0 delle tre classi.
- **FER_100** = (N_s + S_s)/2, letto da `CER_OFFER_100`; il ricalcolo coincide (errore 0,000).
- **Priorità delle cabine** per *numero assoluto di residenti vulnerabili*, non per IVSM
  medio, con Jenks a 3 classi **vincolato a numerosità minima n/4**: senza il vincolo le
  12 osservazioni, molto asimmetriche, producono classi degeneri (8/2/2). Esito:
  C1 = 223 · 189 · 192.
- **Step 6 (intersezione)**: soglia al 75° percentile della producibilità fra le sole
  sezioni idonee (la mediana era 3,6/100, priva di significato). Esito: 59 sezioni.
- **Sezioni non abitate** (1.470) incluse come tessere del mosaico: non generano
  domanda, ma restano valutabili come siti impianto.

## 7. Limite aperto

La producibilità S_s viene dal modello solare sull'**intero edificato**, mentre l'SSD
contabilizza i MWh solo per tetti ERP, pubblici e industriali. Alcune sezioni ad alto
FER_100 mostrano quindi 0 MWh: la produzione ricade su **edilizia residenziale privata**.
Sono segnalate con ⚠ nella graduatoria. Per chiuderlo servirebbe la producibilità
per edificio residenziale (le impronte ci sono già in `footprints.json`).
