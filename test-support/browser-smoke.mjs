import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { fixtureFile } from './documents.js'

const temporary = await mkdtemp(join(tmpdir(), 'zhiku-browser-'))
const html = await readFile('dist/index.html')
const server = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(html)
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
server.unref()
const port = server.address().port
const browser = await chromium.launch({
  ...(process.env.CHROME_BIN
    ? { executablePath: process.env.CHROME_BIN }
    : { channel: 'chrome' }),
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--no-proxy-server',
    '--host-resolver-rules=MAP zhiku.test 127.0.0.1',
  ],
})
const errors = [],
  requests = []
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  acceptDownloads: true,
})
const watch = (page) => {
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('request', (request) => requests.push(request.url()))
}
const page = await context.newPage()
watch(page)
try {
  for (const format of ['docx', 'pptx', 'xlsx', 'html', 'pdf', 'csv']) {
    const file = await fixtureFile(format)
    await writeFile(
      join(temporary, file.name),
      Buffer.from(await file.arrayBuffer()),
    )
  }
  const malicious =
    '<!doctype html><h1>安全测试</h1><script>window.__injected=true</script><p onclick="window.__injected=true">有效正文</p><img src="https://tracker.invalid/pixel" onerror="window.__injected=true"><iframe src="https://tracker.invalid/frame"></iframe>'
  await writeFile(join(temporary, '安全.html'), malicious)
  await mkdir(join(temporary, '目录', '分类'), { recursive: true })
  await writeFile(
    join(temporary, '目录', '分类', '目录资料.html'),
    '<h1>目录测试</h1><p>目录资料正文</p>',
  )
  await writeFile(join(temporary, '目录', '分类', '笔记.md'), '# 目录笔记')

  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'networkidle' })
  await page
    .locator('#source-input')
    .setInputFiles(
      ['docx', 'pptx', 'xlsx', 'html', 'pdf', 'csv'].map((ext) =>
        join(temporary, `资料.${ext}`),
      ),
    )
  await page.waitForFunction(
    () =>
      document
        .querySelector('.source-body')
        ?.textContent.includes('资料测试正文'),
    {},
    { timeout: 90000 },
  )
  for (const ext of ['docx', 'pptx', 'xlsx', 'html', 'pdf', 'csv']) {
    await page.locator(`.tree-open[title="资料.${ext}"]`).click()
    await page.waitForFunction(
      () =>
        document
          .querySelector('.source-workspace .note-status')
          ?.textContent.includes('可供知识助手读取'),
      {},
      { timeout: 90000 },
    )
    if (ext === 'pdf') {
      await page
        .locator('[data-action="set-source-view"][data-view="text"]')
        .click()
    }
    const text = await page.locator('.source-page').innerText()
    assert.ok(
      text.includes(ext === 'pdf' ? 'Knowledge PDF text' : '资料测试正文'),
    )
    assert.equal(
      await page.locator('#markdown-editor,[data-mode="edit"]').count(),
      0,
    )
  }
  console.log('六类资料预览通过')

  await page
    .locator('#source-input')
    .setInputFiles(join(temporary, '安全.html'))
  await page.waitForFunction(
    () =>
      document.querySelector('.source-body')?.textContent.includes('有效正文'),
    {},
    { timeout: 90000 },
  )
  assert.equal(await page.evaluate(() => window.__injected), undefined)
  assert.equal(
    requests.filter((url) => url.includes('tracker.invalid')).length,
    0,
  )
  assert.equal(
    await page
      .locator('.source-body img,.source-body iframe,.source-body script')
      .count(),
    0,
  )
  const downloadPromise = page.waitForEvent('download')
  await page.locator('[data-action="download-source"]').click()
  const downloaded = await downloadPromise
  assert.equal(downloaded.suggestedFilename(), '安全.html')
  assert.equal(await readFile(await downloaded.path(), 'utf8'), malicious)
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForFunction(() =>
    document.querySelector('.source-body')?.textContent.includes('有效正文'),
  )
  await page.evaluate(() =>
    document.documentElement.setAttribute('data-theme', 'dark'),
  )
  assert.equal(
    await page
      .locator('.source-page')
      .evaluate((node) => getComputedStyle(node).backgroundColor),
    'rgb(255, 255, 255)',
  )
  assert.equal(
    await page
      .locator('.source-body')
      .evaluate((node) => getComputedStyle(node).color),
    'rgb(31, 31, 35)',
  )
  await page.setViewportSize({ width: 390, height: 844 })
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  )
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.evaluate(() =>
    document.documentElement.setAttribute('data-theme', 'light'),
  )
  console.log('安全预览、原件下载与刷新恢复通过')

  // 使用本地模拟模型测试真实 Agent 工具循环，不调用任何外部模型。
  let round = 0,
    sourceId,
    parentId
  const requestFailures = []
  await page.route('**/mock/v1/chat/completions', async (route) => {
    const request = route.request().postDataJSON()
    const last = request.messages.at(-1)
    const result = last.role === 'tool' ? JSON.parse(last.content) : null
    let tool, args
    try {
      if (round === 0) {
        tool = 'list_files'
        args = {}
      }
      if (round === 1) {
        const source = result.find((item) => item.name === '资料.docx')
        assert.equal(source.readonly, true)
        sourceId = source.id
        parentId = source.parentId
        tool = 'search_files'
        args = { query: '资料测试正文' }
      }
      if (round === 2) {
        assert.ok(result.matches.some((item) => item.id === sourceId))
        tool = 'read_file'
        args = { id: sourceId, offset: 0, limit: 1 }
      }
      if (round === 3) {
        assert.match(result.chunks[0].text, /资料测试正文/)
        assert.equal(result.readonly, true)
        tool = 'update_file'
        args = { id: sourceId, content: '不得覆盖原件' }
      }
      if (round === 4) {
        assert.match(result.error, /只读/)
        tool = 'rename_item'
        args = { id: sourceId, name: '不得改名.docx' }
      }
      if (round === 5) {
        assert.match(result.error, /只读/)
        tool = 'move_item'
        args = { id: sourceId, parentId: null }
      }
      if (round === 6) {
        assert.equal(result.name, '资料.docx')
        tool = 'delete_item'
        args = { id: parentId }
      }
      if (round === 7) assert.match(result.error, /只读/)
    } catch (error) {
      requestFailures.push(error.message)
    }
    round++
    const message = tool
      ? {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: `call_${round}`,
              type: 'function',
              function: { name: tool, arguments: JSON.stringify(args) },
            },
          ],
        }
      : { role: 'assistant', content: '资料读取和只读保护验证完成' }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        choices: [{ message, finish_reason: tool ? 'tool_calls' : 'stop' }],
      }),
    })
  })
  await page.locator('[data-action="settings"]').click()
  await page
    .locator('input[name="endpoint"]')
    .fill(`http://127.0.0.1:${port}/mock/v1/chat/completions`)
  await page.locator('input[name="model"]').fill('测试模型')
  await page.locator('#dialog-form button[type="submit"]').click()
  await page.locator('[data-action="toggle-ai"]').click()
  await page.locator('#ai-input').fill('读取资料并验证保护')
  await page.locator('#ai-form button[type="submit"]').click()
  await page.waitForFunction(
    () =>
      document
        .querySelector('#ai-messages')
        ?.textContent.includes('资料读取和只读保护验证完成'),
    {},
    { timeout: 90000 },
  )
  assert.deepEqual(requestFailures, [])
  assert.equal(round, 8)
  assert.equal(await page.locator('.tree-open[title="资料.docx"]').count(), 1)
  console.log('Agent 检索、读取和写入拦截通过')

  // ZIP 往返必须恢复原始二进制，而不是将提取文本写成 Office 文件。
  await page.locator('[data-action="vault-menu"]').click()
  const archivePromise = page.waitForEvent('download')
  await page.locator('[data-action="export"]').click()
  const archive = await archivePromise
  const archivePath = join(temporary, '备份.zip')
  await archive.saveAs(archivePath)
  await page.locator('#import-input').setInputFiles(archivePath)
  await page.waitForFunction(() =>
    document.querySelector('.vault-switch')?.textContent.includes('副本'),
  )
  await page.locator('.tree-open[title="资料.docx"]').click()
  await page.waitForFunction(
    () =>
      document
        .querySelector('.source-body')
        ?.textContent.includes('资料测试正文'),
    {},
    { timeout: 90000 },
  )
  const restoredPromise = page.waitForEvent('download')
  await page.locator('[data-action="download-source"]').click()
  const restored = await restoredPromise
  assert.deepEqual(
    await readFile(await restored.path()),
    await readFile(join(temporary, '资料.docx')),
  )
  console.log('浏览器备份往返通过')

  const insecure = await context.newPage()
  watch(insecure)
  await insecure.goto(`http://zhiku.test:${port}`, { waitUntil: 'networkidle' })
  assert.equal(await insecure.evaluate(() => isSecureContext), false)
  await insecure.locator('[data-action="vault-menu"]').click()
  const chooser = insecure.waitForEvent('filechooser')
  await insecure.locator('[data-action="open-local-vault"]').click()
  await (await chooser).setFiles(join(temporary, '目录'))
  await insecure.waitForFunction(() =>
    document.querySelector('#local-notice')?.textContent.includes('文件夹快照'),
  )
  await insecure.locator('.tree-open[title="目录资料.html"]').click()
  await insecure.waitForFunction(
    () =>
      document
        .querySelector('.source-body')
        ?.textContent.includes('目录资料正文'),
    {},
    { timeout: 90000 },
  )
  assert.equal(
    await insecure.locator('[data-action="sync-local-vault"]').count(),
    0,
  )
  console.log('非安全上下文目录选择通过')

  const offlineContext = await browser.newContext({ offline: true })
  const offline = await offlineContext.newPage()
  watch(offline)
  await offline.goto(pathToFileURL(resolve('dist/index.html')).href)
  await offline
    .locator('#source-input')
    .setInputFiles(join(temporary, '资料.pdf'))
  await offline
    .locator('[data-action="set-source-view"][data-view="text"]')
    .click()
  await offline.waitForFunction(
    () =>
      document
        .querySelector('.source-body')
        ?.textContent.includes('Knowledge PDF text'),
    {},
    { timeout: 90000 },
  )
  assert.deepEqual(errors, [])
  console.log('单文件离线 PDF 解析通过')
} finally {
  await browser.close()
  await new Promise((done) => server.close(done))
  await rm(temporary, { recursive: true, force: true })
}
