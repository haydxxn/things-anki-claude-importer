import { Anthropic } from "@anthropic-ai/sdk";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface ThingsTodo {
  id: string;
  title: string;
  notes: string;
}

interface Config {
  thingsTagToWatch: string;
  thingsTagProcessed: string;
  ankiDeck: string;
  ankiModel: string;
  ankiTags: string[];
  anthropicModel: string;
  anthropicMaxTokens: number;
}

const CardSchema = z.object({
  term: z.string().min(1),
  definition: z.string().min(1),
  example: z.string().min(1),
  partOfSpeech: z.string().optional(),
  synonyms: z.array(z.string().min(1)).optional(),
  notes: z.string().optional()
});

function getConfig(): Config {
  return {
    thingsTagToWatch: process.env.THINGS_TAG_TO_WATCH ?? "Anki",
    thingsTagProcessed: process.env.THINGS_TAG_PROCESSED ?? "Anki-Added",
    ankiDeck: process.env.ANKI_DECK ?? "Vocab::Inbox",
    ankiModel: process.env.ANKI_MODEL ?? "Basic",
    ankiTags: (process.env.ANKI_TAGS ?? "things,vocab").split(",").map(s => s.trim()).filter(Boolean),
    anthropicModel: process.env.ANTHROPIC_MODEL ?? "claude-3-5-haiku-latest",
    anthropicMaxTokens: Number(process.env.ANTHROPIC_MAX_TOKENS ?? "350")
  };
}

function buildThingsListTodosScript(params: { tagToWatch: string; tagProcessed: string }): string {
  const { tagToWatch, tagProcessed } = params;
  return `
on jsonEscape(s)
  set s to s as text
  set s to my replaceText(s, "\\\\", "\\\\\\\\")
  set s to my replaceText(s, "\"", "\\\\\\"")
  set s to my replaceText(s, return, "\\\\n")
  set s to my replaceText(s, linefeed, "\\\\n")
  return s
end jsonEscape

on replaceText(theText, searchString, replacementString)
  set AppleScript's text item delimiters to searchString
  set theTextItems to every text item of theText
  set AppleScript's text item delimiters to replacementString
  set theText to theTextItems as text
  set AppleScript's text item delimiters to ""
  return theText
end replaceText

set watchTagName to "${tagToWatch}"
set processedTagName to "${tagProcessed}"

tell application "Things3"
  set inboxTodos to to dos of list "Inbox"
  set out to "["
  set isFirst to true
  repeat with t in inboxTodos
    set tagNames to {}
    try
      set tagNames to name of tags of t
    end try
    if (tagNames contains watchTagName) and (not (tagNames contains processedTagName)) then
      if isFirst is false then set out to out & ","
      set isFirst to false
      set out to out & "{"
      set out to out & "\\"id\\":\\"" & my jsonEscape(id of t) & "\\","
      set out to out & "\\"title\\":\\"" & my jsonEscape(name of t) & "\\","
      set out to out & "\\"notes\\":\\"" & my jsonEscape(notes of t) & "\\""
      set out to out & "}"
    end if
  end repeat
  set out to out & "]"
end tell

return out
`;
}

async function thingsListTodos(params: { tagToWatch: string; tagProcessed: string }): Promise<ThingsTodo[]> {
  const script = buildThingsListTodosScript(params);
  const { stdout } = await execFileAsync("osascript", ["-e", script], { maxBuffer: 10_000_000 });
  const parsed = z
    .array(z.object({ id: z.string().min(1), title: z.string(), notes: z.string() }))
    .parse(JSON.parse(stdout.trim() || "[]"));
  return parsed;
}

