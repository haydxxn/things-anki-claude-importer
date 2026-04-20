import { Anthropic } from "@anthropic-ai/sdk";
import OpenAI from "openai";
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
  llmProvider: "anthropic" | "openrouter";
  llmModel: string;
  llmMaxTokens: number;
}

const CardSchema = z.object({
  term: z.string().min(1),
  ipa: z.string().min(1),
  definition: z.string().min(1),
  example: z.string().min(1),
  partOfSpeech: z.string().optional(),
  synonyms: z.array(z.string().min(1)).optional(),
  notes: z.string().optional()
});

function getConfig(): Config {
  const llmProvider = (process.env.LLM_PROVIDER ?? "anthropic") as Config["llmProvider"];
  const llmModelDefault = llmProvider === "openrouter" ? "anthropic/claude-3.5-haiku" : "claude-3-5-haiku-latest";
  return {
    thingsTagToWatch: process.env.THINGS_TAG_TO_WATCH ?? "Anki",
    thingsTagProcessed: process.env.THINGS_TAG_PROCESSED ?? "Anki-Added",
    ankiDeck: process.env.ANKI_DECK ?? "English Vocab",
    ankiModel: process.env.ANKI_MODEL ?? "Basic",
    ankiTags: (process.env.ANKI_TAGS ?? "things,vocab").split(",").map(s => s.trim()).filter(Boolean),
    llmProvider,
    llmModel: process.env.LLM_MODEL ?? llmModelDefault,
    llmMaxTokens: Number(process.env.LLM_MAX_TOKENS ?? "350")
  };
}

