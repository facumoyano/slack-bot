import { runInbox } from "./inbox.ts";
import { ensureRun, findRepo, realOrca } from "./orca.ts";
import { createSlack } from "./slack.ts";
import { openStore } from "./store.ts";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`missing env ${name} (see .env.example; start with node --env-file=.env src/main.ts)`);
    process.exit(1);
  }
  return value;
}

const botToken = requireEnv("SLACK_BOT_TOKEN");
const appToken = requireEnv("SLACK_APP_TOKEN");
const allowedUsers = new Set(requireEnv("ALLOWED_SLACK_USERS").split(",").map((s) => s.trim()).filter(Boolean));

const store = openStore("data/state.json");
store.data.runId = await ensureRun(store.data.runId);
store.save();
console.log(`orca: bound to run ${store.data.runId}`);

const slack = createSlack({ botToken, appToken, allowedUsers });
await slack.start({ orca: realOrca, store, resolveRepo: findRepo });
await runInbox({ orca: realOrca, poster: slack.poster, store });
