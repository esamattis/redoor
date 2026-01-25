import { spawn, ChildProcess } from 'node:child_process'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { ApiClient, Agent } from '../src/api-client'
import path from 'node:path'
import { writeFileSync, unlinkSync } from 'node:fs'
import type { ErrorResponse } from '../../bindings/ErrorResponse'

const SERVER_PORT = 3000
const SERVER_PATH = path.join(__dirname, '../../target/debug/redoor')
const AGENT_PATH = path.join(__dirname, '../../target/debug/redoor-agent')
const WS_URL = `ws://127.0.0.1:${SERVER_PORT}/ws`
const AGENT_NAME = 'raw-test-agent'

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

describe('Raw Download API', () => {
  const processManager = new ProcessManager()
  const apiClient = new ApiClient(`http://127.0.0.1:${SERVER_PORT}`)
  let serverPid: number
  let testAgent: Agent

  beforeAll(async () => {
    const projectRoot = path.join(__dirname, '../..')
    serverPid = processManager.spawn(SERVER_PATH, [], projectRoot)
    await waitForPort(SERVER_PORT)
    processManager.spawn(AGENT_PATH, [WS_URL, AGENT_NAME], projectRoot)

    const serverProcess = processManager.getProcess(serverPid)
    if (!serverProcess) {
      throw new Error('Server process not found')
    }
    await waitForLogMessage(serverProcess, /Agent registered: agent_id=/, 10000)

    const agents = await apiClient.listAgents()
    testAgent = agents.find((a) => a.name === AGENT_NAME)!
    expect(testAgent).toBeDefined()
  }, 30000)

  afterAll(() => {
    processManager.killAll()
  })

  it('should download small file via raw endpoint', async () => {
    const testContent = 'Hello, World!\nThis is a test file.'
    const testFilePath = path.join(__dirname, '../../test-file.txt')

    writeFileSync(testFilePath, testContent, 'utf-8')

    const result = await testAgent.raw(testFilePath)
    const downloadedContent = Buffer.from(result).toString('utf-8')
    expect(downloadedContent).toBe(testContent)

    unlinkSync(testFilePath)
  })

  it('should download large file via raw endpoint', async () => {
    const largeContent = 'x'.repeat(100 * 1024)
    const testFilePath = path.join(__dirname, '../../large-test-file.txt')

    writeFileSync(testFilePath, largeContent, 'utf-8')

    const result = await testAgent.raw(testFilePath)
    const downloadedContent = Buffer.from(result).toString('utf-8')
    expect(downloadedContent.length).toBe(largeContent.length)
    expect(downloadedContent).toBe(largeContent)

    unlinkSync(testFilePath)
  })

  it('should handle binary file download', async () => {
    const binaryContent = Buffer.from([0, 1, 2, 3, 255, 254, 253])
    const testFilePath = path.join(__dirname, '../../binary-test-file.bin')

    writeFileSync(testFilePath, binaryContent)

    const result = await testAgent.raw(testFilePath)
    const downloadedContent = Buffer.from(result)
    expect(Buffer.compare(downloadedContent, binaryContent)).toBe(0)

    unlinkSync(testFilePath)
  })

  it('should return error for non-existent file', async () => {
    const nonExistentPath = '/tmp/non-existent-file-12345.txt'
    await expect(testAgent.raw(nonExistentPath)).rejects.toThrow()
  })

  it('should set correct Content-Disposition header', async () => {
    const testContent = 'test content'
    const testFilePath = path.join(__dirname, '../../test-disposition.txt')

    writeFileSync(testFilePath, testContent)

    const url = `${apiClient.baseUrl}/api/v1/agents/${encodeURIComponent(testAgent.id)}/raw/${encodeURIComponent(testFilePath)}`
    const response = await fetch(url)
    expect(response.headers.get('Content-Disposition')).toMatch(/attachment/)
    expect(response.headers.get('Content-Disposition')).toMatch(/test-disposition\.txt/)

    unlinkSync(testFilePath)
  })
})
