---
name: learn-quiz
description: Verifica gli argomenti di un percorso con quiz adattivi e prove pratiche, corregge i tentativi e registra evidenze, lacune e ripassi nei dati condivisi e in Markdown. Usa per mettersi alla prova o ripassare.
---

# Verifica e ripassa

Leggi [il flusso condiviso](../learn-plan/references/workflow.md) e usa `../learn-plan/scripts/learn.mjs`, relativo a questa skill. Lavora in italiano salvo preferenze diverse.

## Prepara la prova

Risolvi cartella e nodo dagli argomenti; altrimenti esegui `list` e `show` nella radice di studio. Se la richiesta è generica privilegia nodi studiati, lacune recenti e ripassi scaduti. Usa la data locale effettiva. Non attribuire all’utente un corso dimostrativo o progressi inesistenti.

Leggi obiettivi, lezioni, esercizi e risultati precedenti del nodo. Scegli una prova breve, adattabile: domande aperte, scelta multipla con distrattori ragionati, problemi o una procedura pratica. Prima di iniziare indica cosa valuti, la durata approssimativa e il criterio di riuscita. Come punto di partenza puoi usare l’80% dei punti e l’assenza di errori sui concetti essenziali, adattando la soglia al compito. Una singola risposta facile non dimostra tutte le competenze del nodo.

## Conduci e correggi

- Poni una domanda alla volta e attendi il tentativo. Non salvare soluzioni o rubriche rivelatrici nelle note visibili prima della risposta. Se l’utente chiede un indizio, forniscilo e registra il livello di aiuto.
- Dopo il tentativo spiega la correzione, il ragionamento e l’eventuale errore. Varia la domanda successiva in base alla risposta. Se una prova pratica non è osservabile, registra ciò che è dichiarato e lascia l’esito `inconclusive` invece di attestare un’esecuzione.
- Una prova interrotta o troppo breve resta inconclusiva. Non convertire risposte mancanti in errori e non promuovere automaticamente. Conserva i tentativi già avvenuti in modo da poter riprendere.
- Valuta ogni nodo separatamente: una media alta su più argomenti non cancella una lacuna specifica. Salva domande, risposte effettive, indizi, correzioni mostrate, criteri, punteggio e limiti della verifica in `quiz/DATA-ID.md`, con frontmatter e collegamenti Obsidian.

## Registra i risultati

Scrivi un evento `quiz` che riferisce la nota esistente. Per ogni nodo usa:

- `passed` solo con evidenze sufficienti: il runtime segna completato e verificato;
- `needs_work` quando una prova adeguata evidenzia lacune: segna da ripassare e registra una data concreta;
- `inconclusive` quando non puoi concludere: preserva la competenza e lo stato precedenti; l’evento conserva il tentativo.

Usa `score` tra 0 e 1 quando esiste un punteggio significativo. Motiva l’esito in `evidence` e proponi un ripasso ragionato: ad esempio domani per una lacuna recente, dopo qualche giorno per un successo fragile, più avanti per competenze consolidate. Le date sono suggerimenti nel percorso, non notifiche programmate. Non attribuire esiti da quiz a una semplice lettura o ad autovalutazioni.

Rileggi la revisione prima di `record`; se un’altra sessione ha modificato i dati, rileggi e integra il solo evento, senza riscrivere il file completo. Non registrare due volte lo stesso ID. Concludi con risultato, lacune concrete, prossimo esercizio e percorsi dei file salvati. Se serve rivedere la struttura del piano, usa `learn-plan` mantenendo gli ID esistenti.
