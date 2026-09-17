import assert from 'node:assert/strict'
import test from 'node:test'
import { renderMarkdown, listNoteLinks, buildLinkGraph } from './markdown.js'

test('renders standard callouts with proper class and icon', () => {
  const md = '> [!NOTE]\n> 这是一条说明'
  const html = renderMarkdown(md)
  assert.match(html, /class="callout callout-note"/)
  assert.match(html, /data-callout="note"/)
  assert.match(html, /<span class="callout-title-text">说明<\/span>/)
  assert.match(html, /<p>这是一条说明<\/p>/)
})

test('renders callout with custom title', () => {
  const md = '> [!WARNING] 注意安全！\n> 操作需谨慎'
  const html = renderMarkdown(md)
  assert.match(html, /class="callout callout-warning"/)
  assert.match(html, /<span class="callout-title-text">注意安全！<\/span>/)
  assert.match(html, /<p>操作需谨慎<\/p>/)
})

test('renders collapsible callouts using <details>', () => {
  const closedMd = '> [!TIP]- 可折叠提示\n> 展开后可见'
  const closedHtml = renderMarkdown(closedMd)
  assert.match(closedHtml, /<details class="callout callout-tip"/)
  assert.match(closedHtml, /<summary class="callout-title">/)
  assert.ok(!closedHtml.includes('open'))

  const openMd = '> [!TIP]+ 展开的提示\n> 默认展开'
  const openHtml = renderMarkdown(openMd)
  assert.match(openHtml, /<details class="callout callout-tip" open/)
})

test('renders code block with header, language badge and copy button', () => {
  const code = '```python\nprint("hello")\n```'
  const html = renderMarkdown(code)
  assert.match(html, /class="code-block-wrapper"/)
  assert.match(html, /<span class="code-lang">python<\/span>/)
  assert.match(html, /data-code-copy="true"/)
  assert.match(html, /hljs language-python/)
})

test('renders wikilinks correctly', () => {
  const md = '参考 [[人工智能]] 以及 [[深度学习|DL]]'
  const html = renderMarkdown(md)
  assert.match(html, /data-note-link="人工智能"/)
  assert.match(html, /data-note-link="深度学习"/)
  assert.match(html, />DL<\/a>/)
})

test('extracts links and builds link graph', () => {
  const items = [
    { id: '1', type: 'file', name: 'A.md', content: 'Link to [[B]]' },
    { id: '2', type: 'file', name: 'B.md', content: 'Link to [[A]]' },
  ]
  const links = listNoteLinks(items[0].content)
  assert.equal(links.length, 1)
  assert.equal(links[0].target, 'B')

  const graph = buildLinkGraph(items)
  assert.equal(graph.nodes.length, 2)
  assert.equal(graph.edges.length, 2)
})
