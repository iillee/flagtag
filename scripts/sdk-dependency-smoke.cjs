const assert = require('node:assert/strict')
const http = require('node:http')
const cookie = require('cookie')
const esbuild = require('esbuild')
const protobuf = require('protobufjs/minimal')
const deepmerge = require('ts-deepmerge')
const undici = require('undici')
const uuid = require('uuid')
const inspector = require('@dcl/inspector/dist/tooling-entrypoint.js')
const { fetchEntityByPointer } = require('@dcl/sdk-commands/dist/logic/catalyst-requests.js')

async function main() {
  const bundle = esbuild.buildSync({
    stdin: { contents: 'export const value = 1', loader: 'js' },
    bundle: true,
    format: 'cjs',
    write: false,
  })
  assert.match(bundle.outputFiles[0].text, /value/)

  const encoded = protobuf.Writer.create().uint32(42).string('ok').finish()
  const reader = protobuf.Reader.create(encoded)
  assert.equal(reader.uint32(), 42)
  assert.equal(reader.string(), 'ok')
  assert.deepEqual(
    deepmerge.merge.withOptions({ mergeArrays: false }, { list: [1], nested: { a: 1 } }, { list: [2], nested: { b: 2 } }),
    { list: [2], nested: { a: 1, b: 2 } }
  )

  const generatedUuid = uuid.v4()
  assert.equal(uuid.validate(generatedUuid), true)
  assert.equal(cookie.parse(cookie.serialize('session', 'ok')).session, 'ok')

  const storage = inspector.createInMemoryStorage()
  await storage.writeFile('scene/test.json', Buffer.from('{"ok":true}'))
  assert.equal((await storage.readFile('scene/test.json')).toString(), '{"ok":true}')

  const server = http.createServer((request, response) => {
    if (request.url !== '/content/entities/active' || request.method !== 'POST') {
      response.writeHead(404).end()
      return
    }
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const { pointers } = JSON.parse(body)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify([{ id: 'entity-id', timestamp: 1, pointers }]))
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const dispatcher = new undici.Agent()
  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const result = await fetchEntityByPointer(
      { fetch: { fetch: (url, options) => undici.fetch(url, { ...options, dispatcher }) } },
      `http://127.0.0.1:${address.port}`,
      ['urn:decentraland:entity:test']
    )
    assert.equal(result.deployments[0].id, 'entity-id')
  } finally {
    await dispatcher.close()
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }

  console.log('SDK build, inspector, and network compatibility smoke test passed')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
