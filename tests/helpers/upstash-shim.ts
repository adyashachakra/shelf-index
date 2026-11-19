// Test helper: a tiny stand-in for Upstash's REST API in front of a REAL local redis-server.
// It lets the tests run the project's actual Redis client code and actual Lua scripts.
import { createServer, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';

type Reply = string | number | null | Reply[] | { error: string };

function encode(args: string[]): Buffer {
  const parts: Buffer[] = [Buffer.from(`*${args.length}\r\n`)];
  for (const arg of args) {
    const b = Buffer.from(arg, 'utf8');
    parts.push(Buffer.from(`$${b.length}\r\n`), b, Buffer.from('\r\n'));
  }
  return Buffer.concat(parts);
}

function parse(buffer: Buffer, offset: number): { value: Reply; next: number } | null {
  const lineEnd = buffer.indexOf('\r\n', offset);
  if (lineEnd === -1) return null;
  const type = String.fromCharCode(buffer[offset]);
  const line = buffer.toString('utf8', offset + 1, lineEnd);
  const after = lineEnd + 2;
  if (type === '+') return { value: line, next: after };
  if (type === '-') return { value: { error: line }, next: after };
  if (type === ':') return { value: Number(line), next: after };
  if (type === '$') {
    const length = Number(line);
    if (length === -1) return { value: null, next: after };
    if (buffer.length < after + length + 2) return null;
    return { value: buffer.toString('utf8', after, after + length), next: after + length + 2 };
  }
  if (type === '*') {
    const count = Number(line);
    if (count === -1) return { value: null, next: after };
    const items: Reply[] = [];
    let cursor = after;
    for (let i = 0; i < count; i += 1) {
      const item = parse(buffer, cursor);
      if (!item) return null;
      items.push(item.value);
      cursor = item.next;
    }
    return { value: items, next: cursor };
  }
  throw new Error(`Unexpected RESP type ${type}`);
}

class RedisConnection {
  private socket: Socket;
  private buffer = Buffer.alloc(0);
  private waiting: ((reply: Reply) => void)[] = [];
  constructor(port: number) {
    this.socket = connect(port, '127.0.0.1');
    this.socket.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      for (;;) {
        const parsed = parse(this.buffer, 0);
        if (!parsed) break;
        this.buffer = this.buffer.subarray(parsed.next);
        const resolve = this.waiting.shift();
        if (resolve) resolve(parsed.value);
      }
    });
  }
  send(args: string[]): Promise<Reply> {
    return new Promise((resolve) => {
      this.waiting.push(resolve);
      this.socket.write(encode(args));
    });
  }
  close(): void {
    this.socket.destroy();
  }
}

function toBody(reply: Reply): { result?: Reply; error?: string } {
  if (reply !== null && typeof reply === 'object' && !Array.isArray(reply)) return { error: reply.error };
  return { result: reply };
}

/** What the shim does instead of running a command: answer with an error or a made-up result, or drop the connection. */
export type Intercept = { error: string; status?: number } | { result: unknown } | 'drop';

export interface Shim {
  url: string;
  /** Called before each command is run. Return an Intercept to replace Redis's answer. The command is NOT run then. */
  intercept: ((args: string[]) => Intercept | null) | null;
  /** Every command the app sent (pipeline entries counted one by one), whether or not it was intercepted. */
  sent: string[][];
  /** Only the commands that really ran on Redis. */
  executed: string[][];
  token: string;
  requests: number;
  close(): Promise<void>;
  flush(): Promise<void>;
  raw(...args: string[]): Promise<Reply>;
}

export async function startShim(redisPort: number, db = 0): Promise<Shim> {
  const token = 'test-token';
  const redis = new RedisConnection(redisPort);
  await redis.send(['SELECT', String(db)]);
  const state = { requests: 0 };
  const hooks: { intercept: Shim['intercept']; sent: string[][]; executed: string[][] } = { intercept: null, sent: [], executed: [] };
  /** Run one command through the hook; null means "run normally". */
  const intercepted = (args: string[]): Intercept | null => {
    hooks.sent.push(args);
    const action = hooks.intercept ? hooks.intercept(args) : null;
    if (!action) hooks.executed.push(args);
    return action;
  };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      state.requests += 1;
      res.setHeader('Content-Type', 'application/json');
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (req.url === '/pipeline') {
          const out: unknown[] = [];
          for (const command of body as string[][]) {
            const args = command.map(String);
            const action = intercepted(args);
            if (action === 'drop') {
              req.socket.destroy();
              return;
            }
            if (action && 'error' in action) out.push({ error: action.error });
            else if (action) out.push({ result: action.result });
            else out.push(toBody(await redis.send(args)));
          }
          res.end(JSON.stringify(out));
          return;
        }
        const args = (body as string[]).map(String);
        const action = intercepted(args);
        if (action === 'drop') {
          req.socket.destroy();
          return;
        }
        if (action && 'error' in action) {
          res.statusCode = action.status ?? 400;
          res.end(JSON.stringify({ error: action.error }));
          return;
        }
        if (action) {
          res.end(JSON.stringify({ result: action.result }));
          return;
        }
        const reply = toBody(await redis.send(args));
        if (reply.error) res.statusCode = 400;
        res.end(JSON.stringify(reply));
      } catch (err) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    get requests() {
      return state.requests;
    },
    get intercept() {
      return hooks.intercept;
    },
    set intercept(value: Shim['intercept']) {
      hooks.intercept = value;
    },
    get sent() {
      return hooks.sent;
    },
    get executed() {
      return hooks.executed;
    },
    async flush() {
      await redis.send(['FLUSHDB']);
    },
    raw: (...args: string[]) => redis.send(args),
    async close() {
      redis.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
