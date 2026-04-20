# Things → Anki (Claude) vocab importer

Add a new Things 3 Inbox todo tagged `Anki`, and this script will:

1. Ask Claude for a concise definition + example (optionally using your Things notes as context)
2. Add a `Basic` note to Anki via AnkiConnect
3. Mark the Things todo as completed (and removes `Anki`, adds `Anki-Added`)

## Prereqs

- macOS + Things 3
- Anki (desktop) running in the background
- AnkiConnect add-on installed in Anki
- Either:
  - an Anthropic API key exported as `ANTHROPIC_API_KEY` (default), or
  - an OpenRouter API key exported as `OPENROUTER_API_KEY`

## Setup

1. Install dependencies

```bash
npm install
```

1. Choose an LLM provider

Anthropic (default):

```bash
export ANTHROPIC_API_KEY="..."
```

OpenRouter:

```bash
export LLM_PROVIDER="openrouter"
export OPENROUTER_API_KEY="..."
```

1. Make sure Anki is open, then run once

```bash
npm run dev
```

## Things conventions

- **Todo title**: the vocab word/phrase (e.g. `ubiquitous`, `take for granted`)
- **Todo notes** (optional): the sentence/context you saw it in (improves sense disambiguation)
- **Todo tag**: `Anki` (watched tag)

After import, the script removes `Anki` and adds `Anki-Added`.

## Configuration (optional)

All optional env vars:

- `THINGS_TAG_TO_WATCH` (default `Anki`)
- `THINGS_TAG_PROCESSED` (default `Anki-Added`)
- `ANKI_DECK` (default `English Vocab`)
- `ANKI_MODEL` (default `Basic`)
- `ANKI_TAGS` (default `things,vocab`)
- `LLM_PROVIDER` (default `anthropic`, options: `anthropic` | `openrouter`)
- `LLM_MODEL` (default: Anthropic `claude-3-5-haiku-latest`, OpenRouter `anthropic/claude-3.5-haiku`)
- `LLM_MAX_TOKENS` (default `350`)

## Cost / credit behavior

- The script always queries Things + Anki locally.
- **It only calls the LLM if there is at least one Things Inbox todo tagged `Anki` that isn't already in Anki.**
  - If there are no matching todos, it exits immediately (no API cost).
  - If a todo's `Front` already exists in your target deck, it skips the LLM and just completes the Things todo.

## Scheduling (every 2 hours)

Run this to generate a LaunchAgent plist for *your* local repo path:

```bash
npm run install:launchagent
```

This writes to:

- `~/Library/LaunchAgents/com.things-anki-claude.plist`

Then edit that file to add your API key(s), and load it with:

```bash
launchctl load ~/Library/LaunchAgents/com.things-anki-claude.plist
```

## Run / stop / logs

Manual run (one-off):

```bash
npm run dev
```

Check if the background job is loaded:

```bash
launchctl list | rg "com.things-anki-claude"
```

Force a run immediately (because `RunAtLoad` is true):

```bash
launchctl unload ~/Library/LaunchAgents/com.things-anki-claude.plist
launchctl load ~/Library/LaunchAgents/com.things-anki-claude.plist
```

Stop background job:

```bash
launchctl unload ~/Library/LaunchAgents/com.things-anki-claude.plist
```

Check logs:

- `/tmp/things-anki-claude.out.log`
- `/tmp/things-anki-claude.err.log`

View logs:

```bash
tail -n 200 /tmp/things-anki-claude.out.log
tail -n 200 /tmp/things-anki-claude.err.log
```

