import assert from 'node:assert/strict'
import test from 'node:test'
import {
  readDirectory,
  reconcileDirectory,
  writeLocalFile,
  createLocalEntry,
  deleteLocalEntry,
  moveLocalEntry,
  localPath,
} from './local-files.js'

let id = 0
const makeId = () => `item-${++id}`
const missing = () => new DOMException('不存在', 'NotFoundError')
class MemoryFile {
  kind = 'file'
  modified = 1700000000000
  constructor(name, content = '') {
    this.name = name
    this.content = content
  }
  async getFile() {
    return new File([this.content], this.name, { lastModified: this.modified })
  }
  async createWritable() {
    if (this.failWrite) throw new Error('磁盘写入失败')
    let pending
    return {
      write: async (content) => {
        pending =
          content instanceof Blob
            ? new Uint8Array(await content.arrayBuffer())
            : content
      },
      close: async () => {
        this.content = pending
        this.modified++
        this.afterWrite?.()
      },
      abort: async () => {},
    }
  }
}
class MemoryDirectory {
  kind = 'directory'
  children = new Map()
  constructor(name = '笔记') {
    this.name = name
  }
  async *entries() {
    yield* this.children.entries()
  }
  async getDirectoryHandle(name, { create = false } = {}) {
    if (!this.children.has(name) && create)
      this.children.set(name, new MemoryDirectory(name))
    const result = this.children.get(name)
    if (!result) throw missing()
    if (result.kind !== 'directory')
      throw new DOMException('不是目录', 'TypeMismatchError')
    return result
  }
  async getFileHandle(name, { create = false } = {}) {
    if (!this.children.has(name) && create)
      this.children.set(name, new MemoryFile(name))
    const result = this.children.get(name)
    if (!result) throw missing()
    if (result.kind !== 'file')
      throw new DOMException('不是文件', 'TypeMismatchError')
    return result
  }
  async removeEntry(name) {
    if (!this.children.has(name)) throw missing()
    if (this.failDelete === name) throw new Error('删除失败')
    this.children.delete(name)
  }
}
async function put(dir, path, content) {
  const parts = path.split('/')
  const name = parts.pop()
  for (const folder of parts)
    dir = await dir.getDirectoryHandle(folder, { create: true })
  const file = await dir.getFileHandle(name, { create: true })
  file.content = content
  file.modified++
  return file
}
async function setup() {
  const root = new MemoryDirectory()
  await put(root, '分类/子目录/笔记.md', '# 初始')
  await put(root, '说明.txt', '文本')
  return { root, vault: { items: await readDirectory(root, makeId) } }
}

test('空目录可直连，扫描保留原始扩展名', async () => {
  assert.deepEqual(await readDirectory(new MemoryDirectory(), makeId), [])
  const { root, vault } = await setup()
  await put(root, '.obsidian/配置.json', '{}')
  await put(root, '资源/图片.png', 'image')
  await put(root, '文档.markdown', '# 文档')
  const items = await readDirectory(root, makeId)
  assert.ok(items.some((item) => item.name === '说明.txt'))
  assert.ok(items.some((item) => item.name === '文档.markdown'))
  assert.ok(
    !items.some(
      (item) => item.name === '.obsidian' || item.name === '图片.png',
    ),
  )
  assert.equal(
    vault.items.find((item) => item.name === '笔记.md').diskContent,
    '# 初始',
  )
})

test('反复同步保持嵌套目录和文件身份，未变更时不刷新', async () => {
  const { root, vault } = await setup()
  const before = structuredClone(vault)
  for (let i = 0; i < 3; i++) {
    assert.equal(
      reconcileDirectory(vault, await readDirectory(root, makeId)),
      false,
    )
    assert.deepEqual(vault, before)
  }
})

test('外部新增、修改和删除自动合并', async () => {
  const { root, vault } = await setup()
  const id = vault.items.find((item) => item.name === '笔记.md').id
  await put(root, '分类/子目录/笔记.md', '# 外部修改')
  await put(root, '新增.md', '# 新笔记')
  await root.removeEntry('说明.txt')
  assert.equal(
    reconcileDirectory(vault, await readDirectory(root, makeId)),
    true,
  )
  assert.equal(vault.items.find((item) => item.id === id).content, '# 外部修改')
  assert.ok(vault.items.some((item) => item.name === '新增.md'))
  assert.ok(!vault.items.some((item) => item.name === '说明.txt'))
})

test('自动保存直接写回原文件，不改变路径', async () => {
  const { root, vault } = await setup()
  const item = vault.items.find((item) => item.name === '笔记.md')
  item.content = '# 工作区修改'
  item.localDirty = true
  await writeLocalFile(root, vault, item)
  assert.equal(item.diskContent, '# 工作区修改')
  assert.equal(item.localDirty, false)
  const scanned = await readDirectory(root, makeId)
  assert.equal(
    scanned.find((entry) => entry.name === '笔记.md').content,
    '# 工作区修改',
  )
})

