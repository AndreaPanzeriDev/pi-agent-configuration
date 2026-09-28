# pi-agent-config

La mia configurazione personale del **[Pi coding agent](https://pi.dev)**: le
estensioni cross-platform, il setup automatico e i file di configurazione, in
un unico repo riproducibile su **Linux** e **macOS (Apple Silicon)**.

## Contenuto

| Percorso | Cosa è |
|----------|--------|
| `extensions/voice-to-chat/` | Dettatura vocale **100% locale**. macOS → **MLX**, Linux/Windows → **faster-whisper** (CUDA se disponibile). Registrazione cross-platform con `sounddevice`/PortAudio. |
| `extensions/response-sound.ts` | Suona un breve suono quando Pi finisce di rispondere. Comandi `/sound`. Già cross-platform (`afplay`, `paplay`, …). |
| `setup.sh` | Riproduce tutta la configurazione su una macchina nuova. |
| `examples/` | File di configurazione di esempio (`settings.json`, `models.json`, `response-sound.json`). |

## Installazione su una macchina nuova

```bash
git clone <tuo-URL> ~/pi-agent-config
~/pi-agent-config/setup.sh
```

Lo script:
1. collega ogni estensione dentro `~/.pi/agent/extensions/` (symlink);
2. installa i file di config di esempio **solo se non esistono già**;
3. esegue il `setup.sh` di ogni estensione (per `voice-to-chat`: crea il venv
   Python, installa PortAudio + il modello Whisper).

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
├── setup.sh              # installer master (Linux/macOS)
├── .gitignore            # esclude auth.json, venv, __pycache__
├── extensions/
│   ├── voice-to-chat/
│   │   ├── index.ts      # estensione Pi
│   │   ├── voice.py      # backend Python cross-platform (MLX / faster-whisper)
│   │   ├── setup.sh      # installa venv + PortAudio + modello
│   │   ├── README.md
│   │   └── .gitignore
│   └── response-sound.ts
└── examples/
    ├── settings.json
    ├── models.json
    └── response-sound.json
```

## Test rapido dell'estensione vocale

```bash
~/.pi/voice-venv/bin/python ~/.pi/agent/extensions/voice-to-chat/voice.py \
    --wav mia_registrazione.wav
```
