import { isTextSource, isImageSource, MAX_DOCUMENT_BYTES } from './documents.js'

// 在解压之前读取中央目录，避免压缩炸弹。拒绝加密 ZIP、分卷与 ZIP64。
export function validateDocumentArchive(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let end = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (
      view.getUint32(i, true) === 0x06054b50 &&
      i + 22 + view.getUint16(i + 20, true) === bytes.length
    ) {
      end = i
      break
    }
  }
  if (end < 0) throw new Error('文档压缩结构损坏')
  const count = view.getUint16(end + 10, true)
  let pos = view.getUint32(end + 16, true),
    total = 0
  if (
    view.getUint32(end + 4, true) !== 0 ||
    count > 10000 ||
    count !== view.getUint16(end + 8, true)
  )
    throw new Error('文档压缩结构不受支持')
  for (let i = 0; i < count; i++) {
    if (pos + 46 > end || view.getUint32(pos, true) !== 0x02014b50)
      throw new Error('文档压缩结构损坏')
    if (view.getUint16(pos + 8, true) & 1)
      throw new Error('暂不支持加密的 Office 文档')
    total += view.getUint32(pos + 24, true)
    if (total > 100 * 1024 * 1024)
      throw new Error('文档解压后过大，请拆分后导入')
    pos +=
      46 +
      view.getUint16(pos + 28, true) +
      view.getUint16(pos + 30, true) +
      view.getUint16(pos + 32, true)
  }
  if (pos > end) throw new Error('文档压缩结构损坏')
}

// 按字符限制分块，中文同样有明确上限，不依赖默认英文词数估算。
export function splitSourceText(text, { pages = [], path = [] } = {}) {
  const result = []
  let remaining = text
  while (remaining.length) {
    let end = Math.min(remaining.length, 2400)
    if (end < remaining.length) {
      const boundary = remaining.lastIndexOf('\n', end - 1)
      if (boundary > 1200) end = boundary + 1
    }
    result.push({ text: remaining.slice(0, end), pages, path })
    remaining = remaining.slice(end)
  }
  return result
}

export async function parseSourceBytes(bytes, format) {
  if (bytes.length > MAX_DOCUMENT_BYTES)
    throw new Error('单份资料不能超过 30 MB')
  if (isImageSource(format)) {
    return {
      text: '',
      chunks: [],
      warnings: ['图片暂无转写文本，扫描件需要识别后引用'],
    }
  }
  if (isTextSource(format)) {
    let text
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      throw new Error('文本编码无法识别，请另存为 UTF-8 后导入')
    }
    if (text.includes('\u0000')) throw new Error('此文件不是可读取的文本')
    return {
      text,
      chunks: splitSourceText(text),
      warnings: text.trim() ? [] : ['没有可读取的文字'],
    }
  }
  if (['docx', 'pptx', 'xlsx'].includes(format)) validateDocumentArchive(bytes)
  try {
    const { parseDocument } = await import('docmarrow')
    const document = await parseDocument(bytes, {
      format: format === 'htm' ? 'html' : format,
      speakerNotes: false,
    })
    const warnings = []
    const hasText = document.blocks.some((block) => block.type !== 'figure')
    const text = hasText ? document.markdown : ''
    if (document.meta.warnings.length)
      warnings.push('部分内容未能完整解析，请核对原件')
    if (!text.trim()) warnings.push('没有提取到文字，扫描件需要 OCR')
    if (format === 'pptx') warnings.push('不包含演讲者备注、动画与图表内容')
    if (format === 'xlsx')
      warnings.push('公式使用文件中已有的缓存结果，不重新计算，不包含图表')
    if (format === 'pdf')
      warnings.push('扫描页与图片未进行 OCR，复杂表格可能失真')
    // 只有 PDF 的页号可靠。其他格式保留标题路径，不伪造物理页码。
    const chunks = !hasText
      ? []
      : document
          .chunks({
            maxTokens: 2400,
            overlap: 0,
            countTokens: (text) => text.length,
          })
          .flatMap((chunk) =>
            splitSourceText(chunk.text, {
              pages: format === 'pdf' ? chunk.pages : [],
              path: chunk.path || [],
            }),
          )
    return { text, chunks, warnings }
  } catch (error) {
    if (/password|encrypted/i.test(error.message))
      throw new Error('暂不支持加密文档，请解密后导入')
    throw new Error('文档解析失败，请检查格式或文件是否损坏')
  }
}
