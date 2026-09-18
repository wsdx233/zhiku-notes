import {
  isSource,
  isSupportedName,
  isDocumentName,
  sourceFields,
  sourceFormat,
  parsedFormats,
  textFormats,
  assertMutableItem,
  containsSource,
} from './documents.js'
const ignored = (name) =>
  name.startsWith('.') ||
  ['node_modules', '__MACOSX', '$RECYCLE.BIN'].includes(name)
const now = () => new Date().toISOString()

export function localPath(vault, item) {
  const parts = [item.name]
  let parent = item.parentId
  while (parent) {
    const folder = vault.items.find((entry) => entry.id === parent)
    if (!folder) throw new Error('文件夹层级不完整')
    parts.unshift(folder.name)
    parent = folder.parentId
  }
  return parts.join('/')
}

export async function readDirectory(root, makeId) {
  const items = []
  async function walk(dir, parentId = null) {
    const entries = []
    for await (const [name, handle] of dir.entries()) {
      if (
        !ignored(name) &&
        (handle.kind === 'directory' || isSupportedName(name))
      )
        entries.push([name, handle])
    }
    entries.sort(([a], [b]) => a.localeCompare(b, 'zh-CN'))
    for (const [name, handle] of entries) {
      const item = {
        id: makeId(),
        name,
        parentId,
        type: handle.kind === 'directory' ? 'folder' : 'file',
        createdAt: now(),
        updatedAt: now(),
      }
      if (item.type === 'file') {
        const file = await handle.getFile()
        if (isDocumentName(name)) Object.assign(item, await sourceFields(file))
        else {
          item.content = await file.text()
          item.diskContent = item.content
        }
        item.updatedAt = new Date(file.lastModified).toISOString()
        item.createdAt = item.updatedAt
      }
      items.push(item)
      if (item.type === 'folder') await walk(handle, item.id)
    }
  }
  await walk(root)
  return items
}

// 先建立全部路径和 ID 映射，再改写父节点，避免嵌套目录丢失身份。
export function reconcileDirectory(vault, scanned) {
  const oldPaths = new Map(
    vault.items.map((item) => [localPath(vault, item).toLowerCase(), item]),
  )
  const temporary = { items: scanned }
  const paths = new Map(
    scanned.map((item) => [item.id, localPath(temporary, item).toLowerCase()]),
  )
  const ids = new Map(
    scanned.map((item) => {
      const previous = oldPaths.get(paths.get(item.id))
      return [item.id, previous?.type === item.type ? previous.id : item.id]
    }),
  )
  const next = scanned.map((disk) => {
    const previous = oldPaths.get(paths.get(disk.id))
    const item = {
      ...disk,
      id: ids.get(disk.id),
      parentId: ids.get(disk.parentId) || null,
    }
    if (previous?.type !== item.type) return item
    item.createdAt = previous.createdAt
    if (item.type === 'folder') item.updatedAt = previous.updatedAt
    if (isSource(item)) {
      if (
        isSource(previous) &&
        previous.source.fingerprint === item.source.fingerprint
      ) {
        item.source = previous.source
        item.content = previous.content
      }
      return item
    }
    if (item.type === 'file') {
      const dirty =
        previous.localDirty ||
        previous.localConflict ||
        (previous.diskContent === undefined &&
          previous.content !== disk.content)
      if (dirty && previous.content !== disk.content) {
        item.content = previous.content
        item.diskContent = previous.diskContent
        item.localDirty = true
        item.updatedAt = previous.updatedAt
        item.localConflict =
          previous.localConflict || previous.diskContent !== disk.content
      }
    }
    return item
  })
  const present = new Set(next.map((item) => item.id))
  const retain = (item) => {
    if (present.has(item.id)) return
    if (item.parentId) {
      const parent = vault.items.find((entry) => entry.id === item.parentId)
      if (parent) retain(parent)
    }
    // 外部将同一路径由文件替换为目录时，先保留冲突草稿。
    // 不把两个同名节点写进缓存，处理副本后再显示磁盘中的新类型。
    const path = localPath(vault, item).toLowerCase()
    const collision = next.find(
      (entry) => localPath({ items: next }, entry).toLowerCase() === path,
    )
    if (collision) {
      const removed = new Set([collision.id])
      for (let changed = true; changed;) {
        changed = false
        for (const entry of next)
          if (removed.has(entry.parentId) && !removed.has(entry.id)) {
            removed.add(entry.id)
            changed = true
          }
      }
      for (let index = next.length - 1; index >= 0; index--)
        if (removed.has(next[index].id)) {
          present.delete(next[index].id)
          next.splice(index, 1)
        }
    }
    next.push({
      ...item,
      ...(item.type === 'file'
        ? { localDirty: true, localConflict: true }
        : {}),
    })
    present.add(item.id)
  }
  for (const item of vault.items) {
    if (item.type === 'file' && (item.localDirty || item.localConflict))
      retain(item)
  }
  const changed = JSON.stringify(vault.items) !== JSON.stringify(next)
  if (changed) vault.items = next
  return changed
}

