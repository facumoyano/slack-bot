import { answerQuestion } from "./ask.ts";
import { FILES_ROOT } from "./files.ts";
import { runInbox } from "./inbox.ts";
import { ensureRun, findRepo, knownGithubRepos, realOrca } from "./orca.ts";
import { limitRepos } from "./parse.ts";
import { classifyWithJev } from "./route.ts";
import { createSlack } from "./slack.ts";
import { latestSession } from "./session.ts";
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

const allowedRepos = (process.env.ALFRED_REPOS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const knownRepos = async () => limitRepos(await knownGithubRepos(), allowedRepos);

const typesafeKey = process.env.TYPESAFE_API_KEY?.trim();
if (!typesafeKey) console.log("TYPESAFE_API_KEY is not set: plain mentions are changes, as before routing existed");
const classify = typesafeKey ? (state: Parameters<typeof classifyWithJev>[1]) => classifyWithJev(typesafeKey, state) : undefined;

const store = openStore("data/state.json");
store.data.runId = await ensureRun(store.data.runId);
store.save();
console.log(`orca: bound to run ${store.data.runId}`);

const slack = createSlack({ botToken, appToken });
await slack.start({ orca: realOrca, store, resolveRepo: findRepo, knownRepos, allowedUsers, latestSession, ask: answerQuestion, filesRoot: FILES_ROOT, classify });
await runInbox({ orca: realOrca, poster: slack.poster, store, latestSession, filesRoot: FILES_ROOT });
