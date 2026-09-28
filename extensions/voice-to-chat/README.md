# voice-to-chat

Dettazione vocale **100% locale** per pi. Premi un tasto per iniziare a
registrare, ripremi lo **stesso tasto** per fermarti: solo allora il testo
viene trascritto e appare nella chat di pi. Nessun servizio esterno (niente
OpenAI/Google/Azure): tutto gira in locale.

## Cross-platform

Questa estensione funziona su **Linux**, **macOS (Apple Silicon)** e
**(WSL)Windows** con un unico codice. Il backend di trascrizione viene
**scelto automaticamente** in base al sistema:

| Piattaforma      | Backend            | Hardware usato                          |
|------------------|--------------------|-----------------------------------------|
| macOS (Apple)    | **MLX Whisper**    | GPU Metal / Neural Engine               |
| Linux + NVIDIA   | **faster-whisper** | **CUDA** (GPU)                          |
| Linux / Windows  | **faster-whisper** | CPU (fallback automatico se non c'è GPU) |

La registrazione usa **`sounddevice` (PortAudio)**: stesso percorso su tutti
i sistemi, quindi non dipendiamo più da `arecord` (Linux-only).

## Come funziona

1. Premi **`Ctrl+Shift+M`** → **inizia** la registrazione. Il footer mostra
   `🎙 REC` e, sopra l'editor, compare una **piccola barra rossa animata**: una
   fila di barre (`▁▂▃▄▅▆▇█`) rosse che si alzano e abbassano simulando un'onda,
   solo per far capire che la registrazione è attiva. Niente testo (niente "REC"
   né "Ctrl+Shift+M"), solo le barre.
2. Parla con calma (italiano o inglese, lingua rilevata automaticamente).
3. Ripremi **`Ctrl+Shift+M`** → **ferma** la registrazione e parte la
   trascrizione (`✍ trascrivo…`).
4. Il testo trascritto viene scritto **nell'editor di pi** (il box di input),
   pronto da rileggere. **Non viene inviato da solo**: premi tu **Invio** quando
   sei soddisfatto. Se c'era già del testo nell'editor, la trascrizione viene
   accodata.

Durante la trascrizione, premere di nuovo `Ctrl+Shift+M` **annulla**.

## Installazione (su ogni PC)

L'estensione è semplice **codice** (`.ts` / `.py` / `.md`). Il modo consigliato
è usare il repo `pi-agent-config` su GitHub:

```bash
git clone <tuo-repo> ~/pi-agent-config
~/pi-agent-config/setup.sh        # collega le estensioni e installa il backend
```

Oppure, manualmente:

```bash
# 1. clona il repo dove pi lo va a cercare
mkdir -p ~/.pi/agent/extensions
git clone <tuo-repo> ~/.pi/agent/extensions/estensioni
ln -s ~/.pi/agent/extensions/estensioni/extensions/voice-to-chat ~/.pi/agent/extensions/voice-to-chat

# 2. installa backend + dipendenze + modello con UN comando
~/.pi/agent/extensions/voice-to-chat/setup.sh
```

> ⚠️ **Non** copiare mai il `.venv` o i modelli scaricati tra macchine
> diverse: sono specifici per SO/architettura. `setup.sh` li ricrea in locale.

Durata massima di sicurezza: 120 secondi (`--max-duration`, modificabile).

## Configurazione

Variabili d'ambiente (opzionali), lette da `voice.py`:

| Variabile | Default | Descrizione |
|-----------|---------|-------------|
| `VOICE_MODEL` | `large-v3-turbo` | Modello Whisper. `base` < `small` < `medium` < `large-v3` ≈ `large-v3-turbo`. |
| `VOICE_LANGUAGE` | `auto` | `auto`, un codice (`it`, `en`, …) o un nome (`italian`, `english`, …). |
| `VOICE_DEVICE` | `cuda` (Linux) / `mps` (Mac) | `cuda` (veloce) / `cpu` / `mps`. Se CUDA non è disponibile si passa a CPU da solo. |
| `VOICE_COMPUTE_TYPE` | `float16` (CUDA) / `int8` (CPU) | Tipo di calcolo CTranslate2. |
| `VOICE_PROMPT` | *(vuoto)* | Testo che orienta la trascrizione (nomi propri, termini tecnici…). |
| `VOICE_PYTHON` | *(vuoto)* | Percorso dell'interprete Python da usare (override). |

Esempio: italiano forzato con modello `medium` su CPU:

```bash
export VOICE_MODEL=medium VOICE_LANGUAGE=italian VOICE_DEVICE=cpu
pi
```

## Test

Trascrivi un file audio esistente, senza microfono:

```bash
# dipende da dove hai creato il venv (default: ~/.pi/voice-venv)
~/.pi/voice-venv/bin/python \
    ~/.pi/agent/extensions/voice-to-chat/voice.py --wav mia_registrazione.wav
```

Su macOS `mlx-whisper` usa **ffmpeg** per decodificare l'audio: `setup.sh` lo
installa con Homebrew (`brew install ffmpeg`) se manca.

## Risoluzione problemi

- **Nessun audio registrato / "no PortAudio device":** installa PortAudio
  (`sudo apt-get install -y libportaudio2` su Linux, `brew install portaudio`
  su Mac) e controlla il dispositivo di ingresso.
- **macOS: "ffmpeg not found":** `brew install ffmpeg` (o rilancia `setup.sh`).
- **La trascrizione è scarsa:** usa un modello più grande (`VOICE_MODEL=medium`
  o `large-v3-turbo`) e, se serve, forza la lingua.
- **CUDA non disponibile:** lo script torna automaticamente a `cpu`.
- **Lo shortcut non parte:** assicurati che l'estensione sia caricata
  (`/reload`) e che `ctrl+shift+m` non sia usato da un altro programma.
- **Indicatore non visibile:** il footer è quello in basso; il widget appare
  sopra l'editor. Entrambi scompaiono quando torni in `idle`.

## Nota importante (anti-crash)

Lo script figlio **non scrive mai sul terminale di pi**: il suo `stderr`
viene catturato su un file di log nella cartella temporanea del sistema
(`pi_voice_*.log`). Questo è
essenziale, perché scrivere direttamente sul TTY mentre la TUI di pi è attiva
corrompe il rendering (schermo "crash"). Se qualcosa non va, il log contiene i
messaggi di `voice.py`.

## Architettura

- `voice.py` — registra (`sounddevice`/PortAudio) finché non riceve SIGINT, poi
  trascrive con MLX su Mac o faster-whisper (CUDA/CPU) su Linux/Windows.
- `voice_models.py` — traduce i nomi brevi dei modelli (`large-v3-turbo`,
  `medium`, …) nei repo Hugging Face giusti per MLX
  (`mlx-community/whisper-…`). faster-whisper li capisce da solo.
- `index.ts` — estensione pi. Gestisce la macchina a stati
  `idle → recording → transcribing`, disegna l'indicatore animato e, al termine,
  mette la trascrizione nell'editor con `ctx.ui.setEditorText()` (nessun invio
  automatico). Il visualizer sopra l'editor è una piccola fila di barre rosse
  (14, con codici ANSI per il colore) animate da un'onda sinusoidale + un
  piccolo jitter casuale: serve solo da indicatore visivo che la registrazione
  è attiva, non riflette l'audio reale. Tutti i path sono risolti
  relativamente all'estensione: **zero path hardcoded**.
- `setup.sh` — crea il venv (anche senza pip, con `ensurepip`), installa
  dipendenze + modello, in modo cross-platform.
- `.gitignore` — esclude `.venv/`, `__pycache__/` e i modelli dal versioning.