export async function directoryAt(root, parts, create = false) {
  let dir = root
  for (const name of parts)
    if (name) dir = await dir.getDirectoryHandle(name, { create })
  return dir
}

async function parentAt(root, path) {
  const parts = path.split('/')
  const name = parts.pop()
  return { dir: await directoryAt(root, parts), name }
}

export async function entryExists(dir, name) {
  // 枚举同时检测文件和目录，名称比较与 Windows 保持一致。
  for await (const [entry] of dir.entries())
    if (entry.toLowerCase() === name.toLowerCase()) return true
  return false
}

async function writeHandle(handle, content) {
  const stream = await handle.createWritable()
  try {
    await stream.write(content)
    await stream.close()
  } catch (error) {
    try {
      await stream.abort()
    } catch {
      /* 保留原始写入错误 */
    }
    throw error
  }
}

export function conflict(item) {
  item.localConflict = true
  item.localDirty = true
  const error = new Error(`「${item.name}」已在本地变更，未覆盖任何内容`)
  error.name = 'LocalConflictError'
  return error
}

export async function assertUnchanged(root, vault, item) {
  if (item.localConflict || item.diskContent === undefined) throw conflict(item)
  let disk
  try {
    const { dir, name } = await parentAt(root, localPath(vault, item))
    disk = await (await dir.getFileHandle(name)).getFile()
  } catch (error) {
    if (['NotFoundError', 'TypeMismatchError'].includes(error.name))
      throw conflict(item)
    throw error
  }
  const text = await disk.text()
  if (text !== item.diskContent) throw conflict(item)
}

export async function writeLocalFile(root, vault, item) {
  if (isSource(item)) throw new Error('资料为只读，不能写回原文件')
  if (item.localConflict) throw conflict(item)
  await assertUnchanged(root, vault, item)
  const { dir, name } = await parentAt(root, localPath(vault, item))
  const content = item.content
  await writeHandle(await dir.getFileHandle(name), content)
  item.diskContent = content
  item.localDirty = item.content !== content
  delete item.localConflict
}

export async function createLocalEntry(root, vault, item) {
  const { dir, name } = await parentAt(root, localPath(vault, item))
  if (await entryExists(dir, name))
    throw new Error('本地已存在同名文件，请先同步')
  if (item.type === 'folder')
    await dir.getDirectoryHandle(name, { create: true })
  else {
    const handle = await dir.getFileHandle(name, { create: true })
    try {
      await writeHandle(
        handle,
        isSource(item) ? item.source.blob : item.content,
      )
    } catch (error) {
      try {
        await dir.removeEntry(name)
      } catch {
        /* 失败时不触碰其他文件 */
      }
      throw error
    }
    if (!isSource(item)) {
      item.diskContent = item.content
      item.localDirty = false
    }
  }
}

async function assertNoDiskSources(entry) {
  if (entry.kind === 'file') {
    const ext = sourceFormat(entry.name)
    if (parsedFormats.has(ext) || textFormats.has(ext))
      throw new Error('本地目录包含只读资料，请先同步，未修改任何文件')
    return
  }
  for await (const [name, child] of entry.entries())
    if (!ignored(name)) await assertNoDiskSources(child)
}

export async function deleteLocalEntry(root, vault, item) {
  if (item.type === 'folder' && containsSource(vault, item.id))
    throw new Error('包含只读资料，不能删除文件夹，请先删除其中的资料')
  const path = localPath(vault, item)
  for (const file of vault.items.filter(
    (entry) =>
      entry.type === 'file' &&
      (entry.id === item.id || localPath(vault, entry).startsWith(path + '/')),
  )) {
    if (file.localDirty) throw new Error('请先保存待写入的笔记，再删除')
    if (!isSource(file)) await assertUnchanged(root, vault, file)
  }
  const { dir, name } = await parentAt(root, path)
  if (item.type === 'folder')
    await assertNoDiskSources(await dir.getDirectoryHandle(name))
  await dir.removeEntry(name, { recursive: item.type === 'folder' })
}

