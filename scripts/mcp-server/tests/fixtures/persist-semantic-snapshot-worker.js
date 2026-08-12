import { readFileSync } from 'node:fs'
import { persistSemanticSnapshot } from '../../semanticSnapshotFile.js'

const [, , payloadPath, outputDirectory] = process.argv
const payload = JSON.parse(readFileSync(payloadPath, 'utf8'))
const result = persistSemanticSnapshot(payload, { outputDirectory })
process.stdout.write(JSON.stringify(result))
