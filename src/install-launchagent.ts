import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

async function main() {
  const repoDir = resolve(process.cwd());
  const templatePath = resolve(repoDir, "launchagent", "com.things-anki-claude.plist.template");
  const template = await readFile(templatePath, "utf8");

  const rendered = template.replaceAll("__REPO_DIR__", repoDir);
  if (rendered.includes("__REPO_DIR__")) throw new Error("Failed to render LaunchAgent template.");

  const launchAgentsDir = resolve(homedir(), "Library", "LaunchAgents");
  await mkdir(launchAgentsDir, { recursive: true });

  const targetPath = resolve(launchAgentsDir, "com.things-anki-claude.plist");
  await writeFile(targetPath, rendered, "utf8");

  // Intentionally no launchctl side effects. User can edit API keys first.
  process.stdout.write(`Wrote LaunchAgent plist to:\n${targetPath}\n`);
  process.stdout.write("Schedule: runs every 2 hours (see StartInterval in the plist).\n");
  process.stdout.write("Next: edit it to add your API key(s), then `launchctl load` it.\n");
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});

