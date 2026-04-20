# Things → Anki (Claude) vocab importer

Add a new Things 3 Inbox todo tagged `Anki`, and this script will:

1. Ask Claude for a concise definition + example (optionally using your Things notes as context)
2. Add a `Basic` note to Anki via AnkiConnect
3. Mark the Things todo as processed (removes `Anki`, adds `Anki-Added`)

## Prereqs

- macOS + Things 3
- Anki (desktop) running in the background
- AnkiConnect add-on installed in Anki
- An Anthropic API key exported as `ANTHROPIC_API_KEY`

## Setup

1. Install dependencies

```bash
cd things-anki-claude
npm install
```

1. Export your Anthropic key (example for zsh)

```bash
export ANTHROPIC_API_KEY="..."
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
- `ANKI_DECK` (default `Vocab::Inbox`)
- `ANKI_MODEL` (default `Basic`)
- `ANKI_TAGS` (default `things,vocab`)
- `ANTHROPIC_MODEL` (default `claude-3-5-haiku-latest`)
- `ANTHROPIC_MAX_TOKENS` (default `350`)

## Scheduling (2–3x/day)

See `launchagent/com.hayden.things-anki-claude.plist` for a sample LaunchAgent you can customize.