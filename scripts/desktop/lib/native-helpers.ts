import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { platformRuntime } from '../../../src/server/platform.js';

export interface WaitForOptions {
  description: string;
  timeoutMs?: number;
  intervalMs?: number;
}

export async function allocateLocalPort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  assert(address && typeof address !== 'string', 'Failed to allocate a local loopback port');
  await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

export async function waitFor<T>(
  check: () => T | Promise<T>,
  options: string | WaitForOptions,
): Promise<NonNullable<T>> {
  const { description, timeoutMs = 15_000, intervalMs = 50 } =
    typeof options === 'string' ? { description: options } : options;
  const deadline = performance.now() + timeoutMs;
  while (true) {
    const result = await check();
    if (result) return result as NonNullable<T>;
    if (performance.now() >= deadline) assert.fail(description);
    await delay(intervalMs);
  }
}

export async function stopChild(
  child: ChildProcess | undefined,
  closed?: Promise<unknown>,
  options: { signal?: NodeJS.Signals; graceMs?: number; killMs?: number } = {},
): Promise<void> {
  if (!child) return;
  const hasExited = () => child.exitCode !== null || child.signalCode !== null;
  if (hasExited()) {
    await closed?.catch(() => {});
    return;
  }
  const exited = closed ?? once(child, 'close');
  const { signal = 'SIGTERM', graceMs = 5_000, killMs = 3_000 } = options;
  try {
    child.kill(signal);
  } catch {
    if (hasExited()) return;
  }
  const waitWithDeadline = async (ms: number) => {
    const outcome = await Promise.race([
      exited.then(
        () => 'exited' as const,
        () => 'exited' as const,
      ),
      delay(ms, 'timeout' as const, { ref: false }),
    ]);
    return outcome === 'exited';
  };
  if (await waitWithDeadline(graceMs)) return;
  if (!hasExited()) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* Process exited right before escalation. */
    }
    await waitWithDeadline(killMs);
  }
}

export async function runCleanups(steps: Array<() => unknown | Promise<unknown>>): Promise<void> {
  const errors: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Multiple desktop smoke cleanup errors');
}

export function normalizeWindowsStateFiles(stateDir: string, names: readonly string[]): void {
  if (process.platform !== 'win32') return;
  const runtime = platformRuntime();
  for (const name of names) {
    const file = join(stateDir, name);
    if (existsSync(file)) runtime.privateFile(file);
  }
}

export interface SpawnNativeAdapterOptions {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  origin: string;
  timeoutMs?: number;
  stopSignal?: NodeJS.Signals;
  forwardStderr?: boolean;
  stdin?: 'ignore' | 'pipe';
}

export interface RunningNativeAdapter {
  child: ChildProcess;
  url: URL;
  host: string;
  pairCode: string;
  stderrTail: () => string;
  stop: () => Promise<void>;
}

export async function spawnNativeAdapter(options: SpawnNativeAdapterOptions): Promise<RunningNativeAdapter> {
  const {
    command,
    args,
    env,
    origin,
    timeoutMs = 20_000,
    stopSignal = 'SIGTERM',
    forwardStderr = false,
    stdin = 'ignore',
  } = options;
  const child = spawn(command, args, {
    env,
    stdio: [stdin, 'pipe', 'pipe'],
  });
  let diagnostics = '';
  child.stderr!.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    diagnostics = (diagnostics + text).slice(-6000);
    if (forwardStderr) process.stderr.write(chunk);
  });
  const closed = once(child, 'close');
  void closed.catch(() => {});
  const lines = createInterface({ input: child.stdout! });
  let timedOut = false;
  const stop = async () => {
    lines.close();
    await stopChild(child, closed, { signal: stopSignal });
  };
  const timer = setTimeout(() => {
    timedOut = true;
    lines.close();
  }, timeoutMs);
  try {
    for await (const line of lines) {
      if (!line.startsWith(origin)) continue;
      const url = new URL(line);
      const params = new URLSearchParams(url.hash.slice(1));
      const host = params.get('host');
      const pairCode = params.get('pair');
      assert(host && pairCode, `Native adapter pairing URL was incomplete: ${line}`);
      return {
        child,
        url,
        host,
        pairCode,
        stderrTail: () => diagnostics.trim(),
        stop,
      };
    }
    const reason = timedOut
      ? `timed out after ${timeoutMs} ms`
      : `exited with code=${String(child.exitCode)} signal=${String(child.signalCode)}`;
    const tail = diagnostics.trim();
    throw new Error(
      `Native adapter did not advertise a pairing link (${reason})${tail ? `\n--- stderr ---\n${tail}` : ''}`,
    );
  } catch (error) {
    await stop();
    throw error;
  } finally {
    clearTimeout(timer);
    lines.close();
  }
}
