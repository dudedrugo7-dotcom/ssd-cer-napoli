# Consegna del progetto: SSD per le CER di Napoli (v9)

Documento per chi riprende il lavoro, da solo o con un assistente.
Autore del lavoro: Valerio Martinelli (dottorato, Università Federico II, DICEA).

---

## 1. Cos'è

Un sistema di supporto alle decisioni che individua dove conviene attivare comunità
energetiche rinnovabili a Napoli e per chi. Ripercorre i cinque step del framework dei
capitoli 5 e 6 della tesi:

1. perimetrazione: 12 cabine primarie (GSE) e 5.724 sezioni censuarie (ISTAT 2021);
2. classificazione regolatoria del suolo: aree idonee, ordinarie e non idonee (DM 21/06/2024);
3. scenario di offerta: producibilità delle coperture (Eq. 2) e FER₁₀₀ (Eq. 3);
4. scenario di domanda: IVSM₁₀₀ (Eq. 4), popolazione vulnerabile e consumo;
5. sovrapposizione e prioritizzazione: bilancio per cabina, classi C1–C3, sezioni prioritarie.

## 2. Regola da non violare

> **L'IVSM non è mai filtrato dalla normativa.**
> Le aree non idonee bloccano la localizzazione dell'impianto, mai la platea dei beneficiari:
> l'energia si condivide dentro tutta la cabina primaria.

## 3. Come è fatto

| parte | file |
|---|---|
| sorgente dell'interfaccia | `src/page.html`, `src/style.css`, `src/app.js` |
| dati | `dati.json` (colonnare, 1,2 MB), `footprints.json` (edifici, caricati solo a richiesta) |
| preparazione dei dati | `prepara_dati_v9.py`, da `dataset.json` |
| generazione | `build.py` → `index.html` (web), `SSD-CER-Napoli.html` (offline), `dist/artifact.html` |

Nessuna dipendenza esterna a runtime nella versione offline: dati, Leaflet e il carattere
Titillium Web sono incorporati. La versione web carica Leaflet dal repository.

## 4. Comandi

```bash
python prepara_dati_v9.py   # ricostruisce dati.json e lo verifica contro la tesi
python build.py             # rigenera le tre versioni
```

`prepara_dati_v9.py` si ferma se un valore non coincide con le Tab. 6.1, 6.4, 6.6–6.12 o con i
residenti serviti per destinazione: è il controllo da rifare dopo ogni modifica ai dati.

## 5. Decisioni metodologiche riprodotte

- **Vulnerabili**: sezioni abitate con IVSM₁₀₀ ≥ soglia; la popolazione è la somma dei residenti.
  Le sezioni con IVSM arrotondato a 60,0 o 70,0 sono attribuite secondo i campi GIS `pv60` e `pv70`.
- **Consumo**: popolazione vulnerabile × consumo per abitante, a un decimale di MWh per cabina.
- **Producibilità**: totali di cabina delle Tab. 6.4, 6.8 e 6.9, scalati per c / 0,50.
  Pubblico e industriale per sezione sono riportati sui totali di cabina.
- **Rapporto potenziale**: producibilità / consumo; gli scenari cumulati sommano i rapporti già
  arrotondati, come nella Tab. 6.10.
- **Copertura effettiva ERP**: in ogni sezione l'energia ERP serve prima i vulnerabili della
  sezione, poi gli altri residenti, il resto è eccedenza (Tab. 6.6).
- **Classi di priorità**: Jenks a tre classi sul numero assoluto di vulnerabili, minimo tre cabine
  per classe (Tab. 6.7 e 6.11).
- **Configurazione minima**: prima le destinazioni singole (ERP, pubblico, industriale), poi le
  coppie, poi tutte e tre; la prima che arriva al 100%.
- **Sezioni prioritarie**: offerta elevata se FER₁₀₀ ≥ 28,2 (70° percentile delle sezioni
  abitate), domanda elevata se vulnerabile (Tab. 6.12).
- **Residenti serviti**: per cabina il minimo fra vulnerabili e producibilità / consumo pro capite.

## 6. Accessibilità

Verificata con axe-core (WCAG 2.0, 2.1 e 2.2, livelli A e AA) in tema chiaro e scuro, nelle viste
città, cabina, percorso guidato e nei dialoghi: nessuna violazione. Colori dei dati controllati
per il daltonismo con la simulazione di Machado (2009).

## 7. Limiti aperti

- L'edificato è del 2011 e il modello delle superfici del 2013; la domanda è del 2021.
- Il passaggio dalla sezione all'impianto (dimensionamento, profili di prelievo) non è sviluppato.
- Il fattore di emissione della scheda PAESC (0,33 t CO₂/MWh) è indicativo e va allineato
  all'inventario di base del Comune.