async function copyDirectory(source, target) {
  // 移动文件夹时保留附件、隐藏文件和不参与笔记索引的文件。
  for await (const [name, handle] of source.entries()) {
    if (handle.kind === 'directory')
      await copyDirectory(
        handle,
        await target.getDirectoryHandle(name, { create: true }),
      )
    else
      await writeHandle(
        await target.getFileHandle(name, { create: true }),
        await handle.getFile(),
      )
  }
}

async function snapshotEntry(handle) {
  if (handle.kind === 'file') {
    const file = await handle.getFile()
    const digest = await crypto.subtle.digest(
      'SHA-256',
      await file.arrayBuffer(),
    )
    return {
      size: file.size,
      modified: file.lastModified,
      hash: [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join(''),
    }
  }
  const entries = []
  for await (const [name, child] of handle.entries())
    entries.push([name, await snapshotEntry(child)])
  return entries.sort(([a], [b]) => a.localeCompare(b))
}

export async function moveLocalEntry(root, vault, item, destination) {
  assertMutableItem(vault, item.id)
  const source = localPath(vault, item)
  if (source === destination) return
  if (source.toLowerCase() === destination.toLowerCase())
    throw new Error('仅修改大小写时，请先使用其他名称')
  for (const file of vault.items.filter(
    (entry) =>
      entry.type === 'file' &&
      (entry.id === item.id ||
        localPath(vault, entry).startsWith(source + '/')),
  )) {
    if (file.localDirty) throw new Error('请先保存待写入的笔记，再移动或重命名')
    await assertUnchanged(root, vault, file)
  }
  const from = await parentAt(root, source)
  const to = await parentAt(root, destination)
  if (await entryExists(to.dir, to.name))
    throw new Error('目标文件夹已存在同名文件')
  const entry =
    item.type === 'folder'
      ? await from.dir.getDirectoryHandle(from.name)
      : await from.dir.getFileHandle(from.name)
  await assertNoDiskSources(entry)
  const before = JSON.stringify(await snapshotEntry(entry))
  let created = false
  try {
    if (item.type === 'folder') {
      const target = await to.dir.getDirectoryHandle(to.name, { create: true })
      created = true
      await copyDirectory(entry, target)
    } else {
      const target = await to.dir.getFileHandle(to.name, { create: true })
      created = true
      await writeHandle(target, await entry.getFile())
    }
    if (JSON.stringify(await snapshotEntry(entry)) !== before)
      throw new Error('移动期间本地内容发生变化，已保留原文件')
    await from.dir.removeEntry(from.name, {
      recursive: item.type === 'folder',
    })
  } catch (error) {
    // 写入失败时保留源文件。只有本次创建的目标允许清理。
    if (created)
      try {
        await to.dir.removeEntry(to.name, {
          recursive: item.type === 'folder',
        })
      } catch {
        /* 保留可恢复的副本 */
      }
    throw error
  }
}

// 标准目录选取提供一次性快照，不声称具有本地写回权限。
export async function readDirectoryFiles(files, makeId) {
  const items = []
  const folders = new Map([['', null]])
  const names = new Set()
  const ensureFolder = (path) => {
    if (folders.has(path)) return folders.get(path)
    const parts = path.split('/')
    const name = parts.pop()
    const parentId = ensureFolder(parts.join('/'))
    const item = {
      id: makeId(),
      name,
      parentId,
      type: 'folder',
      createdAt: now(),
      updatedAt: now(),
    }
    items.push(item)
    folders.set(path, item.id)
    return item.id
  }
  for (const file of files) {
    const parts = (file.webkitRelativePath || file.name).split('/')
    if (file.webkitRelativePath) parts.shift()
    if (
      parts.some(
        (part) => !part || part === '..' || part === '.' || part.includes('\\'),
      )
    )
      throw new Error('目录路径不正确')
    if (parts.some(ignored) || !isSupportedName(file.name)) continue
    const key = parts.join('/').toLowerCase()
    if (names.has(key)) throw new Error('目录中存在重名文件')
    names.add(key)
    const name = parts.pop()
    const item = {
      id: makeId(),
      name,
      type: 'file',
      parentId: ensureFolder(parts.join('/')),
      createdAt: new Date(file.lastModified || Date.now()).toISOString(),
      updatedAt: new Date(file.lastModified || Date.now()).toISOString(),
    }
    if (isDocumentName(name)) Object.assign(item, await sourceFields(file))
    else item.content = await file.text()
    items.push(item)
  }
  return items
}
