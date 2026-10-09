// The program that runs in the database's container.
//
// It connects to its database as the database itself, using the credential the
// platform mounts into the container, and works through pending tasks: an LLM call
// when OPENAI_API_KEY is set, otherwise an echo. It exits with code 1 when the
// connection ends, so that the `on-failure` restart policy restarts it with a
// fresh credential.
import { readFileSync } from 'node:fs';
import type { Identity } from 'spacetimedb';
import {
  DbConnection,
  tables,
  type ErrorContext,
} from './module_bindings';

// Set by the platform in every container.
const uri = requireEnv('SPACETIMEDB_URI');
const database = requireEnv('SPACETIMEDB_DATABASE_IDENTITY');
const tokenFile = requireEnv('SPACETIMEDB_TOKEN_FILE');

// Database environment values, passed by `container.env-keys` in spacetime.json.
// An empty OPENAI_API_KEY means echo mode.
const openaiApiKey = process.env.OPENAI_API_KEY || undefined;
const openaiModel = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const LLM_TIMEOUT_MS = 120_000;
// Matches the module's limit on results.
const MAX_RESULT_LENGTH = 32_000;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is not set; run this program in a SpacetimeDB container`);
    process.exit(1);
  }
  return value;
}

function exit(reason: string, error?: unknown): never {
  console.error(reason, error ?? '');
  process.exit(1);
}

// Read the token for each connection, never ahead of time: the platform rewrites
// the file every 5 minutes, and each token expires after 10 minutes. This program
// connects once per run; one that reconnects in-process must call this each time.
function readToken(): string {
  return readFileSync(tokenFile, 'utf8').trim();
}

function connect(): DbConnection {
  return DbConnection.builder()
    .withUri(uri)
    .withDatabaseName(database)
    .withToken(readToken())
    .onConnect(onConnect)
    .onConnectError((_ctx: ErrorContext, error: Error) =>
      exit('Unable to connect:', error)
    )
    .onDisconnect((_ctx: ErrorContext, error?: Error) =>
      exit('Disconnected:', error)
    )
    .build();
}

function onConnect(conn: DbConnection, identity: Identity): void {
  const me = identity.toHexString().toLowerCase().replace(/^0x/, '');
  console.log(`Connected to ${database} as ${me}`);
  if (me !== database.toLowerCase().replace(/^0x/, '')) {
    // The module rejects our calls unless we are the database.
    exit('Connected, but not as the database; check SPACETIMEDB_TOKEN_FILE');
  }

  // Runs for rows already pending when the subscription applies, and for new ones.
  conn.db.task.onInsert((_ctx, task) => enqueue(conn, task.id));
  conn
    .subscriptionBuilder()
    .onApplied(() =>
      log(
        conn,
        `agent started (${openaiApiKey ? `LLM model ${openaiModel}` : 'echo mode, OPENAI_API_KEY not set'})`
      )
    )
    .onError(ctx => exit('Subscription failed:', ctx.event))
    .subscribe(tables.task.where(task => task.status.eq('pending')));
}

// Tasks are worked one at a time, in arrival order.
const queue: bigint[] = [];
const queued = new Set<bigint>();
let working = false;

function enqueue(conn: DbConnection, id: bigint): void {
  if (queued.has(id)) return;
  queued.add(id);
  queue.push(id);
  void drain(conn);
}

async function drain(conn: DbConnection): Promise<void> {
  if (working) return;
  working = true;
  try {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      // Only pending tasks are subscribed, so a completed one is gone.
      const task = conn.db.task.id.find(id);
      if (task) await work(conn, task.id, task.prompt);
      queued.delete(id);
    }
  } finally {
    working = false;
  }
}

async function work(conn: DbConnection, id: bigint, prompt: string): Promise<void> {
  await log(conn, `task ${id}: started`);
  let result: string;
  try {
    result = openaiApiKey ? await complete(openaiApiKey, prompt) : `echo: ${prompt}`;
  } catch (error) {
    result = `error: ${message(error)}`;
  }
  try {
    await conn.reducers.completeTask({ id, result: result.slice(0, MAX_RESULT_LENGTH) });
    await log(conn, `task ${id}: done`);
  } catch (error) {
    // For example, the task was completed by an earlier run of this program.
    await log(conn, `task ${id}: unable to complete: ${message(error)}`);
  }
}

// OpenAI chat completions, with fetch.
async function complete(apiKey: string, prompt: string): Promise<string> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: openaiModel,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });
  const body = (await response.json().catch(() => undefined)) as
    | {
        choices?: { message?: { content?: string | null } }[];
        error?: { message?: string };
      }
    | undefined;
  if (!response.ok) {
    throw new Error(`OpenAI returned ${response.status}: ${body?.error?.message ?? response.statusText}`);
  }
  return body?.choices?.[0]?.message?.content ?? '';
}

// The container's logs are not available yet, so log to the database too.
async function log(conn: DbConnection, text: string): Promise<void> {
  console.log(text);
  try {
    await conn.reducers.appendLog({ message: text });
  } catch (error) {
    console.error(`Unable to append to the log table: ${message(error)}`);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

connect();
