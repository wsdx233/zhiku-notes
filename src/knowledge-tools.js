import { ensureSourceParsed, isSource, readSource } from './documents.js'

export function knowledgeSummary(vault, item) {
  const parts = [item.name]
  let parent = item.parentId
  while (parent) {
    const folder = vault.items.find((entry) => entry.id === parent)
    if (!folder) break
    parts.unshift(folder.name)
    parent = folder.parentId
  }
  return {
    id: item.id,
    type: item.type,
    name: item.name,
    path: parts.join('/'),
    parentId: item.parentId,
    ...(isSource(item)
      ? {
          readonly: true,
          kind: 'source',
          format: item.source.format,
          status: item.source.status,
        }
      : {}),
  }
}

export async function readKnowledgeFile(vault, args) {
  const item = vault.items.find((entry) => entry.id === args.id)
  if (!item || item.type !== 'file') throw new Error('目标不是文件')
  if (isSource(item)) {
    await ensureSourceParsed(item)
    return { ...knowledgeSummary(vault, item), ...readSource(item, args) }
  }
  return { ...knowledgeSummary(vault, item), content: item.content }
}

export async function searchKnowledgeFiles(vault, query, signal) {
  if (typeof query !== 'string' || !query.trim())
    throw new Error('请输入搜索关键词')
  query = query.trim().toLowerCase()
  const matches = [],
    unreadableSources = []
  let totalMatches = 0
  for (const item of vault.items) {
    if (signal?.aborted) throw new DOMException('操作已中止', 'AbortError')
    if (item.type !== 'file') continue
    if (isSource(item)) {
      await ensureSourceParsed(item)
      if (item.source.status === 'error' || !item.content.trim())
        unreadableSources.push({
          ...knowledgeSummary(vault, item),
          error: item.source.error || '没有可读取的文字',
        })
    }
    if (!`${item.name}\n${item.content}`.toLowerCase().includes(query)) continue
    totalMatches++
    if (matches.length >= 40) continue
    const at = item.content.toLowerCase().indexOf(query)
    const match = {
      ...knowledgeSummary(vault, item),
      excerpt: item.content.slice(
        Math.max(0, at - 100),
        Math.max(0, at - 100) + 700,
      ),
    }
    if (isSource(item)) {
      const index = item.source.chunks.findIndex((chunk) =>
        chunk.text.toLowerCase().includes(query),
      )
      match.chunkIndex = index < 0 ? 0 : index
      match.pages = item.source.chunks[index]?.pages || []
      match.headingPath = item.source.chunks[index]?.path || []
    }
    matches.push(match)
  }
  return {
    matches,
    totalMatches,
    unreadableSources: unreadableSources.slice(0, 40),
    unreadableCount: unreadableSources.length,
  }
}
