/**
 * 端到端冒烟：起一个真 HTTP 服务当宿主，用真 fetch 打插件自己的路由。
 * 不碰 ~/.dsh 的真实数据（DSH_HOME 指到临时目录）。
 *
 *   node test/e2e.mjs [tokenFile]
 *
 * 给了 token 文件就顺带验一次真账号（空账号也应该返回 200 + 0 条）。
 */

import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'dsh-memory-e2e-'))
process.env.DSH_HOME = home

const messages = [
  { message_id: 'm1', parent_id: null, fragments: [{ type: 'REQUEST', content: '我是阿远，杭州人，做前端的。' }] },
  {
    message_id: 'm2',
    parent_id: 'm1',
    fragments: [
      { type: 'THINK', content: '记住用户画像' },
      { type: 'RESPONSE', content: '好的阿远，记住了：杭州、前端。' },
    ],
  },
  { message_id: 'm3', parent_id: 'm2', fragments: [{ type: 'REQUEST', content: '以后回答别太长，我不喜欢废话。' }] },
  { message_id: 'm4', parent_id: 'm3', fragments: [{ type: 'RESPONSE', content: '明白，简短。' }] },
]

const root = join(home, 'memory-inherit')
await mkdir(join(root, 'raw'), { recursive: true })
await writeFile(
  join(root, 'index.json'),
  `${JSON.stringify({
    generatedAt: Date.now(),
    sessions: [{ id: 'test-session-1', title: '自我介绍', updatedAt: 1760000000000, turns: 4, chars: 60 }],
  })}\n`,
  'utf8',
)
await writeFile(
  join(root, 'raw', 'test-session-1.json'),
  `${JSON.stringify({ session: { title: '自我介绍', updated_at: 1760000000, current_message_id: 'm4' }, messages })}\n`,
  'utf8',
)

const { apply } = await import('../index.js')

const server = createServer()
let handler = null
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  webServer: {
    register({ handler: fn }) {
      handler = fn
      return () => {}
    },
  },
}
server.on('request', (req, res) => {
  if (handler === null) {
    res.statusCode = 503
    res.end('no handler')
    return
  }
  Promise.resolve(handler(req, res)).catch((error) => {
    res.statusCode = 500
    res.end(String(error?.stack ?? error))
  })
})
apply(ctx)
await new Promise((resolve) => setTimeout(resolve, 50))

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const results = []
function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail })
  console.log(`${condition ? '✔' : '✖'} ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

try {
  const state = await (await fetch(`${base}/memory-inherit/state`)).json()
  check('state 能读', state.ok === true)
  check('未配置 token', state.configured === false)
  check('索引里的会话被读出来', state.sessions.length === 1 && state.sessions[0].title === '自我介绍')

  const imported = await (
    await fetch(`${base}/memory-inherit/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '旧账号记忆', ids: ['test-session-1'], mode: 'full', maxChars: 60000 }),
    })
  ).json()
  check('import 成功', imported.ok === true, JSON.stringify(imported.persona ?? imported.message ?? ''))
  check('写进去的字数合理', (imported.persona?.chars ?? 0) > 40, String(imported.persona?.chars))

  const store = JSON.parse(await readFile(join(home, 'persona-select', 'personas.json'), 'utf8'))
  check('personas.json 里有一条', store.personas.length === 1)
  check('人设名字正确', store.personas[0].name === '旧账号记忆')
  check('历史文件字段对', /^p-[a-z0-9]+-[a-z0-9]+\.txt$/.test(store.personas[0].history.file))
  const historyText = await readFile(join(home, 'persona-select', 'history', store.personas[0].history.file), 'utf8')
  check('历史正文是 persona-select 的标签格式', historyText.startsWith('<user_message>\n'))
  check('历史正文里没有工具碎片', !historyText.includes('TOOL'))

  const second = await (
    await fetch(`${base}/memory-inherit/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '旧账号记忆', ids: ['test-session-1'], mode: 'user-only', maxChars: 60000 }),
    })
  ).json()
  check('同名再导入是更新而不是新增', second.persona?.created === false)
  const store2 = JSON.parse(await readFile(join(home, 'persona-select', 'personas.json'), 'utf8'))
  check('人设没有变成两条', store2.personas.length === 1)

  const preview = await (
    await fetch(`${base}/memory-inherit/preview?ids=test-session-1&mode=user-only`)
  ).json()
  check('preview 只留用户消息', preview.preview.includes('我是阿远') && !preview.preview.includes('DeepSeek'))

  const bad = await fetch(`${base}/memory-inherit/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '', ids: [], mode: 'full' }),
  })
  check('空选择被拒绝', bad.status === 400)

  if (process.argv[2] !== undefined) {
    const token = (await readFile(process.argv[2], 'utf8')).trim()
    const saved = await (
      await fetch(`${base}/memory-inherit/token`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      })
    ).json()
    check('真 token 验证通过', saved.ok === true && saved.account !== null, saved.account?.name ?? saved.warning ?? '')
    if (saved.account !== null && saved.account !== undefined) {
      const synced = await (
        await fetch(`${base}/memory-inherit/sync`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ maxSessions: 20 }),
        })
      ).json()
      check('空账号 sync 不报错', synced.ok === true, JSON.stringify(synced.summary ?? synced.message))
    }
  }
} finally {
  await new Promise((resolve) => server.close(resolve))
}

const failed = results.filter((entry) => !entry.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) {
  console.log('失败：', failed.map((entry) => entry.name).join('、'))
  process.exitCode = 1
}
