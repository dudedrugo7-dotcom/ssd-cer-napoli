# SSD CER Napoli

Strumento di supporto alle decisioni per la prioritizzazione delle comunità energetiche
rinnovabili nel Comune di Napoli.

È l'applicazione web-GIS descritta nei paragrafi 5.8 e 6.5.3 della tesi di dottorato
*Comunità energetiche intelligenti: condizioni di contesto urbanistiche, ambientali,
economico-sociali e normative per la loro implementazione* (Valerio Martinelli, Università degli
Studi di Napoli Federico II, DICEA, XXXIX ciclo).

## Che cosa fa

Ripercorre i cinque step del framework della tesi e restituisce l'esito a due scale.

1. **Perimetrazione delle unità di analisi**: le 12 cabine primarie e le 5.724 sezioni censuarie.
2. **Classificazione regolatoria del suolo**: aree idonee, ordinarie e non idonee del DM 21/06/2024.
3. **Scenario di offerta**: producibilità delle coperture (Eq. 2) e mappa FER₁₀₀ (Eq. 3).
4. **Scenario di domanda**: IVSM₁₀₀ per sezione (Eq. 4), popolazione vulnerabile e consumo.
5. **Sovrapposizione e prioritizzazione**: bilancio per cabina, classi C1–C3 (Jenks) e sezioni
   prioritarie (offerta e domanda elevate, sola domanda, sola offerta).

Il pulsante **Individua le aree prioritarie** guida l'utente attraverso i cinque step e si chiude
sulle aree da cui cominciare. Per ogni cabina lo strumento restituisce il bilancio per destinazione,
gli scenari A, B e C, la configurazione minima sufficiente, le sezioni prioritarie e una scheda
d'azione per il PAESC. Una lettura per Municipalità affianca quella per cabina.

## Parametri variabili

Quattro parametri ricalcolano in tempo reale tutte le grandezze derivate:

| parametro | valore della tesi | che cosa cambia |
|---|---|---|
| soglia IVSM₁₀₀ | ≥ 60 (verifica a 70) | sezioni vulnerabili, popolazione, consumo, classi, sezioni prioritarie |
| consumo elettrico per abitante | 2.441 kWh/anno | consumo da coprire, bilanci, residenti raggiungibili, configurazione minima |
| superficie dei tetti utilizzabile (coefficiente c, Eq. 2) | 50% | producibilità di tutte le destinazioni, quindi bilanci e configurazioni |
| coperture attivate | scenario A (ERP) | quali destinazioni entrano nel bilancio, combinabili liberamente |

La producibilità è lineare in c (E = R · A · c · η · PR), quindi il coefficiente si ricalcola senza
rifare l'elaborazione GIS. FER₁₀₀ non cambia, perché S_s è normalizzato al massimo osservato.

## Allineamento con la tesi

`prepara_dati_v9.py` costruisce `dati.json` da `dataset.json` e verifica, prima di scriverlo, che
coincidano con la tesi: Tab. 6.1, 6.4, 6.6, 6.7, 6.8, 6.9, 6.10, 6.11, 6.12 e i residenti serviti
per destinazione (59.092, 32.685, 36.189). Lo script si ferma se un solo valore non torna.
Gli interventi di allineamento sono dichiarati in testa allo script:

- le tre sezioni senza cabina passano ad AC001E00190 (Tab. 6.1);
- i MWh di pubblico e industriale delle sezioni sono riportati sui totali di cabina (Tab. 6.8, 6.9, 6.12);
- le sezioni con IVSM arrotondato esattamente a 60,0 o 70,0 sono attribuite alla soglia secondo i
  campi GIS a piena precisione (73.408 vulnerabili a 60, 6.450 a 70);
- "offerta elevata" è FER₁₀₀ ≥ 28,2, il 70° percentile delle sezioni abitate (Tab. 6.12).

Differenze residue con il testo della tesi, da correggere nel testo:

- a soglia 70 le sezioni sono 64 (par. 6.4.1 indica 65; la popolazione 6.450 coincide);
- nella Tab. 6.6 il rapporto potenziale della cabina AC001E00201 è 5.403,5% (la tesi riporta
  5.407,3%) e i saldi delle cabine 223 e 192 sono −17.674 e −8.746 MWh/a (−17.673 e −8.747):
  quella tabella usava il consumo di una versione precedente, che differiva di meno di 1 MWh;
