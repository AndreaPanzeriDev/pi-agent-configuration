---
name: learn-study
description: Approfondisce una tappa di un percorso esistente attraverso spiegazioni, conversazione ed esercizi, salvando lezioni e appunti Markdown per Obsidian. Usa per studiare o riprendere una lezione.
---

# Studia una tappa

Usa l’italiano salvo preferenze diverse. Leggi [il flusso condiviso](../learn-plan/references/workflow.md) e usa `../learn-plan/scripts/learn.mjs`, risolto rispetto a questa skill. Le tre cartelle `learn-*` vanno installate insieme nella stessa directory.

1. Risolvi cartella e ID nodo dalla richiesta. Se manca il percorso, usa `list` nella radice concordata o `PI_LEARN_ROOT` (default `./apprendimento`); se resta una scelta ambigua chiedi quale percorso. Leggi `show CARTELLA` e le note già collegate al nodo. Non dedurre progressi dalla memoria della chat. Se il percorso non esiste, proponi di crearlo con `learn-plan`.
2. Individua prerequisiti mancanti, difficoltà registrate e prossimo obiettivo concreto. Se serve un prerequisito, proponi un breve richiamo senza bloccare un approfondimento espressamente richiesto. Se manca il nodo, proponi quelli pertinenti usando gli ID reali.
3. Guida una conversazione di studio: una spiegazione mirata, un esempio, poi un piccolo esercizio o una domanda per verificare la comprensione. Aspetta la risposta e adatta il passo successivo. Non riversare un capitolo completo né dare immediatamente le soluzioni agli esercizi. Per strumenti pratici accompagna verso un risultato osservabile, chiedendo evidenze che gli strumenti disponibili permettono di esaminare.
4. Salva progressivamente il contenuto realmente affrontato, senza aspettare la fine di una lunga chat. Usa `lezioni/ID.md` per la lezione e file datati in `esercizi/` o `diario/` per tentativi e sessioni. Leggi prima di modificare una nota esistente: preserva appunti e risposte personali, e aggiungi sezioni datate o modifica solo sezioni generate riconoscibili. Non sovrascrivere interi file già compilati dall’utente.
5. Registra un evento `study` con esito `studied`, evidenza concreta di ciò che è stato affrontato e riferimento a una nota esistente. Ogni salvataggio successivo ha un nuovo ID evento. Il runtime collega le note al nodo e aggiorna mappa e indice, portando un nodo da iniziare a in corso. Una spiegazione letta **non** attribuisce la verifica `passed`; usa `learn-quiz` per una valutazione formale. Riferisci cosa è stato salvato e dove riprendere.

Le note Markdown includono un frontmatter con `type`, `course_id`, `node_id`, `updated` e tag, seguito da obiettivi, spiegazione, esempi, esercizi e dubbi emersi secondo necessità. Usa collegamenti `[[lezioni/ID]]`, formule `$...$` / `$$...$$` e percorsi relativi agli allegati. Non inserire l’intera lezione nell’introduzione della mappa.

Usa Mermaid, inclusi `classDiagram` e `sequenceDiagram` per UML, quando chiarisce relazioni o procedure. Per immagini controlla prima che esista uno strumento utilizzabile: se sì salva il file reale in `allegati/` con didascalia e collegamento, altrimenti usa un diagramma o spiega il limite. Non inventare immagini generate né dipendenze esterne necessarie a leggere le note.

Per fonti e software dipendenti dalla versione, consulta strumenti web/documentazione quando disponibili e cita le fonti utilizzate nella nota. Distingui contenuti spiegati, esercizi tentati e risultati osservati. Una sessione interrotta deve poter riprendere dai file.
