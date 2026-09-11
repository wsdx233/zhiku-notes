import assert from 'node:assert/strict'
import test from 'node:test'
import { parseNativeCompletion, readNativeCompletion } from './llm-providers.js'

const settings = (provider) => ({ provider, model: 'test-model' })
const ignoreEvent = () => {}

test('multiple OpenAI citations replace one marker without damaging the following sentence', () => {
  const marker = 'citeturn0search0'
  const prefix = '已有公开证据。'
  const content = parseNativeCompletion(
    settings('openai'),
    {
      output: [
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: `${prefix}${marker}下一句。`,
              annotations: [
                {
                  url: 'https://example.com/a',
                  start_index: prefix.length,
                  end_index: prefix.length + marker.length,
                },
                {
                  url: 'https://example.com/b',
                  start_index: prefix.length,
                  end_index: prefix.length + marker.length,
                },
                { url: 'javascript:alert(1)' },
              ],
            },
          ],
        },
      ],
    },
    ignoreEvent,
  ).content
  assert.equal(
    content,
    `${prefix} [1](<https://example.com/a>) [2](<https://example.com/b>)下一句。`,
  )
})

test('Gemini grounding byte offsets preserve Chinese and emoji with multiple sources', () => {
  const prefix = '中文与🌍都必须保留。'
  const content = parseNativeCompletion(
    settings('gemini'),
    {
      candidates: [
        {
          content: { parts: [{ text: `${prefix}下一句。` }] },
          groundingMetadata: {
            groundingChunks: [
              { web: { uri: 'https://example.com/a' } },
              { web: { uri: 'https://example.com/b' } },
            ],
            groundingSupports: [
              {
                segment: { endIndex: new TextEncoder().encode(prefix).length },
                groundingChunkIndices: [0, 1],
              },
            ],
          },
        },
      ],
    },
    ignoreEvent,
  ).content
  assert.equal(
    content,
    `${prefix} [1](<https://example.com/a>) [2](<https://example.com/b>)下一句。`,
  )
})

test('a truncated native stream is rejected even after a complete tool-call item', async () => {
  async function* blocks() {
    yield `data: ${JSON.stringify({ type: 'response.output_item.done', item: { type: 'function_call', call_id: 'delete_1', name: 'delete_item', arguments: '{"id":"note"}' } })}\n\n`
  }
  await assert.rejects(
    readNativeCompletion(settings('openai'), blocks(), ignoreEvent),
  )
})

test('Claude search errors inside successful responses remain visible in the answer', () => {
  const message = parseNativeCompletion(
    settings('anthropic'),
    {
      content: [
        {
          type: 'web_search_tool_result',
          content: {
            type: 'web_search_tool_result_error',
            error_code: 'unavailable',
          },
        },
        { type: 'text', text: '这是未查证的旧信息。' },
      ],
      stop_reason: 'end_turn',
    },
    ignoreEvent,
  )
  assert.ok(message.content.includes('unavailable'))
  assert.ok(message.content.includes('这是未查证的旧信息。'))
})
