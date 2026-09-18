// 资料仅保存原件与提取缓存，不参与笔记写回。
export const DOCUMENT_VERSION = 'docmarrow-1.1.1-v1'
export const MAX_DOCUMENT_BYTES = 30 * 1024 * 1024
export const NOTE_PATTERN = /\.(md|markdown|txt)$/i
export const parsedFormats = new Set(['pdf', 'docx', 'pptx', 'xlsx', 'html', 'htm'])
export const textFormats = new Set([
  'csv',
  'tsv',
  'json',
  'jsonl',
  'xml',
  'yaml',
  'yml',
  'log',
  'ini',
  'toml',
  'rst',
])
export const imageFormats = new Set([
  'png',
  'jpg',
  'jpeg',
  'webp',
  'gif',
  'bmp',
  'svg',
])
export const DOCUMENT_ACCEPT = [
  ...parsedFormats,
  ...textFormats,
  ...imageFormats,
]
  .map((ext) => `.${ext}`)
  .join(',')
export const SOURCE_LIMITATIONS =
  '内容预览不保留原始排版。扫描页、图片和图表可能缺少内容，引用前请核对原件。'
export const isSource = (item) =>
  item?.type === 'file' && item.kind === 'source'
export const sourceFormat = (name) =>
  String(name).split('.').pop().toLowerCase()
export const isImageSource = (format) => imageFormats.has(format)
export const isDocumentName = (name) =>
  parsedFormats.has(sourceFormat(name)) ||
  textFormats.has(sourceFormat(name)) ||
  imageFormats.has(sourceFormat(name))
export const isSyncableDocument = (name) =>
  parsedFormats.has(sourceFormat(name)) || textFormats.has(sourceFormat(name))
export const isSupportedName = (name) =>
  NOTE_PATTERN.test(name) || isSyncableDocument(name)
export const isTextSource = (format) => textFormats.has(format)

export async function sourceFingerprint(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  if (globalThis.crypto?.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
  }
  // 非安全上下文没有 SubtleCrypto。双校验仅用于缓存失效，不作为安全校验。
  let a = 2166136261,
    b = 5381
  for (const byte of bytes) {
    a = Math.imul(a ^ byte, 16777619)
    b = Math.imul(b, 33) ^ byte
  }
  return `${bytes.length}-${a >>> 0}-${b >>> 0}`
}

export async function sourceFields(file) {
  if (!isDocumentName(file.name)) throw new Error('不支持此资料格式')
  if (file.size > MAX_DOCUMENT_BYTES) throw new Error('单份资料不能超过 30 MB')
  const blob = new Blob([await file.arrayBuffer()], {
    type: file.type || 'application/octet-stream',
  })
  return {
    kind: 'source',
    content: '',
    source: {
      format: sourceFormat(file.name),
      blob,
      size: file.size,
      lastModified: file.lastModified || 0,
      fingerprint: await sourceFingerprint(blob),
      status: 'pending',
      chunks: [],
      warnings: [],
    },
  }
}

export function containsSource(vault, id) {
  const ids = new Set([id])
  for (let changed = true; changed;) {
    changed = false
    for (const item of vault.items)
      if (ids.has(item.parentId) && !ids.has(item.id)) {
        ids.add(item.id)
        changed = true
      }
  }
  return vault.items.some((item) => ids.has(item.id) && isSource(item))
}

export function assertMutableItem(vault, id) {
  const item = vault.items.find((entry) => entry.id === id)
  if (isSource(item))
    throw new Error('资料为只读，不能修改资料内容或重命名')
  if (containsSource(vault, id))
    throw new Error('包含只读资料，不能移动或重命名其所在文件夹')
}

const parsing = new WeakMap()
export const isSourceParsing = (item) =>
  isSource(item) && parsing.has(item.source)

async function runParser(blob, format) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  if (typeof window === 'undefined') {
    const { parseSourceBytes } = await import('./document-parser.js')
    return parseSourceBytes(bytes, format)
  }
  const { default: DocumentWorker } =
    await import('./document-worker.js?worker&inline')
  const worker = new DocumentWorker()
  return new Promise((resolve, reject) => {
    const finish = (error, result) => {
      clearTimeout(timer)
      worker.terminate()
      if (error) reject(error)
      else resolve(result)
    }
    const timer = setTimeout(
      () => finish(new Error('解析超时，请缩小文档后重试')),
      60000,
    )
    worker.onerror = () => finish(new Error('文档解析失败，请检查文件是否损坏'))
    worker.onmessage = ({ data }) =>
      finish(data.error ? new Error(data.error) : null, data.result)
    worker.postMessage({ bytes, format }, [bytes.buffer])
  })
}

export async function ensureSourceParsed(item, { force = false } = {}) {
  if (!isSource(item)) return item
  const source = item.source
  if (parsing.has(source)) {
    await parsing.get(source)
    // 同步目录可能替换文件对象，但复用同一份缓存。
    item.content = source.text || ''
    return item
  }
  if (
    !force &&
    source.version === DOCUMENT_VERSION &&
    ['ready', 'error'].includes(source.status)
  ) {
    item.content = source.text || ''
    return item
  }
  const task = (async () => {
    source.status = 'pending'
    try {
      if (!(source.blob instanceof Blob))
        throw new Error('原始资料已丢失，请重新导入')
      if (source.blob.size > MAX_DOCUMENT_BYTES)
        throw new Error('单份资料不能超过 30 MB')
      const result = await runParser(source.blob, source.format)
      Object.assign(source, result, {
        status: 'ready',
        version: DOCUMENT_VERSION,
        error: '',
      })
      item.content = result.text
    } catch (error) {
      source.status = 'error'
      source.error = error.message || '文档解析失败'
      source.text = ''
      source.chunks = []
      source.warnings = []
      source.version = DOCUMENT_VERSION
      item.content = ''
    }
  })()
  parsing.set(source, task)
  try {
    await task
  } finally {
    parsing.delete(source)
  }
  return item
}

export function readSource(item, { offset = 0, limit = 4 } = {}) {
  if (
    !Number.isInteger(offset) ||
    offset < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 8
  )
    throw new Error('资料读取范围不正确，每次可读取一至八段')
  const source = item.source
  const chunks = source.chunks || []
  return {
    readonly: true,
    format: source.format,
    status: source.status,
    warnings: [SOURCE_LIMITATIONS, ...(source.warnings || [])],
    ...(source.error ? { error: source.error } : {}),
    chunks: chunks
      .slice(offset, offset + limit)
      .map((chunk, index) => ({ ...chunk, index: offset + index })),
    totalChunks: chunks.length,
    nextOffset: offset + limit < chunks.length ? offset + limit : null,
  }
}
