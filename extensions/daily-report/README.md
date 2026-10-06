# daily-report

End-of-day report of pi sessions: fast table + AI summary
(done vs not finished / to continue).

## Commands

| Command | What it does |
|---|---|
| `/report` | Table + AI summary for today |
| `/report fast` | Table only for today (no AI call, instant) |
| `/report yesterday` | Table + summary for yesterday |
| `/report 2026-10-04` | Table + summary for a specific date |
| `/report export [date] [file]` | Save the markdown report (default: `./report-YYYY-MM-DD.md`) |
| `/daily ...` | Alias of `/report` with the same arguments |

Outside the TUI it also works from the shell (prints to stdout, creates no session):

```bash
pi -p "/report fast"          # today's table
pi -p "/report yesterday"     # yesterday's table + summary
pi -p "/report export yesterday"  # save yesterday's report-YYYY-MM-DD.md
```

## How it works

- Reads `~/.pi/agent/sessions/<project>/*.jsonl`.
- Includes sessions with **activity** (file mtime) on the requested day,
  even if started on a previous day (marked with `*`).
- For each session it extracts: start/end time, wall-clock duration, project,
  user prompts, last assistant message, files changed (edit/write),
  meaningful commands, tokens and tool errors.
- In the TUI the table shows immediately as a panel; the summary is generated
  by the current model in **a single call with no tools** (digest capped at
  ~20k chars, 120s timeout) and shown as a markdown message.
- Outside the TUI (e.g. `pi -p`) table and summary go to stdout.

## Setup

```bash
cd ~/Documents/Progetti/pi-agent-configuration && ./setup.sh
# then inside pi:
#   /reload
```

`setup.sh` creates the symlink in `~/.pi/agent/extensions/daily-report`.