- i par. 5.8 e 6.5.3 dicono che cambiare i coefficienti richiede di ripetere l'elaborazione GIS:
  vale per i pesi e per η e PR, non per il coefficiente c, che lo strumento ora rende modificabile.

## Come si apre

- **Versione offline**: `SSD-CER-Napoli.html` contiene dati, libreria cartografica e carattere.
  Si apre con un doppio clic (o con `APRI-SSD.bat`) e non richiede internet.
- **Versione web**: `index.html`, servita da GitHub Pages, carica `dati.json` e, solo quando si
  accendono gli edifici, `footprints.json`.

Le due versioni si generano dalla stessa sorgente:

```
python prepara_dati_v9.py    # solo se cambiano i dati
python build.py
```

## I file

| file | contenuto |
|---|---|
| `src/page.html`, `src/style.css`, `src/app.js` | la sorgente dell'applicazione |
| `src/fonts/` | Titillium Web (licenza SIL OFL), il carattere dei siti della PA |
| `build.py` | genera `index.html`, `SSD-CER-Napoli.html` e l'anteprima in `dist/` |
| `prepara_dati_v9.py` | prepara `dati.json` e lo verifica contro le tabelle della tesi |
| `dati.json` | 12 cabine e 5.724 sezioni in formato colonnare compatto (1,2 MB) |
| `footprints.json` | impronte di 35.131 edifici per destinazione |
| `dataset.json` | base dati v8, da cui deriva `dati.json` |
| `Comune_da_sezioni.*`, `Municipalita_da_sezioni.*` | confini del Comune e delle dieci Municipalità |
| `leaflet.js`, `leaflet.css` | libreria cartografica, incorporata nella versione offline |

Gli altri script Python documentano la catena di elaborazione che ha prodotto il dataset.

## Accessibilità

L'interfaccia è progettata secondo le WCAG 2.1 livello AA e verificata con axe-core in tema chiaro
e scuro: contrasti di almeno 4,5:1, uso completo da tastiera, focus sempre visibile, dialoghi
accessibili, annunci per i lettori di schermo quando cambiano i parametri, colori dei dati
verificati per il daltonismo e tabelle equivalenti per ogni mappa. Rispetta la preferenza per il
movimento ridotto e si adatta fino agli schermi dei telefoni.

## I dati

| grandezza | valore |
|---|---|
| sezioni censuarie | 5.724, di cui 4.219 abitate |
| cabine primarie | 12 |
| superficie comunale | 119,16 km² |
| popolazione residente | 921.142 abitanti |
| popolazione ad alta vulnerabilità (IVSM₁₀₀ ≥ 60) | 73.408 abitanti, l'8,0% |
| producibilità mappata | 2.301.694 MWh/a |
| consumo di riferimento | 2.441 kWh per abitante all'anno |

**Fonti.** ISTAT, censimento permanente e basi territoriali 2021. GSE, perimetri delle cabine
primarie. MASE, Piattaforma delle Aree Idonee (DM 21 giugno 2024). SIT della Città Metropolitana
di Napoli e OpenStreetMap per l'edificato. PST-A (MASE) per il modello digitale delle superfici.

**Limite dichiarato.** Le impronte dell'edificato sono del 2011 e il modello delle superfici del
2013, mentre le variabili socioeconomiche sono del 2021: la producibilità descrive il costruito
mappato, non quello attuale.

**Vincolo metodologico.** L'indice di vulnerabilità non è mai filtrato dalla classificazione
regolatoria. Le aree non idonee vincolano la localizzazione dell'impianto, non l'eleggibilità dei
beneficiari.

## Licenza e citazione

Il codice è rilasciato per finalità di ricerca. I dati di base sono pubblici e vanno citati
secondo le rispettive fonti.

> Martinelli, V. (2026). *SSD CER Napoli: strumento di supporto alla decisione per la
> prioritizzazione delle comunità energetiche rinnovabili*. Università degli Studi di Napoli
> Federico II, Dipartimento di Ingegneria Civile, Edile e Ambientale.