function buildThingsMarkProcessedScript(params: { todoId: string; processedTagName: string; watchTagName: string }): string {
  const { todoId, processedTagName, watchTagName } = params;
  return `
set todoId to "${todoId}"
set processedTagName to "${processedTagName}"
set watchTagName to "${watchTagName}"

tell application "Things3"
  set theTodo to first to do whose id is todoId

  try
    set processedTag to first tag whose name is processedTagName
  on error
    set processedTag to make new tag with properties {name:processedTagName}
  end try

  try
    set watchTag to first tag whose name is watchTagName
  on error
    set watchTag to missing value
  end try

  if watchTag is not missing value then
    try
      set tags of theTodo to (tags of theTodo) - watchTag
    end try
  end if

  try
    set tags of theTodo to (tags of theTodo) & processedTag
  end try
end tell
`;
}

async function thingsMarkProcessed(params: { todoId: string; processedTagName: string; watchTagName: string }): Promise<void> {
  const script = buildThingsMarkProcessedScript(params);
  await execFileAsync("osascript", ["-e", script], { maxBuffer: 10_000_000 });
}

async function ankiInvoke<T>(action: string, params: unknown): Promise<T> {
  const response = await fetch("http://127.0.0.1:8765", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, version: 6, params })
  });
  if (!response.ok) throw new Error(`AnkiConnect HTTP ${response.status}`);
  const json = (await response.json()) as { result: T | null; error: string | null };
  if (json.error) throw new Error(`AnkiConnect error: ${json.error}`);
  if (json.result === null) throw new Error("AnkiConnect returned null result");
  return json.result;
}

function formatBack(params: {
  definition: string;
  example: string;
  partOfSpeech?: string | undefined;
  synonyms?: string[] | undefined;
  notes?: string | undefined;
}): string {
  const lines: string[] = [];
  lines.push(params.partOfSpeech ? `(${params.partOfSpeech}) ${params.definition}` : params.definition);
  lines.push("");
  lines.push(`Example: ${params.example}`);
  if (params.synonyms?.length) lines.push("", `Synonyms: ${params.synonyms.join(", ")}`);
  if (params.notes) lines.push("", `Notes: ${params.notes}`);
  return lines.join("\n");
}

async function generateCard(params: { anthropic: Anthropic; term: string; context?: string; model: string; maxTokens: number }) {
  const { anthropic, term, context, model, maxTokens } = params;
  const prompt = [
    "You generate Anki vocab cards.",
    "",
    "Return ONLY valid JSON matching this schema:",
    `{ "term": string, "definition": string, "example": string, "partOfSpeech"?: string, "synonyms"?: string[], "notes"?: string }`,
    "",
    "Rules:",
    "- definition: concise, learner-friendly, 1 sentence",
    "- example: natural sentence; if context is provided, use that sense",
    "- keep it accurate; if the term is a phrase, define the phrase",
    "- do not include markdown, code fences, or extra keys",
    "",
    `term: ${JSON.stringify(term)}`,
    context?.trim() ? `context: ${JSON.stringify(context.trim())}` : ""
  ]
    .filter(Boolean)
    .join("\n");

  const message = await anthropic.messages.create({
    model,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }]
  });

  const text = message.content
    .map(part => (part.type === "text" ? part.text : ""))
    .join("")
    .trim();

  return CardSchema.parse(JSON.parse(text));
}

async function main() {
  const config = getConfig();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("Missing ANTHROPIC_API_KEY env var.");
  }

  const anthropic = new Anthropic({ apiKey });

  const todos = await thingsListTodos({ tagToWatch: config.thingsTagToWatch, tagProcessed: config.thingsTagProcessed });
  if (!todos.length) return;

  for (const todo of todos) {
    const term = todo.title.trim();
    if (!term) continue;

    const card = await generateCard({
      anthropic,
      term,
      context: todo.notes,
      model: config.anthropicModel,
      maxTokens: config.anthropicMaxTokens
    });

    const noteId = await ankiInvoke<number>("addNote", {
      note: {
        deckName: config.ankiDeck,
        modelName: config.ankiModel,
        fields: {
          Front: card.term,
          Back: formatBack(card)
        },
        tags: config.ankiTags
      }
    });

    if (noteId) {
      await thingsMarkProcessed({
        todoId: todo.id,
        processedTagName: config.thingsTagProcessed,
        watchTagName: config.thingsTagToWatch
      });
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});

