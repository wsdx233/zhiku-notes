import assert from 'node:assert/strict'
import test from 'node:test'
import {
  makeId,
  isLocalDirectoryAccessSupported,
  isFileSystemAccessSupported,
  createLocalDirectoryVault,
  verifyDirectoryPermission,
  createItem,
  renameItem,
  importVault,
} from './storage.js'

function installGlobal(t, name, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name)
  Object.defineProperty(globalThis, name, { configurable: true, value })
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, name, previous)
    else delete globalThis[name]
  })
}

function pickerEnvironment(t, picker, secure = true) {
  installGlobal(t, 'window', {
    isSecureContext: secure,
    showDirectoryPicker: picker,
  })
  const createElement = t.mock.fn(() => {
    throw new Error('不允许使用目录导入')
  })
  installGlobal(t, 'document', { createElement })
  return createElement
}

test('生成唯一知识库标识', () => {
  const ids = Array.from({ length: 100 }, makeId)
  assert.equal(new Set(ids).size, 100)
  for (const id of ids) assert.match(id, /^[\w-]{36}$/)
})

test('底层直连在非安全上下文明确拒绝，界面另行提供目录快照', async (t) => {
  const picker = t.mock.fn()
  const createElement = pickerEnvironment(t, picker, false)
  assert.equal(isLocalDirectoryAccessSupported(), false)
  assert.equal(isFileSystemAccessSupported(), false)
  await assert.rejects(createLocalDirectoryVault(), /HTTPS/)
  assert.equal(picker.mock.callCount(), 0)
  assert.equal(createElement.mock.callCount(), 0)
})

test('底层直连缺少目录句柄时保持失败，不伪造写回能力', async (t) => {
  const createElement = pickerEnvironment(t, undefined)
  assert.equal(isFileSystemAccessSupported(), false)
  await assert.rejects(createLocalDirectoryVault(), /Chrome/)
  assert.equal(createElement.mock.callCount(), 0)
})

for (const name of [
  'AbortError',
  'NotAllowedError',
  'SecurityError',
  'NotSupportedError',
  'UnknownError',
]) {
  test(`目录选择的 ${name} 保持原始错误，不触发导入`, async (t) => {
    const error = new DOMException('目录选择未完成', name)
    const picker = t.mock.fn(async () => {
      throw error
    })
    const createElement = pickerEnvironment(t, picker)
    assert.equal(isLocalDirectoryAccessSupported(), true)
    await assert.rejects(
      createLocalDirectoryVault(),
      (caught) => caught === error,
    )
    assert.deepEqual(picker.mock.calls[0].arguments, [{ mode: 'readwrite' }])
    assert.equal(createElement.mock.callCount(), 0)
  })
}

test('自动读写只查询权限，不弹出授权框', async (t) => {
  const handle = {
    queryPermission: t.mock.fn(async () => 'prompt'),
    requestPermission: t.mock.fn(async () => 'granted'),
  }
  assert.equal(await verifyDirectoryPermission(handle), false)
  assert.equal(handle.requestPermission.mock.callCount(), 0)
  assert.equal(await verifyDirectoryPermission(handle, true), true)
  assert.equal(handle.requestPermission.mock.callCount(), 1)
  assert.deepEqual(handle.queryPermission.mock.calls[0].arguments, [
    { mode: 'readwrite' },
  ])
})

test('拒绝读写权限时不创建知识库', async (t) => {
  pickerEnvironment(t, async () => ({
    queryPermission: async () => 'denied',
    requestPermission: async () => 'denied',
  }))
  await assert.rejects(createLocalDirectoryVault(), /读写权限/)
})

test('扫描失败保持原始错误', async (t) => {
  const error = new DOMException('无法读取文件夹', 'NotReadableError')
  pickerEnvironment(t, async () => ({
    name: '知识库',
    queryPermission: async () => 'granted',
    async *entries() {
      throw error
    },
  }))
  await assert.rejects(
    createLocalDirectoryVault(),
    (caught) => caught === error,
  )
})

test('空文件夹保存句柄失败不得静默转为浏览器模式', async (t) => {
  const error = new DOMException('无法保存目录句柄', 'QuotaExceededError')
  installGlobal(t, 'indexedDB', {
    open() {
      throw error
    },
  })
  pickerEnvironment(t, async () => ({
    name: '空目录',
    queryPermission: async () => 'granted',
    async *entries() {},
  }))
  await assert.rejects(
    createLocalDirectoryVault(),
    (caught) => caught === error,
  )
})

test('保留文本和 Markdown 原有扩展名', () => {
  const vault = { name: '笔记', items: [] }
  for (const name of ['说明.txt', '笔记.markdown', '文档.md']) {
    const item = createItem(vault, 'file', name)
    assert.equal(item.name, name)
    renameItem(vault, item.id, '新' + name)
    assert.equal(item.name, '新' + name)
  }
})

test('导入本地知识库备份时不继承不存在的文件夹权限', async () => {
  const original = {
    id: makeId(),
    name: '备份',
    storageType: 'local',
    localAccess: 'readwrite',
    localError: '失效',
    items: [],
  }
  const note = createItem(original, 'file', '笔记', null, '# 内容')
  note.diskContent = '旧内容'
  note.localDirty = true
  note.localConflict = true
  const restored = await importVault(
    new File([JSON.stringify({ vault: original })], '备份.json'),
  )
  assert.equal(restored.storageType, 'browser')
  assert.equal(restored.localAccess, undefined)
  assert.equal(restored.localError, undefined)
  assert.equal(restored.items[0].content, '# 内容')
  assert.equal(restored.items[0].localDirty, undefined)
  assert.equal(restored.items[0].diskContent, undefined)
})
