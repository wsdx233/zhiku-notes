import { createStore, get, setMany, delMany } from 'idb-keyval'

const store = createStore('zhiku-attachments', 'files')
const cache = new Map()
const imageTypes = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
])
const textExtension =
  /\.(txt|md|markdown|csv|json|jsonl|log|yaml|yml|xml|html|htm|css|js|jsx|ts|tsx|py|rs|go|java|c|h|cpp|sh|sql|toml|ini|tex)$/i

function dataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(new Error('无法读取图片附件'))
    reader.readAsDataURL(file)
  })
}

export async function prepareAttachment(file) {
  const image = imageTypes.has(file.type)
  const text =
    file.type.startsWith('text/') ||
    ['application/json', 'application/xml'].includes(file.type) ||
    textExtension.test(file.name)
  if (!image && !text)
    throw new Error('请选择 PNG、JPEG、WebP、GIF 图片或文本文件')
  const maxBytes = image ? 20 * 1024 * 1024 : 2 * 1024 * 1024
  if (file.size > maxBytes)
    throw new Error(image ? '图片不能超过 20 MB' : '文本附件不能超过 2 MB')
  const payload = image ? await dataUrl(file) : await file.text()
  if (!image && payload.includes('\u0000'))
    throw new Error('此文件不是可读取的文本')
  return {
    id: crypto.randomUUID(),
    name: file.name,
    type: image ? 'image' : 'text',
    payload,
  }
}

export async function storeAttachments(attachments) {
  if (!attachments.length) return []
  try {
    await setMany(
      attachments.map((attachment) => [attachment.id, attachment]),
      store,
    )
  } catch {
    throw new Error('附件保存失败，请检查浏览器存储空间')
  }
  for (const attachment of attachments) cache.set(attachment.id, attachment)
  return attachments.map(({ id, name, type }) => ({ id, name, type }))
}

async function loadAttachment(id) {
  if (cache.has(id)) return cache.get(id)
  const attachment = await get(id, store)
  if (!attachment) throw new Error('本地附件已丢失，请重新添加后发送')
  cache.set(id, attachment)
  return attachment
}

export async function resolveAttachmentMessages(messages) {
  return Promise.all(
    messages.map(async (message) => {
      if (!message.attachments?.length) return message
      const { attachments, ...apiMessage } = message
      const content = [
        { type: 'text', text: message.content || '请分析这些附件' },
      ]
      for (const reference of attachments) {
        const attachment = await loadAttachment(reference.id)
        if (attachment.type === 'image') {
          content.push({ type: 'text', text: `图片附件「${attachment.name}」` })
          content.push({
            type: 'image_url',
            image_url: { url: attachment.payload },
          })
        } else
          content.push({
            type: 'text',
            text: `文本附件「${attachment.name}」\n\n${attachment.payload}`,
          })
      }
      return { ...apiMessage, content }
    }),
  )
}

export async function fillAttachmentPreviews(root) {
  if (!root) return
  await Promise.all(
    [...root.querySelectorAll('[data-attachment-preview]')].map(
      async (element) => {
        try {
          const attachment = await loadAttachment(
            element.dataset.attachmentPreview,
          )
          if (!element.isConnected) return
          if (element.tagName === 'IMG') element.src = attachment.payload
          else element.textContent = attachment.payload
        } catch (error) {
          if (element.tagName === 'IMG') element.alt = error.message
          else element.textContent = error.message
        }
      },
    ),
  )
}

export async function deleteConversationAttachments(messages) {
  const ids = [
    ...new Set(
      messages
        .flatMap((message) => message.attachments || [])
        .map((attachment) => attachment.id),
    ),
  ]
  if (!ids.length) return
  await delMany(ids, store)
  for (const id of ids) cache.delete(id)
}
