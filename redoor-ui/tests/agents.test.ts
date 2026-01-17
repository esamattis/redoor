import { spawn, ChildProcess } from 'node:child_process'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { LsResponse } from '../../bindings/LsResponse'
import type { ErrorResponse } from '../../bindings/ErrorResponse'
import type { AgentListResponse } from '../../bindings/AgentListResponse'
import path from 'node:path'

const SERVER_PORT = 3000
const SERVER_PATH = path.join(__dirname, '../../target/debug/redoor')
const AGENT_PATH = path.join(__dirname, '../../target/debug/redoor-agent')
const WS_URL = `ws://127.0.0.1:${SERVER_PORT}/ws`
const AGENT_NAME = 'test-agent'

class ProcessManager {
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

    proc.unref()
    this.processes.set(pid, proc)
    return pid
  }

  kill(pid: number): void {
    process.kill(pid, 'SIGKILL')
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
}

async function waitForPort(port: number, maxRetries = 50): Promise<void> {
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

async function waitForLogMessage(
  process: ChildProcess,
  pattern: RegExp,
  timeoutMs: number = 10000
): Promise<void> {
  const stream = process.stdout || process.stderr
  if (!stream) {
    throw new Error('No stdout/stderr stream available')
  }

  const onData = (chunk: Buffer) => {
    const line = chunk.toString()
    if (pattern.test(line)) {
      clearTimeout(timeout)
      stream.off('data', onData)
      resolve()
    }
  }

  let resolve: () => void
  let reject: (error: Error) => void

  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })

  stream.on('data', onData)

  const timeout = setTimeout(() => {
    stream.off('data', onData)
    reject(new Error(`Timeout waiting for log pattern: ${pattern}`))
  }, timeoutMs)

  return promise
}

class ApiClient {
  private baseUrl: string

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl
  }

  async listAgents(): Promise<AgentListResponse> {
    const url = `${this.baseUrl}/api/v1/agents`
    const response = await fetch(url)

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Failed to list agents: ${response.status} ${response.statusText} - ${text}`)
    }

    return response.json()
  }

  async ls(agent: string, path: string): Promise<LsResponse> {
    const url = `${this.baseUrl}/api/v1/agents/${encodeURIComponent(agent)}/ls/${encodeURIComponent(path)}`
    const response = await fetch(url)

    if (!response.ok) {
      const text = await response.text()
      if (text) {
        const error: ErrorResponse = JSON.parse(text)
        throw new Error(error.error)
      }
      throw new Error(`Request failed: ${response.status} ${response.statusText}`)
    }

    return response.json()
  }
}

const processManager = new ProcessManager()
const apiClient = new ApiClient(`http://127.0.0.1:${SERVER_PORT}`)

beforeAll(async () => {
  const projectRoot = path.join(__dirname, '../..')

  const serverPid = processManager.spawn(SERVER_PATH, [], projectRoot)

  await waitForPort(SERVER_PORT)

  processManager.spawn(AGENT_PATH, [WS_URL, AGENT_NAME], projectRoot)

  const serverProcess = processManager.getProcess(serverPid)
  if (!serverProcess) {
    throw new Error('Server process not found')
  }

  await waitForLogMessage(serverProcess, /Agent registered: agent_id=/, 10000)
}, 10000)

afterAll(() => {
  processManager.killAll()
})

describe('Agents API', () => {
  it('should list directory contents on connected agent', async () => {
    const agents = await apiClient.listAgents()
    expect(agents.agents.length).toBeGreaterThan(0)

    const testAgent = agents.agents.find((a) => a.name === AGENT_NAME)
    expect(testAgent).toBeDefined()

    const result = await apiClient.ls(testAgent!.id, 'src')
    expect(result.files).toBeInstanceOf(Array)
    expect(result.files.length).toBeGreaterThan(0)
  })
})
