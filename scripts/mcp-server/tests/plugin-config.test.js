import test from 'node:test'
import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
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
  assert.equal(mcpConfig['super-editor'].command, 'powershell.exe')
  assert.deepEqual(mcpConfig['super-editor'].args.slice(-2), [
    '-File',
    './scripts/mcp-server/start.ps1'
  ])
  await access(`${PLUGIN_ROOT}/scripts/mcp-server/start.ps1`)
})