test('扫描期间未保存内容不被覆盖', async () => {
  const { root, vault } = await setup()
  const item = vault.items.find((entry) => entry.name === '笔记.md')
  item.content = '# 草稿'
  item.localDirty = true
  reconcileDirectory(vault, await readDirectory(root, makeId))
  const current = vault.items.find((entry) => entry.id === item.id)
  assert.equal(current.content, '# 草稿')
  assert.equal(current.localConflict, false)
  await writeLocalFile(root, vault, current)
  assert.equal(current.diskContent, '# 草稿')
})

test('外部修改与草稿冲突时保留两边内容并拒绝覆盖', async () => {
  const { root, vault } = await setup()
  const item = vault.items.find((entry) => entry.name === '笔记.md')
  item.content = '# 工作区'
  item.localDirty = true
  await put(root, '分类/子目录/笔记.md', '# 外部')
  reconcileDirectory(vault, await readDirectory(root, makeId))
  const current = vault.items.find((entry) => entry.id === item.id)
  assert.equal(current.content, '# 工作区')
  assert.equal(current.localConflict, true)
  await assert.rejects(writeLocalFile(root, vault, current), {
    name: 'LocalConflictError',
  })
  assert.equal(
    (await readDirectory(root, makeId)).find(
      (entry) => entry.name === '笔记.md',
    ).content,
    '# 外部',
  )
})

test('未扫描到的外部改动也会在写入前检测', async () => {
  const { root, vault } = await setup()
  const item = vault.items.find((entry) => entry.name === '说明.txt')
  item.content = '草稿'
  item.localDirty = true
  await put(root, '说明.txt', '外部文本')
  await assert.rejects(writeLocalFile(root, vault, item), {
    name: 'LocalConflictError',
  })
  assert.equal(item.localConflict, true)
  assert.equal(
    (await (await root.getFileHandle('说明.txt')).getFile()).size,
    new Blob(['外部文本']).size,
  )
})

test('外部删除父目录后保留未保存笔记及层级，不复活原文件', async () => {
  const { root, vault } = await setup()
  const item = vault.items.find((entry) => entry.name === '笔记.md')
  item.content = '# 草稿'
  item.localDirty = true
  await root.removeEntry('分类')
  reconcileDirectory(vault, await readDirectory(root, makeId))
  const current = vault.items.find((entry) => entry.id === item.id)
  assert.equal(localPath(vault, current), '分类/子目录/笔记.md')
  assert.equal(current.localConflict, true)
  await assert.rejects(writeLocalFile(root, vault, current), {
    name: 'LocalConflictError',
  })
  assert.ok(!root.children.has('分类'))
})

test('旧缓存没有写回基准时，不覆盖不同的本地版本', async () => {
  const { root, vault } = await setup()
  const item = vault.items.find((entry) => entry.name === '说明.txt')
  delete item.diskContent
  item.content = '旧草稿'
  reconcileDirectory(vault, await readDirectory(root, makeId))
  assert.equal(
    vault.items.find((entry) => entry.id === item.id).localConflict,
    true,
  )
})

test('新建目录和文件写入磁盘，名称冲突不覆盖', async () => {
  const root = new MemoryDirectory()
  const folder = {
    id: makeId(),
    type: 'folder',
    name: '新目录',
    parentId: null,
  }
  const vault = { items: [folder] }
  await createLocalEntry(root, vault, folder)
  const note = {
    id: makeId(),
    type: 'file',
    name: '笔记.md',
    content: '# 新建',
    parentId: folder.id,
  }
  await createLocalEntry(root, vault, note)
  await assert.rejects(createLocalEntry(root, vault, note), /同名/)
  assert.equal(
    (await readDirectory(root, makeId)).find((item) => item.name === '笔记.md')
      .content,
    '# 新建',
  )
})

test('文件重命名和跨目录移动保留内容', async () => {
  const { root, vault } = await setup()
  const item = vault.items.find((entry) => entry.name === '说明.txt')
  await moveLocalEntry(root, vault, item, '分类/更名.txt')
  assert.ok(!root.children.has('说明.txt'))
  assert.equal(
    (await readDirectory(root, makeId)).find(
      (entry) => entry.name === '更名.txt',
    ).content,
    '文本',
  )
})

