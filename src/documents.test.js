import assert from 'node:assert/strict'
import test from 'node:test'
import JSZip from 'jszip'
import { fixtureFile, pdfBytes } from '../test-support/documents.js'
import {
  sourceFields,
  ensureSourceParsed,
  isDocumentName,
  isSource,
  readSource,
  assertMutableItem,
  sourceFingerprint,
} from './documents.js'
import {
  parseSourceBytes,
  splitSourceText,
  validateDocumentArchive,
} from './document-parser.js'
import {
  importSourceFile,
  createItem,
  exportVault,
  importVault,
  createDirectorySnapshot,
  renameItem,
  moveItem,
  deleteItem,
  writeItemToDisk,
} from './storage.js'
import { readKnowledgeFile, searchKnowledgeFiles } from './knowledge-tools.js'

const vault = () => ({
  id: 'vault',
  name: '测试知识库',
  items: [],
  storageType: 'browser',
})

for (const format of ['docx', 'pptx', 'xlsx', 'html', 'csv', 'pdf']) {
  test(`解析 ${format} 原件并提供 Agent 分段读取`, async () => {
    const book = vault(),
      original = await fixtureFile(format)
    const item = await importSourceFile(book, original)
    const raw = new Uint8Array(await original.arrayBuffer())
    assert.equal(item.name, original.name)
    assert.equal(isSource(item), true)
    assert.equal(item.source.status, 'pending')
    const result = await readKnowledgeFile(book, { id: item.id, limit: 1 })
    assert.equal(item.source.status, 'ready', item.source.error)
    assert.ok(result.chunks.length)
    assert.match(
      item.content,
      format === 'pdf' ? /Knowledge PDF text/ : /资料测试正文/,
    )
    assert.deepEqual(new Uint8Array(await item.source.blob.arrayBuffer()), raw)
    assert.equal(result.readonly, true)
    assert.deepEqual(result.chunks[0].pages, format === 'pdf' ? [1] : [])
    assert.doesNotMatch(item.content, /私密备注/)
    const cache = item.source.chunks
    await ensureSourceParsed(item)
    assert.equal(item.source.chunks, cache)
  })
}

test('长中文资料按字符分段，不丢失正文', () => {
  const text = '长篇资料'.repeat(6000)
  const chunks = splitSourceText(text)
  assert.ok(chunks.length > 4)
  assert.equal(chunks.map((chunk) => chunk.text).join(''), text)
  assert.ok(chunks.every((chunk) => chunk.text.length <= 2400))
  const item = { source: { chunks, status: 'ready' } }
  assert.equal(readSource(item).nextOffset, 4)
  assert.equal(readSource(item, { offset: chunks.length - 1 }).nextOffset, null)
  assert.throws(() => readSource(item, { offset: -1 }), /范围/)
  assert.throws(() => readSource(item, { limit: 99 }), /范围/)
})

test('Agent 搜索解析待处理资料并返回可定位分段', async () => {
  const book = vault()
  createItem(book, 'file', '普通笔记', null, '普通内容')
  const item = await importSourceFile(book, await fixtureFile('docx'))
  const bad = await importSourceFile(book, new File(['坏文档'], '损坏.pdf'))
  const result = await searchKnowledgeFiles(book, '测试正文')
  assert.equal(result.matches[0].id, item.id)
  assert.equal(result.matches[0].chunkIndex, 0)
  assert.equal(result.unreadableSources[0].id, bad.id)
  assert.equal(bad.source.status, 'error')
})

test('坏文档保留原件，解析错误不影响其他资料', async () => {
  const item = {
    type: 'file',
    ...(await sourceFields(new File(['bad zip'], '损坏.docx'))),
  }
  await ensureSourceParsed(item)
  assert.equal(item.source.status, 'error')
  assert.equal(await item.source.blob.text(), 'bad zip')
  assert.equal(item.content, '')
  assert.match(readSource(item).error, /损坏/)
})

test('无文字 PDF 明确提示 OCR，不伪造正文', async () => {
  const result = await parseSourceBytes(pdfBytes(true), 'pdf')
  assert.equal(result.text.trim(), '')
  assert.equal(result.chunks.length, 0)
  assert.ok(result.warnings.some((warning) => warning.includes('OCR')))
})

test('只读保护同时覆盖资料和包含资料的父文件夹', async () => {
  const book = vault()
  const folder = createItem(book, 'folder', '分类')
  const item = await importSourceFile(
    book,
    await fixtureFile('html'),
    folder.id,
  )
  for (const id of [item.id, folder.id]) {
    assert.throws(() => assertMutableItem(book, id), /只读/)
    assert.throws(() => renameItem(book, id, '新名称'), /只读/)
  }
  assert.throws(() => moveItem(book, folder.id, null), /只读/)
  moveItem(book, item.id, null)
  assert.equal(book.items.find((entry) => entry.id === item.id).parentId, null)
  moveItem(book, item.id, folder.id)
  assert.equal(book.items.find((entry) => entry.id === item.id).parentId, folder.id)
  assert.throws(() => deleteItem(book, folder.id), /只读/)
  await assert.rejects(writeItemToDisk(book, item), /只读/)
  assert.equal(book.items.length, 2)
  deleteItem(book, item.id)
  assert.equal(book.items.length, 1)
  assert.equal(book.items[0].id, folder.id)
})

