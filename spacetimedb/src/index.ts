// A task queue that the database's own container works through.
//
// Clients call `submit_task`. The container connects as the database itself, so
// `ctx.sender` equals `ctx.databaseIdentity` for its calls; only those calls may
// complete tasks or write to the `log` table.
import {
  schema,
  table,
  t,
  SenderError,
  type ReducerCtx,
} from 'spacetimedb/server';

const MAX_PROMPT_LENGTH = 8_000;
const MAX_RESULT_LENGTH = 32_000;
const MAX_LOG_LENGTH = 4_000;

const spacetimedb = schema(
  {
    task: table(
      { public: true },
      {
        id: t.u64().primaryKey().autoInc(),
        prompt: t.string(),
        // 'pending' until the container completes it, then 'done'.
        status: t.string(),
        result: t.string().optional(),
        submittedBy: t.identity(),
        submittedAt: t.timestamp(),
        completedAt: t.timestamp().optional(),
      }
    ),
    // Container hosting has no log access yet, so the container logs here.
    log: table(
      { public: true },
      {
        id: t.u64().primaryKey().autoInc(),
        at: t.timestamp(),
        message: t.string(),
      }
    ),
  },
  {
    // Declared so that `spacetime publish` stores these from your shell, if set.
    // spacetime.json supplies defaults and passes both to the container.
    env: {
      OPENAI_API_KEY: t.string().optional(),
      OPENAI_MODEL: t.string().optional(),
    },
  }
);
export default spacetimedb;

// Only the database's container calls as the database itself.
function requireContainer(ctx: ReducerCtx<typeof spacetimedb.schemaType>) {
  if (!ctx.sender.isEqual(ctx.databaseIdentity)) {
    throw new SenderError('only the database container may call this reducer');
  }
}

export const submitTask = spacetimedb.reducer(
  { prompt: t.string() },
  (ctx, { prompt }) => {
    if (prompt.trim().length === 0) throw new SenderError('prompt is empty');
    if (prompt.length > MAX_PROMPT_LENGTH) {
      throw new SenderError(`prompt is longer than ${MAX_PROMPT_LENGTH} characters`);
    }
    ctx.db.task.insert({
      id: 0n,
      prompt,
      status: 'pending',
      result: undefined,
      submittedBy: ctx.sender,
      submittedAt: ctx.timestamp,
      completedAt: undefined,
    });
  }
);

export const completeTask = spacetimedb.reducer(
  { id: t.u64(), result: t.string() },
  (ctx, { id, result }) => {
    requireContainer(ctx);
    const task = ctx.db.task.id.find(id);
    if (!task) throw new SenderError(`task ${id} not found`);
    // A restarted container may retry a task it already completed.
    if (task.status !== 'pending') throw new SenderError(`task ${id} is already ${task.status}`);
    ctx.db.task.id.update({
      ...task,
      status: 'done',
      result: result.slice(0, MAX_RESULT_LENGTH),
      completedAt: ctx.timestamp,
    });
  }
);

export const appendLog = spacetimedb.reducer(
  { message: t.string() },
  (ctx, { message }) => {
    requireContainer(ctx);
    const text = message.slice(0, MAX_LOG_LENGTH);
    ctx.db.log.insert({ id: 0n, at: ctx.timestamp, message: text });
    // Also visible with `spacetime logs <database>`.
    console.info(`[container] ${text}`);
  }
);