function buildThingsListTodosScript(params: { tagToWatch: string; tagProcessed: string }): string {
  const { tagToWatch, tagProcessed } = params;
  return `
on jsonEscape(s)
  set s to s as text
  set s to my replaceText(s, "\\\\", "\\\\\\\\")
  -- AppleScript string escaping for a literal double-quote is awkward; use the built-in quote constant instead.
  set s to my replaceText(s, quote, "\\\\" & quote)
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

function buildThingsMarkCompletedScript(params: { todoId: string; processedTagName: string; watchTagName: string }): string {
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

  set status of theTodo to completed

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

async function thingsMarkCompleted(params: { todoId: string; processedTagName: string; watchTagName: string }): Promise<void> {
  const script = buildThingsMarkCompletedScript(params);
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

function escapeAnkiQueryText(text: string): string {
  return text.replaceAll('"', '\\"');
}

async function ankiHasBasicFront(params: { deckName: string; front: string }): Promise<boolean> {
  const deckName = escapeAnkiQueryText(params.deckName);
  const front = escapeAnkiQueryText(params.front);
  const query = `deck:"${deckName}" "Front:${front}"`;
  const noteIds = await ankiInvoke<number[]>("findNotes", { query });
  return noteIds.length > 0;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatBack(params: {
  ipa: string;
  definition: string;
  example: string;
  partOfSpeech?: string | undefined;
  synonyms?: string[] | undefined;
  notes?: string | undefined;
}): string {
  const ipa = escapeHtml(params.ipa.replaceAll("/", ""));
  const partOfSpeech = params.partOfSpeech ? escapeHtml(params.partOfSpeech) : null;
  const definition = escapeHtml(params.definition);
  const example = escapeHtml(params.example);
  const notes = params.notes ? escapeHtml(params.notes) : null;
  const synonyms = params.synonyms?.length ? params.synonyms.map(s => escapeHtml(s)) : null;

  const rows: string[] = [];
  rows.push(`<div><b>IPA</b>: /${ipa}/</div>`);
  if (partOfSpeech) rows.push(`<div><b>Part of speech</b>: ${partOfSpeech}</div>`);
  rows.push(`<div style="margin-top:10px"><b>Definition</b><br>${definition}</div>`);
  rows.push(`<div style="margin-top:10px"><b>Example</b><br>${example}</div>`);

  if (synonyms) {
    rows.push(`<div style="margin-top:10px"><b>Synonyms</b><br>${synonyms.join("<br>")}</div>`);
  }

  if (notes) rows.push(`<div style="margin-top:10px"><b>Notes</b><br>${notes}</div>`);

  return rows.join("");
}

async function generateCard(params: { anthropic: Anthropic; term: string; context?: string; model: string; maxTokens: number }) {
  const { anthropic, term, context, model, maxTokens } = params;
  const prompt = [
    "You generate Anki vocab cards.",
    "",
    "Return ONLY valid JSON matching this schema:",
    `{ "term": string, "ipa": string, "definition": string, "example": string, "partOfSpeech"?: string, "synonyms"?: string[], "notes"?: string }`,
    "",
    "Rules:",
    "- ipa: IPA pronunciation (no surrounding slashes)",
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

async function generateCardViaOpenRouter(params: { term: string; context?: string; model: string; maxTokens: number }) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY env var.");

  const prompt = [
    "You generate Anki vocab cards.",
    "",
    "Return ONLY valid JSON matching this schema:",
    `{ "term": string, "ipa": string, "definition": string, "example": string, "partOfSpeech"?: string, "synonyms"?: string[], "notes"?: string }`,
    "",
    "Rules:",
    "- ipa: IPA pronunciation (no surrounding slashes)",
    "- definition: concise, learner-friendly, 1 sentence",
    "- example: natural sentence; if context is provided, use that sense",
    "- keep it accurate; if the term is a phrase, define the phrase",
    "- do not include markdown, code fences, or extra keys",
    "",
    `term: ${JSON.stringify(params.term)}`,
    params.context?.trim() ? `context: ${JSON.stringify(params.context.trim())}` : ""
  ]
    .filter(Boolean)
    .join("\n");

  const client = new OpenAI({
    apiKey,
    baseURL: "https://openrouter.ai/api/v1",
    defaultHeaders: {
      "HTTP-Referer": "http://localhost",
      "X-Title": "things-anki-claude"
    }
  });

  const completion = await client.chat.completions.create({
    model: params.model,
    messages: [{ role: "user", content: prompt }],
    max_tokens: params.maxTokens
  });

  const text = completion.choices[0]?.message?.content?.trim();
  if (!text) throw new Error("OpenRouter returned empty content.");
  return CardSchema.parse(JSON.parse(text));
}

async function main() {
  const config = getConfig();
  const todos = await thingsListTodos({ tagToWatch: config.thingsTagToWatch, tagProcessed: config.thingsTagProcessed });
  if (!todos.length) return;

  const anthropic = config.llmProvider === "anthropic" ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? "" }) : null;
  if (config.llmProvider === "anthropic" && !process.env.ANTHROPIC_API_KEY) throw new Error("Missing ANTHROPIC_API_KEY env var.");

  for (const todo of todos) {
    const term = todo.title.trim();
    if (!term) continue;

    const alreadyInAnki = await ankiHasBasicFront({ deckName: config.ankiDeck, front: term });
    if (alreadyInAnki) {
      await thingsMarkCompleted({
        todoId: todo.id,
        processedTagName: config.thingsTagProcessed,
        watchTagName: config.thingsTagToWatch
      });
      continue;
    }

    const card =
      config.llmProvider === "openrouter"
        ? await generateCardViaOpenRouter({ term, context: todo.notes, model: config.llmModel, maxTokens: config.llmMaxTokens })
        : await generateCard({
            anthropic: anthropic!,
            term,
            context: todo.notes,
            model: config.llmModel,
            maxTokens: config.llmMaxTokens
          });

    let didAdd = false;
    try {
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
      didAdd = Boolean(noteId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.toLowerCase().includes("duplicate")) didAdd = true;
      else throw err;
    }

    if (didAdd) {
      await thingsMarkCompleted({
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

