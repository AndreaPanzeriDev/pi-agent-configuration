# pi-agent-config

La mia configurazione personale del **[Pi coding agent](https://pi.dev)**: le
estensioni cross-platform, il setup automatico e i file di configurazione, in
un unico repo riproducibile su **Linux** e **macOS (Apple Silicon)**.

## Contenuto

| Percorso | Cosa è |
|----------|--------|
| `extensions/voice-to-chat/` | Dettatura vocale **100% locale**. macOS → **MLX**, Linux/Windows → **faster-whisper** (CUDA se disponibile). Registrazione cross-platform con `sounddevice`/PortAudio. |
| `extensions/pi-banner.ts` | Mostra il titolo della sessione (generato automaticamente dal primo messaggio) in header, riga sticky e titolo del terminale. Comando `/title`. |
| `extensions/token-stats/` | Conta token e costi per sessione, modello e progetto, con grafico giornaliero. Comandi `/stats`, `/stats export`, `/stats prune`, `/stats reset`. |
| `extensions/response-sound.ts` | Suona un breve suono quando Pi finisce di rispondere. Comandi `/sound`. Già cross-platform (`afplay`, `paplay`, …). |
| `setup.sh` | Riproduce tutta la configurazione su una macchina nuova. |
| `examples/` | File di configurazione di esempio (`settings.json`, `models.json`, `response-sound.json`, `pi-banner.json`). |

## Installazione su una macchina nuova

```bash
git clone <tuo-URL> ~/pi-agent-config
~/pi-agent-config/setup.sh
```

Lo script:
1. collega ogni estensione dentro `~/.pi/agent/extensions/` (symlink);
2. installa i file di config di esempio **solo se non esistono già**;
3. esegue il `setup.sh` di ogni estensione (per `voice-to-chat`: crea il venv
   Python, installa PortAudio + ffmpeg su macOS e il modello Whisper).

Se vuoi solo i collegamenti e i config, senza installare le dipendenze native:

```bash
~/pi-agent-config/setup.sh --no-native
```

Poi:
```bash
pi          # e dentro:  /login   (le chiavi API NON sono versionate)
```

### Alternativa: come Pi Package

Il repo è anche un valido **Pi Package**:

```bash
pi install git:github.com/<tuo-utente>/<repo>
```

> Nota: l'installazione come package non esegue il setup nativo Python; per la
> dettatura vocale serve comunque eseguire
> `extensions/voice-to-chat/setup.sh`.

## ⚠️ Sicurezza

- **`auth.json` non è nel repo** (contiene le chiavi API). Su ogni macchina
  devi rifare `/login`, oppure copiartelo manualmente in modo sicuro.
- `models.json` / `models-store.json` puntano a endpoint **locali** (es.
  `http://localhost:8888`) — modificali per le tue macchine.

## Aggiornare

```bash
cd ~/pi-agent-config && git pull
# se hai aggiunto/modificato estensioni:
./setup.sh
```

## Struttura

```
pi-agent-config/
├── package.json          # manifest Pi Package
├── setup.sh              # installer master (Linux/macOS), --no-native opzionale
├── .gitignore            # esclude auth.json, venv, __pycache__
├── extensions/
│   ├── voice-to-chat/
│   │   ├── index.ts        # estensione Pi
│   │   ├── voice.py        # backend Python cross-platform (MLX / faster-whisper)
│   │   ├── voice_models.py # mapping nomi modello → repo MLX
│   │   ├── setup.sh        # installa venv + PortAudio/ffmpeg + modello
│   │   ├── README.md
│   │   └── .gitignore
│   ├── pi-banner.ts      # titolo sessione + header
│   ├── token-stats/      # statistiche token/costi (/stats)
│   │   └── index.ts
│   └── response-sound.ts
└── examples/
    ├── settings.json
    ├── models.json
    ├── response-sound.json
    └── pi-banner.json
```

## Test rapido dell'estensione vocale

```bash
~/.pi/voice-venv/bin/python ~/.pi/agent/extensions/voice-to-chat/voice.py \
    --wav mia_registrazione.wav
```
