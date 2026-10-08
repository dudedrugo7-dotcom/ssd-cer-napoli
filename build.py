#!/usr/bin/env python3
"""
SSD v9 — Costruisce le versioni dell'applicazione da un'unica sorgente (cartella src/).

  index.html             versione web (GitHub Pages): carica dati.json e footprints.json
  SSD-CER-Napoli.html    versione offline: un solo file con dati e libreria incorporati,
                         si apre con un doppio clic e non richiede internet
  dist/artifact.html     anteprima per claude.ai (senza intestazione HTML, Leaflet da cdnjs)

USO:  python build.py          (prima, se i dati sono cambiati: python prepara_dati_v9.py)
"""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE / 'src'
TITLE = 'SSD CER Napoli'
DESCR = ('Strumento di supporto alle decisioni per le comunità energetiche rinnovabili a Napoli: '
         'cabine primarie, aree idonee, vulnerabilità dei residenti e scenari di intervento.')
# Titillium Web (licenza SIL OFL, src/fonts): incorporato, così il carattere c'è anche senza internet
def font_face():
    import base64
    regole = []
    for peso in (400, 600, 700):
        b = base64.b64encode((SRC / 'fonts' / f'titillium-web-latin-{peso}-normal.woff2').read_bytes()).decode()
        regole.append("@font-face{font-family:'Titillium Web';font-style:normal;font-weight:%d;font-display:swap;"
                      "src:url(data:font/woff2;base64,%s) format('woff2')}" % (peso, b))
    return '\n'.join(regole)
LEAFLET_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js'
# icona del selettore di sfondo: la CSS di Leaflet punta a un'immagine che qui non c'è
LAYERS_ICON = ('.leaflet-control-layers-toggle{background-image:url("data:image/svg+xml,'
               '%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 24 24%27%3E%3Cpath d=%27M12 3l9 5-9 5-9-5z'
               'M3 13l9 5 9-5%27 fill=%27none%27 stroke=%27%2317324d%27 stroke-width=%272%27 stroke-linejoin=%27round%27/%3E%3C/svg%3E")'
               '!important;background-size:22px 22px!important}')


def leggi(p): return Path(p).read_text(encoding='utf-8')


def json_script(nome, path):
    """dati incorporati come JSON inerte: si leggono solo quando servono"""
    testo = leggi(path).replace('</', '<\\/')
    return f'<script type="application/json" id="json-{nome}">{testo}</script>'


def corpo(build, dati_inclusi, leaflet_tag):
    import re
    pagina = leggi(SRC / 'page.html')
    if build != 'web':
        # il collegamento alla versione offline serve solo sul sito: altrove si toglie del tutto
        pagina = re.sub(r'\s*<a class="btn-head" id="lnk-offline".*?</a>', '', pagina, flags=re.S)
    else:
        # sul sito il messaggio per chi non ha JavaScript non parla di file da salvare
        pagina = re.sub(r'<div class="nojs">.*?</div>',
                        '<div class="nojs"><h1>SSD CER Napoli</h1><p>Lo strumento ha bisogno di JavaScript: '
                        'attivalo nelle impostazioni del browser e ricarica la pagina.</p></div>', pagina, flags=re.S)
    pezzi = [pagina]
    if dati_inclusi:
        pezzi.append(json_script('dati', HERE / 'dati.json'))
        pezzi.append(json_script('footprints', HERE / 'footprints.json'))
    pezzi.append(leaflet_tag)
    pezzi.append(f'<script>window.SSD_BUILD = {json.dumps(build)};</script>')
    pezzi.append('<script>\n' + leggi(SRC / 'app.js') + '\n</script>')
    return '\n'.join(pezzi)


def stile(leaflet_css=True):
    css = font_face() + '\n' + (leggi(HERE / 'leaflet.css') + '\n' + LAYERS_ICON + '\n' if leaflet_css else '') + leggi(SRC / 'style.css')
    return '<style>\n' + css + '\n</style>'


# prima riga visibile se il file viene aperto per errore con un editor di testo
AVVISO = ('<!-- SSD CER Napoli: strumento interattivo. Per usarlo apri questo file con un browser '
          '(Chrome, Edge, Firefox o Safari), non con un editor di testo. '
          'Versione online: https://dudedrugo7-dotcom.github.io/ssd-cer-napoli/ -->\n')


def documento(build, dati_inclusi, leaflet_tag):
    return ('<!DOCTYPE html>\n' + AVVISO + '<html lang="it">\n<head>\n<meta charset="UTF-8">\n'
            '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
            f'<title>{TITLE}</title>\n<meta name="description" content="{DESCR}">\n'
            f'{stile()}\n</head>\n<body>\n'
            + corpo(build, dati_inclusi, leaflet_tag) + '\n</body>\n</html>\n')


def main():
    leaflet_inline = '<script>\n' + leggi(HERE / 'leaflet.js') + '\n</script>'
    (HERE / 'index.html').write_text(documento('web', False, '<script src="leaflet.js"></script>'), encoding='utf-8')
    off = HERE / 'SSD-CER-Napoli.html'
    off.write_text(documento('offline', True, leaflet_inline), encoding='utf-8')
    dist = HERE / 'dist'; dist.mkdir(exist_ok=True)
    art = dist / 'artifact.html'
    # l'anteprima riceve l'intestazione HTML dalla piattaforma: qui solo titolo, stile e contenuto
    art.write_text(f'<title>{TITLE}</title>\n<meta name="description" content="{DESCR}">\n{stile()}\n'
                   + corpo('artifact', True, f'<script src="{LEAFLET_CDN}"></script>') + '\n', encoding='utf-8')
    for f in (HERE / 'index.html', off, art):
        print(f'{f.relative_to(HERE)}: {f.stat().st_size/1024/1024:.2f} MB')


if __name__ == '__main__':
    main()
