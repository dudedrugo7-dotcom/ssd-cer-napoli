# SSD CER Napoli

> **Versione corrente: v9.** L'indirizzo https://dudedrugo7-dotcom.github.io/ssd-cer-napoli/ apre la v9
> (cartella `v9/`, sorgente nel ramo `v9-accessibile`). La versione 8 resta consultabile in `v8.html`.

Strumento di supporto alla decisione per la prioritizzazione delle comunità energetiche
rinnovabili nel Comune di Napoli.

È l'applicazione web-GIS descritta nel paragrafo 5.8 e nel paragrafo 6.5 della tesi di dottorato
*Comunità energetiche intelligenti: condizioni di contesto urbanistiche, ambientali,
economico-sociali e normative per la loro implementazione* (Valerio Martinelli, Università degli
Studi di Napoli Federico II, DICEA, XXXIX ciclo).

## Che cosa fa

Restituisce l'esito del framework su due scale.

**Alla scala della cabina primaria** — le dodici cabine che servono il territorio comunale — mostra
la popolazione complessiva e quella in condizione di alta vulnerabilità, la producibilità
fotovoltaica distinta per destinazione d'uso, il bilancio fra offerta e domanda, la classe di
priorità assegnata e la configurazione minima sufficiente a chiudere il bilancio.

**Alla scala della sezione censuaria** — 5.724 sezioni — mostra per ciascun poligono le variabili
di vulnerabilità, la quota di superficie in ciascuna classe regolatoria, la superficie e la
producibilità delle coperture per destinazione, e la classificazione operativa.

Tre parametri sono modificabili dall'utente e ricalcolano in tempo reale tutte le grandezze
derivate: la soglia dell'indice di vulnerabilità (60, 70, 80), il consumo elettrico di riferimento
per abitante, e le destinazioni d'uso attivate.

## Come si apre

Servito da un server web — per esempio GitHub Pages — basta aprire `index.html`.

In locale, aprendo `index.html` con un doppio clic il browser blocca il caricamento di
`dataset.json`, perché il protocollo `file://` non consente le richieste `fetch`. Per questo esiste
una versione autonoma che incorpora i dati nella pagina:

```
python build_standalone.py
```

produce `SSD-v8-Napoli-standalone.html`, che si apre con un doppio clic e non richiede nulla.
Il file è generato e non è versionato.

## I file

| file | contenuto |
|---|---|
| `index.html` | la pagina dell'applicazione |
| `app.js` | la logica: calcolo dei bilanci, classificazione, interazione |
| `dataset.json` | i dati: 12 cabine primarie e 5.724 sezioni censuarie |
| `footprints.json` | le impronte degli edifici per destinazione |
| `aree_overlay.json` | la classificazione regolatoria: aree idonee, ordinarie, non idonee |
| `Comune_da_sezioni.geojson` | il confine comunale ricostruito dalle sezioni |
| `Municipalita_da_sezioni.geojson` | le dieci Municipalità |
| `leaflet.js`, `leaflet.css` | la libreria cartografica, incorporata per funzionare offline |

Gli script Python (`build_standalone.py`, `ottimizza_dataset.py`, `crea_municipalita.py`,
`fix_geometrie_e_residenziale.py`, `add_municipalita.py`, `add_rigenerazione.py`) documentano la
catena di elaborazione che ha prodotto il dataset.

## I dati

| grandezza | valore |
|---|---|
| sezioni censuarie | 5.724, di cui 4.219 abitate |
| cabine primarie | 12 |
| superficie comunale | 119,16 km² |
| popolazione residente | 921.142 abitanti |
| popolazione ad alta vulnerabilità (IVSM_100 ≥ 60) | 73.408 abitanti, l'8,0% |
| producibilità mappata | 2.301.694 MWh/a |
| benchmark di consumo | 2.441 kWh per abitante all'anno |
| resa fotovoltaica | 1.400 kWh/kWp |

**Fonti.** ISTAT, censimento permanente e basi territoriali 2021, per le variabili sociodemografiche
e la geometria delle sezioni. GSE per i perimetri delle cabine primarie. Piattaforma delle aree
idonee del MASE, in attuazione del DM 21 giugno 2024, per la classificazione regolatoria. Sistema
Informativo Territoriale del Comune di Napoli e OpenStreetMap per le impronte dell'edificato.
Geoportale della Regione Campania, programma PST-A, per il modello digitale delle superfici.

**Un limite dichiarato.** Le impronte dell'edificato residenziale e dell'edilizia residenziale
pubblica sono riferite al 2011 e il modello digitale delle superfici a un rilievo del 2013, mentre
le variabili socioeconomiche sono del 2021. La componente di offerta descrive quindi il costruito a
una data anteriore rispetto a quella della domanda, e la producibilità stimata è una sottostima di
entità non quantificabile.

**Un vincolo metodologico.** L'indice di vulnerabilità non è in alcun caso filtrato dalla
classificazione regolatoria. Le aree idonee, ordinarie e non idonee vincolano la localizzazione
dell'impianto, non l'eleggibilità dei beneficiari: un residente vulnerabile in area non idonea
resta un beneficiario.

## Stato

Versione 8. Il dataset è congelato: le correzioni individuate durante la stesura dei capitoli 5 e 6
sono annotate e verranno applicate dopo la consegna della tesi, per non riscrivere due volte i
risultati.

## Licenza e citazione

Il codice è rilasciato per finalità di ricerca. I dati di base sono pubblici e vanno citati
secondo le rispettive fonti.

Per citare lo strumento:

> Martinelli, V. (2026). *SSD CER Napoli: strumento di supporto alla decisione per la
> prioritizzazione delle comunità energetiche rinnovabili*. Università degli Studi di Napoli
> Federico II, Dipartimento di Ingegneria Civile, Edile e Ambientale.
