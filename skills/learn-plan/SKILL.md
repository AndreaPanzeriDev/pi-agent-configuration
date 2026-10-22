---
name: learn-plan
description: Valuta il livello iniziale e crea o rivede un percorso di apprendimento con una graph map obbligatoria di nodi e prerequisiti, usando il renderer HTML incluso e progressi persistenti. Usa quando l’utente vuole imparare un argomento o pianificare lo studio.
---

# Pianifica un percorso

Lavora in italiano, salvo preferenze diverse. Richiede Pi con strumenti di lettura/scrittura e bash, e Node.js >= 20. Installa insieme a `learn-study` e `learn-quiz`: le tre skill condividono una cartella per percorso; la mappa contiene introduzioni brevi, mentre gli approfondimenti vanno in Markdown per Obsidian.

## Formato della mappa: vincolo di questa skill

La vista principale deve essere **sempre una graph map navigabile**: argomenti rappresentati da nodi cliccabili, frecce dal prerequisito all’argomento dipendente, ramificazioni reali e stati di avanzamento visibili. Mantieni l’aspetto del template incluso. Usa i moduli per raggruppare i contenuti e le relazioni per indicare dipendenze effettive; non collegare artificialmente ogni nodo al precedente per ottenere una scaletta.

**Genera soltanto i contenuti del piano JSON e le note Markdown. L’HTML, il CSS, il layout del grafo e il JavaScript della mappa vengono esclusivamente da `scripts/learn.mjs` e `assets/map.html`.** Non scrivere, sostituire o reinventare `mappa.html` o il template. Elenchi, tabelle, timeline, griglie di schede scollegate e diagrammi Mermaid non sostituiscono la mappa principale; Mermaid resta disponibile nelle note.

Prima di creare o aggiornare un percorso esegui `node "PERCORSO_ASSOLUTO_DELLA_SKILL/scripts/learn.mjs" doctor`, sostituendo il percorso con quello effettivo. Se manca Node, una skill sorella, il template o il riferimento, segnala esattamente la risorsa mancante e fermati sulla generazione della mappa: non inventare una vista alternativa. Copia e installa tutte e tre le cartelle complete, inclusa `assets/`.

## Comprendi il punto di partenza

Se è indicato un percorso esistente, leggi prima `percorso.json` con lo script `show` e riprendi obiettivo, note e risultati. Se non è chiaro quale percorso usare, esegui `list` sulla radice concordata. Non iniziare di nuovo l’intervista quando i dati sono già disponibili.

Per un nuovo percorso chiedi **una domanda per turno**, partendo da ciò che l’utente vuole saper fare. Raccogli esperienza, autovalutazione 1–10, tempo disponibile, eventuale scadenza e vincoli pratici. Riutilizza le risposte già presenti nella conversazione. Poi poni domande diagnostiche brevi e adattive, sempre una alla volta: conoscenze di base, ragionamento, un piccolo esercizio o una procedura concreta. Non trasformare l’intervista in un esame infinito: fermati quando hai elementi sufficienti per proporre il punto di partenza, esplicitando le incertezze.

Per software 3D considera versione, strumenti e un risultato da realizzare; per homelab considera hardware, rete ed esperienza pratica; per matematica o scienze verifica anche i prerequisiti. Usa solo le capacità effettivamente disponibili: non dichiarare di aver ispezionato immagini o eseguito software senza averlo fatto.

## Costruisci il percorso

- Definisci moduli e nodi con obiettivi osservabili, introduzioni concise e prerequisiti espliciti. La profondità deve bastare a guidare lo studio quotidiano; per un argomento ampio crea diverse decine di tappe ragionate, per uno ristretto meno. Evita un elenco generico di titoli o una granularità artificiale.
- Ordina i nodi dal fondamentale all’applicato e includi esercitazioni e un progetto finale quando pertinenti. Distingui il nucleo essenziale dagli approfondimenti nel testo degli obiettivi o dei moduli.
- Se l’utente dichiara una conoscenza, usa `declared_known: true`: apparirà completata ma **non verificata**. Registra le prove diagnostiche effettivamente svolte come eventi `assessment`, con note ed evidenze. L’autovalutazione da sola non è una verifica.
- Usa ID stabili. In una revisione conserva ID, progressi, note e parti personali; aggiungi o riorganizza i nodi senza cancellare quelli esistenti. Se un argomento viene sostituito, spiegalo nella sua introduzione e nei collegamenti.
- Adatta contenuti e ritmo alle risposte; identifica una prossima tappa motivata. Non generare in anticipo tutte le lezioni.

## Crea i file e la mappa

Leggi [il formato dati e i comandi](references/workflow.md). Lo script condiviso è `scripts/learn.mjs`, relativo a questa skill; risolvi il percorso assoluto prima di eseguirlo. Non dipende dalla directory corrente del processo Pi.

La radice predefinita è `PI_LEARN_ROOT`, se impostata, altrimenti `apprendimento/` nella directory di lavoro. Rispetta un vault o una destinazione esplicita. Non modificare la configurazione di Obsidian; una cartella del vault può contenere i percorsi. Se la destinazione non è ancora nota, usa il default e indica il percorso assoluto effettivo.

Scrivi il piano in un JSON temporaneo, quindi usa `init CARTELLA --from FILE`. Per rivederlo usa `plan CARTELLA --from FILE --expected-revision N` dopo `show`. **Non riscrivere direttamente `percorso.json`**: usa il runtime per preservare cronologia e modifiche contemporanee. Conserva i risultati dell’intervista in `diario/` e collegali con un evento di valutazione quando esistono prove concrete.

Esegui `render CARTELLA` e poi `validate CARTELLA`. Il controllo deve confermare renderer `pi-learn-graph-v1`, numero di nodi e numero di archi: verifica anche che i prerequisiti rappresentino il percorso concepito. Un errore di conformità si ripara con `render`, preservando dati e note. Per un percorso preesistente con dati compatibili, questo adotta la graph map inclusa senza rifare l’intervista. Se i dati hanno un altro formato, preservali e chiarisci la conversione necessaria.

Avvia `serve CARTELLA` in un processo che rimanga attivo, controlla che risponda e fornisci il vero URL locale stampato. Se hai un browser disponibile, verifica nodi e frecce, selezione di un nodo e dettagli, navigazione del grafo e salvataggio persistente di un progresso effettivo; non inventare esiti di verifica se hai solo controllato l’HTTP. Se non puoi mantenere il processo, dai il comando esatto per avviarlo nel terminale dell’utente senza fingere che sia già in esecuzione. L’HTML aperto come `file://` è una vista di sola lettura e lo segnala; i clic si salvano dal servizio locale.

Consegna il percorso della cartella, il link alla mappa, la prossima tappa e gli esempi `/skill:learn-study percorso "CARTELLA" nodo ID` e `/skill:learn-quiz percorso "CARTELLA" nodo ID`. Gli argomenti sono una richiesta in linguaggio naturale: non sono comandi di shell.
