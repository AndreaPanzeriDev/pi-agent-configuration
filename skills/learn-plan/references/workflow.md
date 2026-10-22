# Dati condivisi e comandi

Le tre skill si installano insieme. Il runtime comune è `learn-plan/scripts/learn.mjs`; richiede solo Node.js >= 20, già necessario a Pi. Non usa API AI, librerie da installare o connessioni Internet. Intervista, lezioni e valutazioni sono gestite dal modello Pi nella conversazione, non dallo script.

## Contratto della graph map

La mappa principale usa sempre il renderer incluso `pi-learn-graph-v1`. L’agente produce il piano JSON e le note Markdown; il runtime genera l’intero HTML dal template `learn-plan/assets/map.html`, con layout determinato dai prerequisiti. Nodi cliccabili, archi diretti, ramificazioni, selezione e stati di avanzamento sono parte del risultato richiesto, per ogni materia. La catena di prerequisiti di un nodo deve rappresentare ciò che serve davvero a comprenderlo. Lo spunto concettuale è il [knowledge graph di PhysicsGraph](https://physicsgraph.com/how-it-works/knowledge-graph); non si importano contenuti o servizi di quel sito.

Non creare renderer alternativi né modificare HTML/CSS/JavaScript del template durante una sessione di pianificazione, studio o quiz. Una richiesta esplicita di sviluppo del renderer è un’attività distinta. Mermaid è per gli approfondimenti nelle note, non per sostituire la mappa principale.

La mappa include zoom, adattamento alla finestra e trascinamento dello sfondo. La selezione evidenzia la catena transitiva dei prerequisiti; «Solo prerequisiti» attenua gli altri nodi e collegamenti conservando il contesto del grafo. Queste interazioni cambiano soltanto la vista: progressi e verifica si modificano con i controlli di avanzamento o con le skill.

`doctor` controlla che siano presenti tutte e tre le skill e le risorse del grafo. Se una copia installata non comprende `assets/map.html`, ripristina la cartella completa dal pacchetto: l’AI non deve ricostruire quel file a memoria. Per distribuire le skill, includi **tutto** il contenuto delle tre cartelle, comprese `assets/`, `references/` e `scripts/`; escludere l’HTML rende il pacchetto incompleto.

`validate CARTELLA` verifica i dati e confronta il file `mappa.html` con l’output canonico del renderer per quel percorso. Un marker da solo non basta: HTML alternativi o alterati vengono rifiutati anche se ne conservano il nome o l’identificatore. Il risultato riporta renderer, nodi, archi e revisione. Questo controllo garantisce l’origine della vista; non dimostra la qualità didattica dei prerequisiti né l’esecuzione nel browser.

Per ripristinare una mappa diversa o aggiornarla dopo aver installato una nuova versione del template, esegui `render CARTELLA`, poi `validate CARTELLA`. I dati, i progressi e le note restano invariati. Anche `serve` rigenera la vista dal renderer incluso all’avvio. Se il percorso usa un altro schema dati, non azzerarlo: serve una conversione ragionata che conservi i contenuti.

La suite essenziale è inclusa nella skill ed è indipendente dal resto del repository:

```bash
node --test "$SKILL_PLAN/scripts/graph.test.mjs"
```

Sostituisci `SKILL_PLAN` con la cartella assoluta reale. I test creano soltanto percorsi temporanei; una verifica visiva aggiuntiva controlla selezione, frecce, navigazione e salvataggi nel browser.

## Cartella di un percorso

```text
apprendimento/argomento/
  percorso.json        # unica fonte dei dati: piano, progressi, eventi e revisione
  mappa.html           # vista generata, anche consultabile offline
  indice.md            # blocco generato + eventuali appunti personali
  lezioni/             # approfondimenti Markdown
  esercizi/            # prove, tentativi e soluzioni già discusse
  quiz/                # domande, risposte e correzioni mostrate
  diario/              # intervista, sessioni e valutazioni iniziali
  allegati/            # immagini e altri file effettivamente creati
```

Per Obsidian crea i percorsi dentro il vault scelto o apri la radice come vault. I link della mappa `obsidian://open?path=...` richiedono Obsidian installato e il file in un vault aperto; il collegamento «Leggi Markdown» permette comunque di consultare la nota dal servizio. Il servizio non modifica configurazioni Obsidian.

`percorso.json` contiene `schema_version: 1`, `revision`, date ISO, `plan`, `progress` per ID nodo ed `events`. **Leggi con `show`; modifica attraverso i comandi**. Il runtime usa lock su cartella, sostituzione atomica del JSON e controllo opzionale/obbligatorio della revisione. Mantieni un backup della cartella con il normale sistema di backup del vault; il pulsante Esporta JSON esporta i dati strutturati, non gli allegati o i Markdown.

## Piano in ingresso

`init` e `plan` ricevono il solo oggetto piano, non l’intero `percorso.json`. Esempio minimo:

```json
{
  "id": "algebra",
  "title": "Algebra di base",
  "description": "Dalle espressioni ai problemi con equazioni.",
  "goal": "Risolvere e motivare problemi con un’incognita",
  "weekly_hours": 3,
  "modules": [{"id": "fondamenti", "title": "Fondamenti"}],
  "nodes": [
    {
      "id": "espressioni",
      "module": "fondamenti",
      "title": "Espressioni e priorità",
      "summary": "Ordine delle operazioni e uso delle parentesi.",
      "objectives": ["Calcolare un’espressione motivando ogni passaggio"],
      "prerequisites": [],
      "notes": [],
      "declared_known": true
    },
    {
      "id": "equazioni",
      "module": "fondamenti",
      "title": "Equazioni di primo grado",
      "summary": "Trasformazioni equivalenti e verifica della soluzione.",
      "objectives": ["Risolvere un’equazione e verificare per sostituzione"],
      "prerequisites": ["espressioni"],
      "notes": [],
      "declared_known": false
    }
  ]
}
```

Tutti gli ID usano minuscole, numeri e trattini singoli. Moduli e nodi hanno ID univoci. Il grafo dei prerequisiti deve essere aciclico. `objectives`, `prerequisites` e `notes` sono sempre liste. `weekly_hours` e `declared_known` sono opzionali. Un nodo dichiarato noto parte `completed` con `verification: unverified`, mantenendo visibile la distinzione. Le verifiche iniziali effettive si registrano con un evento `assessment`.

Gli stati sono `not_started`, `in_progress`, `completed`, `review`; la verifica separata è `unverified`, `passed` o `needs_work`. Un clic manuale non cambia mai la verifica. La data di ripasso è `review_on` (`YYYY-MM-DD` o `null`). Gli eventi conservano le evidenze storiche anche se lo stato cambia in seguito.

## Comandi

Negli esempi `RUNTIME` e `CARTELLA` indicano percorsi assoluti risolti. Usa argomenti di shell quotati correttamente, specialmente per spazi o apostrofi. Non copiare variabili segnaposto in un comando consegnato all’utente.

```bash
node "$RUNTIME" doctor
node "$RUNTIME" list "$RADICE"
node "$RUNTIME" init "$CARTELLA" --from "$PIANO_JSON"
node "$RUNTIME" show "$CARTELLA"
node "$RUNTIME" validate "$CARTELLA"
node "$RUNTIME" serve "$CARTELLA"
node "$RUNTIME" progress "$CARTELLA" equazioni --state in_progress --expected-revision 0
node "$RUNTIME" record "$CARTELLA" --from "$EVENTO_JSON" --expected-revision 1
node "$RUNTIME" plan "$CARTELLA" --from "$PIANO_RIVISTO_JSON" --expected-revision 2
node "$RUNTIME" render "$CARTELLA"
```

`list` senza radice usa `PI_LEARN_ROOT` o `./apprendimento`; cerca le cartelle immediatamente sotto la radice. Nelle nuove conversazioni passa il percorso assoluto o imposta la stessa radice. Nessun registro globale nascosto. `show` include cartella e comando per avviare il servizio.

Le mutazioni riuscite aggiornano anche HTML e blocco generato dell’indice, preservando il testo esterno ai marcatori `learn:index`. Se i dati sono salvati ma la rigenerazione segnala un errore, la sessione non è completamente verificata: ripara con `render`, poi esegui `validate`, e riferisci separatamente ciò che è riuscito e ciò che resta da riparare. `render` non cambia la revisione. Non modificare a mano la mappa generata. In una revisione del piano conserva tutti gli ID esistenti; i collegamenti alle note vengono uniti, e i progressi esistenti non vengono reinizializzati.

`serve` ascolta solo su `127.0.0.1`, sceglie una porta libera e stampa l’URL esatto. Opzionale `--port 8765` per una porta stabile. Serve un processo persistente: usa un terminale o il meccanismo di processo in background effettivamente supportato dagli strumenti Pi; il blocco della chiamata bash non equivale ad aver aperto una mappa utilizzabile. Non avviare più servizi inutilmente. Controlla l’URL con uno strumento HTTP prima di dichiararlo pronto. Ctrl+C chiude il servizio; i dati salvati restano su disco. Il servizio resta sul computer su cui gira Pi, quindi un Pi remoto richiede il normale inoltro della porta verso quel computer.

Il browser rilegge i dati ogni cinque secondi se non ci sono modifiche locali pendenti. Un salvataggio con revisione vecchia riceve un conflitto: rileggi, poi ripeti la modifica desiderata. Il pulsante Aggiorna dati rilegge il disco e scarta le modifiche ancora non salvate nel modulo. Una disconnessione non viene indicata come salvataggio riuscito. Nessun dato viene affidato esclusivamente a localStorage.

## Eventi di studio e verifica

Scrivi prima le note effettive, poi registra l’evento. La nota deve esistere dentro `lezioni/`, `esercizi/`, `quiz/` o `diario/`; il runtime rifiuta percorsi esterni e collega automaticamente la nota al nodo.

```json
{
  "id": "2026-10-20-equazioni-sessione-1",
  "type": "study",
  "summary": "Affrontate trasformazioni equivalenti con un esercizio guidato",
  "results": [{
    "node_id": "equazioni",
    "outcome": "studied",
    "evidence": "Svolti insieme due passaggi; resta da provare una soluzione autonoma",
    "note": "lezioni/equazioni.md"
  }]
}
```

Per `quiz` o `assessment`, usa `passed`, `needs_work` o `inconclusive`; `study` ammette soltanto `studied`. Aggiungi `score` tra 0 e 1 solo se calcolato e `review_on` quando opportuno:

```json
{
  "id": "2026-10-20-equazioni-quiz-1",
  "type": "quiz",
  "summary": "Prima prova autonoma sulle equazioni",
  "results": [{
    "node_id": "equazioni",
    "outcome": "needs_work",
    "score": 0.6,
    "evidence": "Tre risposte su cinque corrette; errori di segno in due trasformazioni",
    "note": "quiz/2026-10-20-equazioni.md",
    "review_on": "2026-10-21"
  }]
}
```

Il runtime può verificare coerenza, file e valori; la validità pedagogica dell’evidenza e l’autenticità delle risposte spettano all’agente. `passed` completa il nodo e aggiorna la verifica; `needs_work` lo mette in ripasso; `inconclusive` conserva lo stato e la verifica precedenti. Un evento di studio conserva un eventuale ripasso o completamento già presente. Una nuova prova riuscita senza data cancella il vecchio ripasso, una fallita senza data lascia il nodo nello stato di ripasso senza data; `inconclusive` e `studied` preservano la data salvo modifica esplicita.

Usa ID evento univoci; un duplicato è rifiutato. Con un conflitto di revisione rileggi il corso e riprova lo stesso evento una sola volta se è ancora pertinente e non risulta già registrato. Se il conflitto si ripete, segnala la sessione concorrente e mantieni la nota salvata per poter riprendere. Se resta `.learn.lock` dopo un arresto anomalo, controlla `owner.json` e l’assenza del processo prima di rimuovere il lock.

## Convenzioni delle note

```markdown
---
type: lesson
course_id: algebra
node_id: equazioni
updated: 2026-10-20
tags: [apprendimento, algebra]
---
# Equazioni di primo grado

Prerequisito: [[lezioni/espressioni]]

## Appunti personali

## Sessione del 2026-10-20
Contenuto effettivamente affrontato, esempi, tentativi e dubbi.
```

Per i quiz usa `type: quiz`, per intervista e diario `type: assessment` o `session`. I nomi file datati sono esempi: usa la data corrente, non quella di questo riferimento. Non sovrascrivere note personali né rivelare risposte prima del tentativo. Mermaid si salva in un blocco `mermaid`; immagini reali in `allegati/`, con link relativo dalla nota, ad esempio `![](../allegati/schema.png)`.
