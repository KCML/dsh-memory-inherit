import test from 'node:test'
import assert from 'node:assert/strict'
import {
  activeChain,
  extractMessage,
  renderCorpus,
  renderHistory,
  toTurns,
  conversationOf,
} from '../lib/convert.js'

const fragmentsFormat = [
  {
    message_id: 'm1',
    parent_id: null,
    fragments: [{ type: 'REQUEST', content: '我叫阿远，住在杭州。' }],
  },
  {
    message_id: 'm2',
    parent_id: 'm1',
    fragments: [
      { type: 'THINK', content: '先记下这个人的自我介绍。' },
      { type: 'RESPONSE', content: '记住了，阿远。' },
      { type: 'TOOL_SEARCH', content: 'ignored' },
    ],
  },
  {
    message_id: 'm3',
    parent_id: 'm2',
    fragments: [{ type: 'REQUEST', content: '我讨厌香菜。' }],
  },
  {
    message_id: 'm4',
    parent_id: 'm3',
    fragments: [{ type: 'RESPONSE', content: [{ type: 'text', text: '记下了：不吃香菜。' }] }],
  },
]

const legacyFormat = [
  { message_id: 'a1', role: 'USER', content: '老格式的提问' },
  { message_id: 'a2', role: 'ASSISTANT', content: '老格式的回答' },
]

test('fragments 格式：抽出 role / 正文 / 思考，丢掉工具碎片', () => {
  const extracted = extractMessage(fragmentsFormat[1])
  assert.equal(extracted.role, 'assistant')
  assert.equal(extracted.text, '记住了，阿远。')
  assert.equal(extracted.thinking, '先记下这个人的自我介绍。')
})

test('老格式（只有 content）也认得出来', () => {
  const turns = toTurns(legacyFormat)
  assert.deepEqual(
    turns.map((turn) => [turn.role, turn.text]),
    [
      ['user', '老格式的提问'],
      ['assistant', '老格式的回答'],
    ],
  )
})

test('沿 current_message_id 走分支，不带上另一条支线', () => {
  const messages = [
    ...fragmentsFormat,
    { message_id: 'x9', parent_id: 'm1', fragments: [{ type: 'REQUEST', content: '这条是被放弃的分支' }] },
  ]
  const chain = activeChain(messages, 'm4')
  assert.deepEqual(
    chain.map((message) => message.message_id),
    ['m1', 'm2', 'm3', 'm4'],
  )
})

test('分支缺失时退回数组顺序', () => {
  const chain = activeChain(fragmentsFormat, 'not-exist')
  assert.equal(chain.length, fragmentsFormat.length)
})

test('连续同角色会合并成一轮', () => {
  const turns = toTurns([
    { message_id: 'u1', fragments: [{ type: 'REQUEST', content: '第一句' }] },
    { message_id: 'u2', fragments: [{ type: 'REQUEST', content: '第二句' }] },
    { message_id: 'r1', fragments: [{ type: 'RESPONSE', content: '回答' }] },
  ])
  assert.equal(turns.length, 2)
  assert.equal(turns[0].text, '第一句\n\n第二句')
})

test('渲染成 persona-select 认识的历史对话格式', () => {
  const conversation = conversationOf({
    id: 's1',
    title: '自我介绍',
    updatedAt: 1760000000000,
    currentMessageId: 'm4',
    messages: fragmentsFormat,
  })
  const text = renderHistory([conversation])
  assert.match(text, /^<user_message>\n我叫阿远，住在杭州。\n<\/user_message>/)
  assert.match(text, /<assistant_message>\n记住了，阿远。\n<\/assistant_message>/)
  assert.ok(!text.includes('<thinking>'), '默认不带思考')
  assert.ok(!text.includes('ignored'), '工具碎片不该出现')
})

test('勾了思考才带 thinking', () => {
  const conversation = conversationOf(
    { id: 's1', title: 't', updatedAt: null, currentMessageId: 'm2', messages: fragmentsFormat },
    { includeThinking: true },
  )
  const text = renderHistory([conversation], { includeThinking: true })
  assert.match(text, /<thinking>\n先记下这个人的自我介绍。\n<\/thinking>/)
})

test('多段对话带标题，单段不带', () => {
  const one = conversationOf({ id: 's1', title: '只有一段', updatedAt: null, currentMessageId: 'm4', messages: fragmentsFormat })
  assert.ok(!renderHistory([one]).includes('【旧对话'))
  const two = conversationOf({ id: 's2', title: '第二段', updatedAt: 1760000000000, currentMessageId: 'm4', messages: fragmentsFormat })
  assert.ok(renderHistory([one, two]).includes('【旧对话：第二段 · 2025-10-09】'))
})

test('maxChars 按整块截断，不会切坏标签', () => {
  const one = conversationOf({ id: 's1', title: 'a', updatedAt: null, currentMessageId: 'm4', messages: fragmentsFormat })
  const text = renderHistory([one], { maxChars: 120 })
  assert.ok(text.length <= 200)
  assert.equal((text.match(/<user_message>/g) ?? []).length, (text.match(/<\/user_message>/g) ?? []).length)
  assert.ok(text.includes('没有导入'))
})

test('语料是给人读的 Markdown', () => {
  const one = conversationOf({ id: 's1', title: '自我介绍', updatedAt: 1760000000000, currentMessageId: 'm4', messages: fragmentsFormat })
  const corpus = renderCorpus([one])
  assert.match(corpus, /^## 自我介绍 · 2025-10-09/m)
  assert.match(corpus, /\*\*我\*\*：/)
  assert.match(corpus, /\*\*DeepSeek\*\*：/)
})