test('备份往返保留二进制原件和资料身份，不信任导入的解析缓存', async () => {
  const book = vault()
  const folder = createItem(book, 'folder', '分类')
  const source = await importSourceFile(
    book,
    await fixtureFile('docx'),
    folder.id,
  )
  await ensureSourceParsed(source)
  const zip = await exportVault(book)
  const restored = await importVault(new File([zip], '备份.zip'))
  const item = restored.items.find(isSource)
  assert.equal(item.name, source.name)
  assert.equal(item.source.status, 'pending')
  assert.equal(item.source.fingerprint, source.source.fingerprint)
  assert.deepEqual(
    await item.source.blob.arrayBuffer(),
    await source.source.blob.arrayBuffer(),
  )
  await ensureSourceParsed(item)
  assert.match(item.content, /资料测试正文/)
})

test('缺少原件的备份必须报错，不能导入空资料', async () => {
  const book = vault()
  await importSourceFile(book, await fixtureFile('docx'))
  const zip = await JSZip.loadAsync(
    await (await exportVault(book)).arrayBuffer(),
  )
  zip.remove('资料.docx')
  await assert.rejects(
    importVault(
      new File([await zip.generateAsync({ type: 'uint8array' })], '缺失.zip'),
    ),
    /缺少资料原件/,
  )
})

test('普通 ZIP 可导入笔记和资料', async () => {
  const zip = new JSZip()
  zip.file('说明.txt', '文本笔记')
  zip.file('资料/网页.html', '<h1>网页正文</h1>')
  const book = await importVault(
    new File([await zip.generateAsync({ type: 'uint8array' })], '普通.zip'),
  )
  assert.equal(book.items.find(isSource).name, '网页.html')
  assert.equal(
    book.items.find((item) => item.name === '说明.txt').content,
    '文本笔记',
  )
})

test('目录快照保留层级，不获得本地写入能力', async () => {
  const note = new File(['# 笔记'], '笔记.md')
  const source = await fixtureFile('docx')
  Object.defineProperty(note, 'webkitRelativePath', {
    value: '根目录/分类/笔记.md',
  })
  Object.defineProperty(source, 'webkitRelativePath', {
    value: '根目录/分类/资料.docx',
  })
  const book = await createDirectorySnapshot([note, source])
  assert.equal(book.storageType, 'browser')
  assert.equal(book.directorySnapshot, true)
  assert.equal(book.name, '根目录')
  assert.equal(
    book.items.find(isSource).parentId,
    book.items.find((item) => item.name === '分类').id,
  )
  assert.equal(
    book.items.some((item) => item.diskContent !== undefined),
    false,
  )
})

test('拒绝旧版 Office 和伪文本，非安全上下文仍可计算缓存标识', async (t) => {
  assert.equal(isDocumentName('旧文档.doc'), false)
  await assert.rejects(
    sourceFields(new File(['bytes'], '旧文档.ppt')),
    /不支持/,
  )
  await assert.rejects(
    parseSourceBytes(new Uint8Array([0, 1, 0]), 'csv'),
    /不是可读取/,
  )
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: {},
  })
  t.after(() => Object.defineProperty(globalThis, 'crypto', original))
  assert.notEqual(
    await sourceFingerprint(new Blob(['first'])),
    await sourceFingerprint(new Blob(['other'])),
  )
})

test('解析前拒绝虚报超大解压尺寸的 Office 文件', async () => {
  const file = await fixtureFile('docx')
  const bytes = new Uint8Array(await file.arrayBuffer())
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < bytes.length - 46; i++)
    if (view.getUint32(i, true) === 0x02014b50) {
      view.setUint32(i + 24, 200 * 1024 * 1024, true)
      break
    }
  assert.throws(() => validateDocumentArchive(bytes), /解压后过大/)
})

test('分段恰逢换行边界时仍保持字符上限', () => {
  const text = '文'.repeat(2400) + '\n' + '字'.repeat(2600)
  const chunks = splitSourceText(text)
  assert.ok(chunks.every((chunk) => chunk.text.length <= 2400))
  assert.equal(chunks.map((chunk) => chunk.text).join(''), text)
})

test('原件不能占用备份清单路径', async () => {
  await assert.rejects(
    importSourceFile(vault(), new File(['{}'], '.zhiku.json')),
    /保留名称/,
  )
})

test('支持导入图片资料并在知识库中删除', async () => {
  const book = vault()
  const image = new File([new Uint8Array([137, 80, 78, 71])], '插图.png', {
    type: 'image/png',
  })
  const item = await importSourceFile(book, image, null)
  assert.equal(item.kind, 'source')
  assert.equal(item.source.format, 'png')
  await ensureSourceParsed(item)
  assert.equal(item.content, '')
  assert.equal(book.items.length, 1)
  deleteItem(book, item.id)
  assert.equal(book.items.length, 0)
})

test('支持直接移动其他文档资料到不同文件夹', async () => {
  const book = vault()
  const folderA = createItem(book, 'folder', '目录甲')
  const folderB = createItem(book, 'folder', '目录乙')
  const pdf = await importSourceFile(
    book,
    new File([new Uint8Array([37, 80, 68, 70])], '文档.pdf'),
    folderA.id,
  )
  assert.equal(pdf.parentId, folderA.id)
  moveItem(book, pdf.id, folderB.id)
  assert.equal(pdf.parentId, folderB.id)
  moveItem(book, pdf.id, null)
  assert.equal(pdf.parentId, null)
})

test('在目标文件夹存在同名文件时移动资料会报错', async () => {
  const book = vault()
  const folder = createItem(book, 'folder', '目标目录')
  await importSourceFile(
    book,
    new File([new Uint8Array([37, 80, 68, 70])], '报告.pdf'),
    folder.id,
  )
  const source = await importSourceFile(
    book,
    new File([new Uint8Array([37, 80, 68, 70])], '报告.pdf'),
    null,
  )
  assert.throws(() => moveItem(book, source.id, folder.id), /同名/)
})