test('文件夹移动完整保留附件和隐藏文件', async () => {
  const { root, vault } = await setup()
  await put(root, '分类/图片.png', new Uint8Array([0, 255, 23]))
  await put(root, '分类/.隐藏/配置.json', '{"ok":true}')
  const item = vault.items.find((entry) => entry.name === '分类')
  await moveLocalEntry(root, vault, item, '新分类')
  assert.ok(!root.children.has('分类'))
  const target = await root.getDirectoryHandle('新分类')
  assert.deepEqual(
    new Uint8Array(
      await (
        await (await target.getFileHandle('图片.png')).getFile()
      ).arrayBuffer(),
    ),
    new Uint8Array([0, 255, 23]),
  )
  assert.equal(
    await (
      await (
        await (
          await target.getDirectoryHandle('.隐藏')
        ).getFileHandle('配置.json')
      ).getFile()
    ).text(),
    '{"ok":true}',
  )
})

test('移动目标已存在时保持源和目标不变', async () => {
  const { root, vault } = await setup()
  await put(root, '目标.txt', '目标内容')
  await assert.rejects(
    moveLocalEntry(
      root,
      vault,
      vault.items.find((item) => item.name === '说明.txt'),
      '目标.txt',
    ),
    /同名/,
  )
  assert.ok(root.children.has('说明.txt'))
  assert.equal(
    await (await (await root.getFileHandle('目标.txt')).getFile()).text(),
    '目标内容',
  )
})

test('移动最后删除源文件失败时回滚目标，保留源文件', async () => {
  const { root, vault } = await setup()
  root.failDelete = '说明.txt'
  await assert.rejects(
    moveLocalEntry(
      root,
      vault,
      vault.items.find((item) => item.name === '说明.txt'),
      '更名.txt',
    ),
    /删除失败/,
  )
  assert.ok(root.children.has('说明.txt'))
  assert.ok(!root.children.has('更名.txt'))
})

test('写入失败保留草稿和写回基准', async () => {
  const { root, vault } = await setup()
  const item = vault.items.find((entry) => entry.name === '说明.txt')
  ;(await root.getFileHandle('说明.txt')).failWrite = true
  item.content = '草稿'
  item.localDirty = true
  await assert.rejects(writeLocalFile(root, vault, item), /写入失败/)
  assert.equal(item.diskContent, '文本')
  assert.equal(item.localDirty, true)
})

test('删除本地文件夹同步删除磁盘内容', async () => {
  const { root, vault } = await setup()
  await deleteLocalEntry(
    root,
    vault,
    vault.items.find((item) => item.name === '分类'),
  )
  assert.ok(!root.children.has('分类'))
})

test('有未保存内容或外部变更时拒绝删除', async () => {
  const { root, vault } = await setup()
  const note = vault.items.find((item) => item.name === '说明.txt')
  note.localDirty = true
  await assert.rejects(deleteLocalEntry(root, vault, note), /待写入/)
  note.localDirty = false
  await put(root, '说明.txt', '外部修改')
  await assert.rejects(deleteLocalEntry(root, vault, note), {
    name: 'LocalConflictError',
  })
  assert.ok(root.children.has('说明.txt'))
})

test('外部将文件替换为同名目录时保留草稿且不产生重名节点', async () => {
  const { root, vault } = await setup()
  const item = vault.items.find((entry) => entry.name === '说明.txt')
  item.content = '待保存草稿'
  item.localDirty = true
  await root.removeEntry('说明.txt')
  await put(root, '说明.txt/新文件.md', '# 外部文件')
  reconcileDirectory(vault, await readDirectory(root, makeId))
  assert.equal(
    vault.items.filter((entry) => entry.name === '说明.txt').length,
    1,
  )
  assert.equal(
    vault.items.find((entry) => entry.id === item.id).localConflict,
    true,
  )
  assert.equal(
    vault.items.find((entry) => entry.id === item.id).content,
    '待保存草稿',
  )
  const { validateVault } = await import('./storage.js')
  validateVault({ ...vault, name: '测试' })
})

test('外部将目录替换为同名文件时保留子笔记草稿且不产生重名节点', async () => {
  const root = new MemoryDirectory()
  await put(root, '分类.md/笔记.md', '# 初始')
  const vault = { items: await readDirectory(root, makeId) }
  const item = vault.items.find((entry) => entry.name === '笔记.md')
  item.content = '# 草稿'
  item.localDirty = true
  await root.removeEntry('分类.md')
  await put(root, '分类.md', '# 外部文件')
  reconcileDirectory(vault, await readDirectory(root, makeId))
  assert.equal(
    vault.items.filter((entry) => entry.name === '分类.md').length,
    1,
  )
  assert.equal(
    localPath(
      vault,
      vault.items.find((entry) => entry.id === item.id),
    ),
    '分类.md/笔记.md',
  )
  const { validateVault } = await import('./storage.js')
  validateVault({ ...vault, name: '测试' })
})
