import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = fileURLToPath(new URL('../../..', import.meta.url))

test('插件使用官方支持的直接 MCP server map', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../../../.codex-plugin/plugin.json', import.meta.url), 'utf8')
  )
  const mcpConfig = JSON.parse(
    await readFile(new URL('../../../.mcp.json', import.meta.url), 'utf8')
  )

  assert.equal(manifest.mcpServers, './.mcp.json')
  assert.equal(mcpConfig.mcpServers, undefined)
  assert.equal(mcpConfig.mcp_servers, undefined)
  assert.equal(mcpConfig['super-editor'].enabled, true)
  assert.equal(mcpConfig['super-editor'].command, 'powershell.exe')
  assert.deepEqual(mcpConfig['super-editor'].args.slice(-2), [
    '-File',
    './scripts/mcp-server/start.ps1'
  ])
  await access(`${PLUGIN_ROOT}/scripts/mcp-server/start.ps1`)
})

test(
  'Windows 插件启动器完成 MCP 握手后可干净退出',
  { skip: process.platform !== 'win32', timeout: 15000 },
  async () => {
    const child = spawn(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        './scripts/mcp-server/start.ps1'
      ],
      { cwd: PLUGIN_ROOT, stdio: ['pipe', 'pipe', 'pipe'] }
    )
    let stderr = ''
    child.stderr.setEncoding('utf8')
    const responses = createInterface({ input: child.stdout, crlfDelay: Infinity })
    responses.on('line', (line) => {
      const response = JSON.parse(line)
      if (response.id === 1 && !child.stdin.destroyed) child.stdin.end()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'plugin-config-test', version: '1.0.0' }
        }
      }) + '\n'
    )
    const exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', resolve)
    })
    assert.equal(exitCode, 0)
    assert.doesNotMatch(stderr, /Assertion failed/)
  }
)
