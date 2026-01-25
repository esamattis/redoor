import { spawn, ChildProcess } from 'node:child_process'

export class ProcessManager {
  private processes: Map<number, ChildProcess> = new Map()

  spawn(command: string, args: string[], cwd?: string): number {
    const proc = spawn(command, args, {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd,
    })

    const pid = proc.pid
    if (pid === undefined) {
      throw new Error('Failed to get process PID')
    }

    this.processes.set(pid, proc)
    return pid
  }

  kill(pid: number): void {
    try {
      process.kill(pid, 'SIGKILL')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH') {
        throw e
      }
    }
    this.processes.delete(pid)
  }

  killAll(): void {
    for (const pid of this.processes.keys()) {
      this.kill(pid)
    }
  }

  getProcess(pid: number): ChildProcess | undefined {
    return this.processes.get(pid)
  }

  async waitForExit(pid: number, timeoutMs: number = 10000): Promise<number | null> {
    const process = this.processes.get(pid)
    if (!process) {
      throw new Error(`Process not found: ${pid}`)
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timeout waiting for process ${pid} to exit`))
      }, timeoutMs)

      process.once('exit', (code) => {
        clearTimeout(timeout)
        resolve(code)
      })
    })
  }
}

export async function waitForPort(port: number, maxRetries = 50): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`)
      if (response.ok) {
        return
      }
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  throw new Error(`Port ${port} not ready after ${maxRetries} retries`)
}

export async function waitForLogMessage(
  process: ChildProcess,
  pattern: RegExp,
  timeoutMs: number = 10000
): Promise<void> {
  const stream = process.stdout || process.stderr
  if (!stream) {
    throw new Error('No stdout/stderr stream available')
  }

  let resolve: () => void
  let reject: (error: Error) => void

  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })

  const onData = (chunk: Buffer) => {
    const line = chunk.toString()
    if (pattern.test(line)) {
      clearTimeout(timeout)
      stream.off('data', onData)
      resolve()
    }
  }

  stream.on('data', onData)

  const timeout = setTimeout(() => {
    stream.off('data', onData)
    reject(new Error(`Timeout waiting for log pattern: ${pattern}`))
  }, timeoutMs)

  return promise
}
