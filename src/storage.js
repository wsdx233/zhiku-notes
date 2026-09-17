import JSZip from 'jszip'
import {
  isSource,
  isDocumentName,
  isSupportedName,
  sourceFields,
  sourceFormat,
  assertMutableItem,
  DOCUMENT_VERSION,
  MAX_DOCUMENT_BYTES,
} from './documents.js'
import { createStore, get, set, del } from 'idb-keyval'
import {
  readDirectory,
  readDirectoryFiles,
  reconcileDirectory,
  writeLocalFile,
  createLocalEntry,
  deleteLocalEntry,
  moveLocalEntry,
  localPath,
  entryExists,
} from './local-files.js'

const STORE_KEY = 'zhiku-v2'
const DB_STORE = createStore('zhiku-db', 'keyval')
const HANDLE_STORE = createStore('zhiku-handles', 'handles')

export function makeId() {
  const c =
    typeof crypto !== 'undefined'
      ? crypto
      : typeof window !== 'undefined'
        ? window.crypto
        : null
  if (c && typeof c.randomUUID === 'function') {
    try {
      return c.randomUUID()
    } catch {
      // 某些受限上下文下调用可能抛错，进入 fallback
    }
  }
  if (c && typeof c.getRandomValues === 'function') {
    try {
      const bytes = new Uint8Array(16)
      c.getRandomValues(bytes)
      bytes[6] = (bytes[6] & 0x0f) | 0x40
      bytes[8] = (bytes[8] & 0x3f) | 0x80
      const hex = [...bytes]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
    } catch {
      // getRandomValues 异常时进入 Math.random fallback
    }
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0
    const v = ch === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

try {
  const c =
    typeof crypto !== 'undefined'
      ? crypto
      : typeof window !== 'undefined'
        ? window.crypto
        : null
  if (c && typeof c.randomUUID !== 'function') {
    c.randomUUID = makeId
  }
} catch {
  // 忽略对象不可扩展错误
}

const timestamp = () => new Date().toISOString()

export const isLocalDirectoryAccessSupported = () =>
  typeof window !== 'undefined' &&
  window.isSecureContext === true &&
  typeof window.showDirectoryPicker === 'function'

export const isFileSystemAccessSupported = isLocalDirectoryAccessSupported

function seededVault() {
  const time = timestamp()
  const folder = (id, name, parentId = null) => ({
    id,
    name,
    parentId,
    type: 'folder',
    createdAt: time,
    updatedAt: time,
  })
  const file = (id, name, parentId, content) => ({
    id,
    name: `${name}.md`,
    parentId,
    type: 'file',
    content,
    createdAt: time,
    updatedAt: time,
  })
  return {
    id: makeId(),
    name: '我的知识库',
    storageType: 'browser',
    createdAt: time,
    updatedAt: time,
    items: [
      folder('start', '从这里开始'),
      file(
        'welcome',
        '欢迎来到知库',
        'start',
        '# 欢迎来到知库\n\n让每一个想法，都有迹可循。\n\n这里是属于你的安静空间。记录灵感，连接知识，和 AI 一起探索新的可能。所有笔记都保存在你的设备上，由你掌握。\n\n## 从一篇笔记开始\n\n不必想得太多，从一个问题、一段摘录，或今天突然冒出的想法开始。点击左侧 **新建笔记**，让思考自由发生。\n\n你可以使用 Markdown 专注书写，也可以创建文件夹，让每个想法各得其所。了解 [[Markdown 入门]]。\n\n## 让知识彼此连接\n\n知识的价值，不只在于收藏，更在于连接。输入 `[[笔记名称]]`，就能在两篇笔记之间建立双链。\n\n试着打开 [[构建第二大脑]]，或者前往 **关系图谱**，看看你的知识如何生长。\n\n> 好的想法从来不是孤岛。每一次连接，都是一次新的发现。\n\n## 和你的知识对话\n\n打开右上角的 **知识助手**，让 AI 帮你总结笔记、发现联系，或把一个灵感写成新的知识。你只需要在设置中连接自己的模型。\n\n[[关于本地存储]]',
      ),
      file(
        'markdown',
        'Markdown 入门',
        'start',
        '# Markdown 入门\n\n用简单的语法，把注意力留给内容。\n\n## 基础格式\n\n用 **加粗** 突出重点，用 *斜体* 表达强调，用 ~~删除线~~ 标记修订。\n\n- 无序列表整理想法\n- `行内代码` 记录命令\n- [[欢迎来到知库]] 连接另一篇笔记\n\n## 待办清单\n\n- [x] 创建第一篇笔记\n- [ ] 为笔记添加一条双链\n- [ ] 在关系图谱中发现连接\n\n## 表格与代码\n\n| 语法 | 用途 |\n| --- | --- |\n| `# 标题` | 组织层级 |\n| `[[笔记]]` | 双向链接 |\n\n```javascript\nconst ideas = ["记录", "连接", "创造"];\nideas.forEach(idea => console.log(idea));\n```\n\n## 数学公式\n\n行内公式 $E = mc^2$。\n\n$$\n\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}\n$$\n\n## 提示块 (Callouts)\n\n> [!NOTE]\n> 这是一条普通提示块，支持多种类型（如 TIP、WARNING、IMPORTANT 等）。\n\n> [!TIP] 实用技巧\n> 输入 `[[` 即可触发双链快速自动联想补全。\n\n## 引用\n\n> 写作是让思考变得可见。\n',
      ),
      folder('knowledge', '知识与思考'),
      file(
        'brain',
        '构建第二大脑',
        'knowledge',
        '# 构建第二大脑\n\n大脑用来产生想法，而不是储存想法。\n\n## 收集\n\n把触动你的内容留在知识库里，不必追求面面俱到。\n\n## 整理\n\n以行动为导向，使用文件夹组织项目，用双链连接主题。\n\n## 提炼\n\n把一段长文浓缩为一句自己的理解。阅读 [[渐进式总结]]。\n\n## 表达\n\n当知识被用于创作，它才真正成为你的。\n\n回到 [[欢迎来到知库]]，开始你的第一篇笔记。',
      ),
      file(
        'summary',
        '渐进式总结',
        'knowledge',
        '# 渐进式总结\n\n每次重读，留下更清晰的一层。\n\n1. 保存有价值的原始内容\n2. 加粗值得注意的句子\n3. 用自己的语言写下核心观点\n4. 将观点链接到 [[构建第二大脑]]\n\n总结不是压缩字数，而是提炼理解。',
      ),
      folder('inspiration', '灵感收集'),
      file(
        'ideas',
        '一些值得探索的想法',
        'inspiration',
        '# 一些值得探索的想法\n\n- 如何让记录成为轻松的日常习惯\n- 不同领域的知识可以产生哪些意外的连接\n- AI 如何协助我们思考，而不是代替我们思考\n\n这些想法可以从 [[构建第二大脑]] 开始生长。',
      ),
      file(
        'local',
        '关于本地存储',
        'start',
        '# 关于本地存储\n\n你的知识属于你。\n\n## IndexedDB 与本地文件夹互通\n\n知库使用浏览器 IndexedDB 大容量存储，不再受 localStorage 的 5MB 容量限制。\n\n你还可以通过 **新建知识库 -> 选择本地文件夹**，直接关联电脑上的本地目录。知库将直接读写你的 Markdown 文件，完美配合 Obsidian 或本地编辑器使用。\n\n## 自己选择模型\n\n只有使用知识助手时，相关笔记和对话才会直接发送至你配置的模型接口。API 密钥也仅保存在当前设备。\n\n[[欢迎来到知库]]',
      ),
    ],
  }
}

export async function loadDatabase() {
  let data = null

  // 1. 优先从 IndexedDB 加载
  try {
    data = await get(STORE_KEY, DB_STORE)
  } catch (err) {
    console.warn('读取 IndexedDB 失败:', err)
  }

  // 2. 如果 IndexedDB 为空，平滑迁移已有的 localStorage 数据
  if (!data) {
    const raw =
      typeof localStorage !== 'undefined'
        ? localStorage.getItem(STORE_KEY)
        : null
    if (raw) {
      try {
        data = JSON.parse(raw)
        try {
          await set(STORE_KEY, data, DB_STORE)
        } catch {
          // 迁移保存静默失败不阻断加载
        }
      } catch {
        throw new Error('本地数据无法读取，请先备份浏览器数据')
      }
    }
  }

  // 3. 初始全新种子数据
  if (!data) {
    const vault = seededVault()
    data = {
      vaults: [vault],
      activeId: vault.id,
      settings: {
        theme: 'system',
        provider: 'compatible',
        webSearch: false,
        endpoint: 'https://api.openai.com/v1/chat/completions',
        apiKey: '',
        model: 'gpt-4o-mini',
      },
      conversations: {},
    }
    try {
      await set(STORE_KEY, data, DB_STORE)
    } catch {
      // 忽略
    }
  }

  if (!Array.isArray(data.vaults) || !data.vaults.length)
    throw new Error('本地知识库数据不完整')

  data.settings ||= {}
  data.settings.theme ||= 'system'
  data.vaults.forEach((vault) => {
    // 旧目录导入只有缓存，没有写回权限，保留内容并明确归为浏览器模式。
    if (vault.localAccess === 'import') {
      vault.storageType = 'browser'
      delete vault.localAccess
    }
    validateVault(vault)
  })
  return data
}

export async function saveDatabase(database) {
  try {
    await set(STORE_KEY, database, DB_STORE)
  } catch {
    throw new Error('IndexedDB 存储空间不足或写入失败')
  }

  // 小于 3MB 时作为只读兜底副本存一份到 localStorage
  try {
    if (typeof localStorage !== 'undefined') {
      if (database.vaults.some((vault) => vault.items.some(isSource))) {
        localStorage.removeItem(STORE_KEY)
        return
      }
      const str = JSON.stringify(database)
      if (str.length < 3 * 1024 * 1024) localStorage.setItem(STORE_KEY, str)
      else localStorage.removeItem(STORE_KEY)
    }
  } catch {
    // 忽略 localStorage 配额超出错误
  }
}

/* ---------------------------------------------------------------------------
 * 本地文件系统 (File System Access API) 互通支持
 * ------------------------------------------------------------------------- */

const directoryHandles = new Map()
const diskQueues = new Map()

export async function getVaultDirHandle(vaultId) {
  if (directoryHandles.has(vaultId)) return directoryHandles.get(vaultId)
  const handle = await get(vaultId, HANDLE_STORE)
  if (handle) directoryHandles.set(vaultId, handle)
  return handle
}

export async function removeVaultHandle(vaultId) {
  await diskQueues.get(vaultId)
  await del(vaultId, HANDLE_STORE)
  directoryHandles.delete(vaultId)
}

export async function verifyDirectoryPermission(handle, request = false) {
  if (!handle) return false
  const options = { mode: 'readwrite' }
  if ((await handle.queryPermission(options)) === 'granted') return true
  return request && (await handle.requestPermission(options)) === 'granted'
}

export async function reconnectLocalVault(vault) {
  if (!isLocalDirectoryAccessSupported())
    throw new Error('本地直连需要 Chrome，并通过 HTTPS 或本机 localhost 打开')
  const handle = await getVaultDirHandle(vault.id)
  if (!handle)
    throw new Error(
      '文件夹连接已失效，请新建本地知识库重新连接，当前内容仍可导出',
    )
  if (!(await verifyDirectoryPermission(handle, true)))
    throw new Error('未获得文件夹读写权限，请重新连接')
  delete vault.localError
}

function diskTask(vault, task) {
  if (vault.storageType !== 'local') return Promise.resolve()
  const previous = diskQueues.get(vault.id) || Promise.resolve()
  const next = previous
    .catch(() => {})
    .then(async () => {
      const handle = await getVaultDirHandle(vault.id)
      if (!handle) throw new Error('文件夹连接已失效，请重新连接')
      if (!(await verifyDirectoryPermission(handle)))
        throw new Error('文件夹未授权，请重新连接')
      // 同源多标签页共享读写锁，避免各自通过基准检查后交叉覆盖。
      if (globalThis.navigator?.locks)
        return navigator.locks.request('zhiku-local-files', () => task(handle))
      return task(handle)
    })
    .catch((error) => {
      const messages = {
        NotAllowedError: '文件夹未授权，请重新连接',
        SecurityError:
          '本地直连需要安全访问环境，请使用 HTTPS 或本机 localhost',
        NotFoundError: '本地文件或文件夹已移动，请同步后重试',
        NotReadableError: '无法读取本地文件，请检查文件是否被占用',
        NoModificationAllowedError:
          '本地文件无法写入，请检查权限或关闭占用文件的程序',
        QuotaExceededError: '本地空间不足，修改已保留，请清理后重试',
        InvalidModificationError: '无法修改本地路径，请检查目标名称',
      }
      const message =
        messages[error.name] ||
        error.message ||
        '本地操作失败，修改已保留，请重试'
      vault.localError = message
      if (message === error.message) throw error
      const friendly = new Error(message, { cause: error })
      friendly.name = error.name
      throw friendly
    })
  const settled = next.catch(() => {})
  diskQueues.set(vault.id, settled)
  settled.then(() => {
    if (diskQueues.get(vault.id) === settled) diskQueues.delete(vault.id)
  })
  return next
}

export async function createLocalDirectoryVault() {
  if (!isLocalDirectoryAccessSupported())
    throw new Error('本地直连需要 Chrome，并通过 HTTPS 或本机 localhost 打开')
  const handle = await window.showDirectoryPicker({ mode: 'readwrite' })
  if (!(await verifyDirectoryPermission(handle, true)))
    throw new Error('未获得文件夹读写权限')
  const vault = {
    id: makeId(),
    name: handle.name,
    storageType: 'local',
    localAccess: 'readwrite',
    items: await readDirectory(handle, makeId),
    createdAt: timestamp(),
    updatedAt: timestamp(),
  }
  validateVault(vault)
  await set(vault.id, handle, HANDLE_STORE)
  directoryHandles.set(vault.id, handle)
  return vault
}

export async function syncLocalVaultFromDisk(vault) {
  return diskTask(vault, async (handle) => {
    const scanned = await readDirectory(handle, makeId)
    const changed = reconcileDirectory(vault, scanned)
    if (changed) vault.updatedAt = timestamp()
    delete vault.localError
    return changed
  })
}

export async function writeItemToDisk(vault, item) {
  if (isSource(item)) throw new Error('资料为只读，不能写回原文件')
  return diskTask(vault, async (handle) => {
    // 扫描可能已替换对象，始终根据稳定 ID 获取当前笔记。
    const current = vault.items.find((entry) => entry.id === item.id)
    if (!current) return
    await writeLocalFile(handle, vault, current)
    delete vault.localError
  })
}

export async function createWorkspaceItem(
  vault,
  type,
  name,
  parentId = null,
  content = '',
) {
  const draft = { ...vault, items: [...vault.items] }
  const item = createItem(draft, type, name, parentId, content)
  if (vault.storageType === 'local') {
    await diskTask(vault, async (handle) => {
      await createLocalEntry(handle, vault, item)
      vault.items.push(item)
      delete vault.localError
    })
  } else vault.items.push(item)
  return item
}

export async function deleteWorkspaceItem(vault, id) {
  assertMutableItem(vault, id)
  const item = vault.items.find((entry) => entry.id === id)
  if (!item) throw new Error('文件不存在')
  if (vault.storageType === 'local')
    await diskTask(vault, async (handle) => {
      await deleteLocalEntry(handle, vault, item)
      deleteItem(vault, id)
      delete vault.localError
    })
  else deleteItem(vault, id)
}

export async function relocateItemOnDisk(vault, id, draft, commit) {
  return diskTask(vault, async (handle) => {
    const item = vault.items.find((entry) => entry.id === id)
    const destination = draft.items.find((entry) => entry.id === id)
    if (!item || !destination) throw new Error('文件不存在')
    await moveLocalEntry(handle, vault, item, localPath(draft, destination))
    commit()
    delete vault.localError
  })
}

export async function keepLocalConflictCopy(vault, id) {
  return diskTask(vault, async (handle) => {
    const original = vault.items.find((entry) => entry.id === id)
    if (!original?.localConflict) throw new Error('当前笔记没有待处理的冲突')
    // 放入根目录，原目录已在外部删除时仍能恢复草稿。
    const stem = original.name.replace(/\.(md|markdown|txt)$/i, '')
    let name = `${stem} 工作区副本.md`
    let suffix = 2
    while (
      (await entryExists(handle, name)) ||
      vault.items.some(
        (item) =>
          !item.parentId && item.name.toLowerCase() === name.toLowerCase(),
      )
    )
      name = `${stem} 工作区副本 ${suffix++}.md`
    const draft = { ...vault, items: [...vault.items] }
    const copy = createItem(draft, 'file', name, null, original.content)
    await createLocalEntry(handle, vault, copy)
    vault.items.push(copy)
    if (original.content === copy.content) {
      original.localDirty = false
      original.localConflict = false
      original.diskContent = original.content
    }
    const scanned = await readDirectory(handle, makeId)
    reconcileDirectory(vault, scanned)
    delete vault.localError
    return copy.id
  })
}

export function validateVault(vault) {
  if (!vault || typeof vault.name !== 'string' || !Array.isArray(vault.items))
    throw new Error('知识库格式不正确')
  const ids = new Set()
  for (const item of vault.items) {
    if (
      !item ||
      typeof item.id !== 'string' ||
      !/^[\w-]+$/.test(item.id) ||
      ids.has(item.id) ||
      !['file', 'folder'].includes(item.type)
    )
      throw new Error('知识库包含无效文件')
    validateName(item.name)
    if (item.parentId === null && item.name.toLowerCase() === '.zhiku.json')
      throw new Error('此名称为知识库备份保留名称')
    if (item.type === 'file' && typeof item.content !== 'string')
      throw new Error('笔记内容格式不正确')
    if (isSource(item)) {
      if (
        !isDocumentName(item.name) ||
        !item.source ||
        !(item.source.blob instanceof Blob)
      )
        throw new Error('资料原件不完整，请重新导入原始文件或压缩包备份')
      if (item.source.blob.size > MAX_DOCUMENT_BYTES)
        throw new Error('单份资料不能超过 30 MB')
      item.source.format = sourceFormat(item.name)
      if (item.source.version !== DOCUMENT_VERSION) {
        item.source.status = 'pending'
        item.content = ''
        item.source.chunks = []
      }
      delete item.diskContent
      delete item.localDirty
      delete item.localConflict
    }
    item.createdAt = Number.isFinite(Date.parse(item.createdAt))
      ? item.createdAt
      : timestamp()
    item.updatedAt = Number.isFinite(Date.parse(item.updatedAt))
      ? item.updatedAt
      : item.createdAt
    ids.add(item.id)
  }
  for (const item of vault.items) {
    const visited = new Set([item.id])
    let parentId = item.parentId
    while (parentId !== null) {
      const parent = vault.items.find((entry) => entry.id === parentId)
      if (!parent || parent.type !== 'folder' || visited.has(parent.id))
        throw new Error('文件夹层级不正确')
      visited.add(parent.id)
      parentId = parent.parentId
    }
    if (
      vault.items.some(
        (other) =>
          other.id !== item.id &&
          other.parentId === item.parentId &&
          other.name.toLowerCase() === item.name.toLowerCase(),
      )
    )
      throw new Error('同一文件夹中存在重名文件')
  }
  return vault
}

function validateName(name) {
  if (
    typeof name !== 'string' ||
    !name.trim() ||
    /[\\/\x00-\x1f]/.test(name) ||
    ['.', '..'].includes(name.trim())
  )
    throw new Error('名称不能为空，也不能包含路径分隔符')
}

function assertParent(vault, parentId) {
  if (
    parentId !== null &&
    !vault.items.some((item) => item.id === parentId && item.type === 'folder')
  )
    throw new Error('目标文件夹不存在')
}

function uniqueName(vault, name, parentId, excludeId) {
  if (
    vault.items.some(
      (item) =>
        item.id !== excludeId &&
        item.parentId === parentId &&
        item.name.toLowerCase() === name.toLowerCase(),
    )
  )
    throw new Error('此文件夹中已存在同名文件')
}

export function createItem(vault, type, name, parentId = null, content = '') {
  validateName(name)
  assertParent(vault, parentId)
  name = name.trim()
  if (type === 'file' && !/\.(md|markdown|txt)$/i.test(name)) name += '.md'
  uniqueName(vault, name, parentId)
  const item = {
    id: makeId(),
    type,
    name,
    parentId,
    createdAt: timestamp(),
    updatedAt: timestamp(),
    ...(type === 'file' ? { content } : {}),
  }
  vault.items.push(item)
  vault.updatedAt = timestamp()
  return item
}

export function renameItem(vault, id, name) {
  assertMutableItem(vault, id)
  validateName(name)
  const item = vault.items.find((entry) => entry.id === id)
  if (!item) throw new Error('文件不存在')
  name = name.trim()
  if (item.type === 'file' && !/\.(md|markdown|txt)$/i.test(name)) name += '.md'
  uniqueName(vault, name, item.parentId, id)
  item.name = name
  item.updatedAt = timestamp()
}

export function moveItem(vault, id, parentId) {
  assertMutableItem(vault, id)
  const item = vault.items.find((entry) => entry.id === id)
  if (!item) throw new Error('文件不存在')
  assertParent(vault, parentId)
  let parent = parentId
  while (parent) {
    if (parent === id) throw new Error('不能将文件夹移动到自身或子文件夹中')
    parent = vault.items.find((entry) => entry.id === parent)?.parentId
  }
  uniqueName(vault, item.name, parentId, id)
  item.parentId = parentId
  item.updatedAt = timestamp()
}

export function deleteItem(vault, id) {
  assertMutableItem(vault, id)
  const ids = new Set([id])
  for (let changed = true; changed;) {
    changed = false
    for (const item of vault.items)
      if (ids.has(item.parentId) && !ids.has(item.id)) {
        ids.add(item.id)
        changed = true
      }
  }
  vault.items = vault.items.filter((item) => !ids.has(item.id))
}

export function itemPath(vault, item) {
  const parts = [item.name]
  let parent = vault.items.find((entry) => entry.id === item.parentId)
  while (parent) {
    parts.unshift(parent.name)
    parent = vault.items.find((entry) => entry.id === parent.parentId)
  }
  return parts.join('/')
}

export async function exportVault(vault) {
  const zip = new JSZip()
  // 二进制原件放在实际路径，清单只保存元数据，不对 Blob 做 JSON 序列化。
  const manifest = {
    ...vault,
    items: vault.items.map((item) => {
      if (!isSource(item)) return item
      const { blob, ...source } = item.source
      return { ...item, source }
    }),
  }
  const manifestText = JSON.stringify({ version: 2, vault: manifest }, null, 2)
  const encoder = new TextEncoder()
  const totalBytes =
    encoder.encode(manifestText).length +
    vault.items.reduce(
      (total, item) =>
        total +
        (item.type === 'folder'
          ? 0
          : isSource(item)
            ? item.source.blob.size
            : encoder.encode(item.content).length),
      0,
    )
  if (totalBytes > 100 * 1024 * 1024 || vault.items.length >= 10000)
    throw new Error('备份超过导入限制，请先下载资料原件并拆分知识库')
  zip.file('.zhiku.json', manifestText)
  for (const item of vault.items) {
    if (item.type === 'folder') zip.folder(itemPath(vault, item))
    else if (isSource(item)) {
      if (!(item.source.blob instanceof Blob))
        throw new Error('资料原件已丢失，无法导出')
      zip.file(itemPath(vault, item), await item.source.blob.arrayBuffer())
    } else zip.file(itemPath(vault, item), item.content)
  }
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' })
}

function browserVaultCopy(source) {
  const vault = { ...source, id: makeId(), storageType: 'browser' }
  delete vault.localAccess
  delete vault.localError
  for (const item of vault.items) {
    delete item.diskContent
    delete item.localDirty
    delete item.localConflict
  }
  return vault
}

export async function importVault(file) {
  if (/\.(json|zhiku)$/i.test(file.name)) {
    const parsed = JSON.parse(await file.text())
    return browserVaultCopy(validateVault(parsed.vault || parsed))
  }
  const archive =
    file instanceof Blob ? new Uint8Array(await file.arrayBuffer()) : file
  const { validateDocumentArchive } = await import('./document-parser.js')
  validateDocumentArchive(archive)
  const zip = await JSZip.loadAsync(archive)
  const manifest = zip.file('.zhiku.json')
  if (manifest) {
    const parsed = JSON.parse(await manifest.async('string'))
    const restored = parsed.vault
    if (!Array.isArray(restored?.items)) throw new Error('知识库格式不正确')
    // 先验证树结构，再通过实际原件重建缓存，避免信任备份中的提取文本。
    const tree = {
      ...restored,
      items: restored.items.map(({ kind, source, ...item }) => item),
    }
    validateVault(tree)
    for (const item of restored.items.filter(isSource)) {
      const original = zip.file(itemPath(tree, item))
      if (!original) throw new Error(`备份缺少资料原件「${item.name}」`)
      Object.assign(
        item,
        await sourceFields(
          new File([await original.async('uint8array')], item.name),
        ),
      )
    }
    return browserVaultCopy(validateVault(restored))
  }
  const vault = {
    id: makeId(),
    name: file.name.replace(/\.zip$/i, ''),
    items: [],
    createdAt: timestamp(),
    updatedAt: timestamp(),
  }
  const paths = new Map([['', null]])
  const ensureFolder = (path) => {
    if (paths.has(path)) return paths.get(path)
    const parts = path.split('/')
    const name = parts.pop()
    const parentId = ensureFolder(parts.join('/'))
    const folder = createItem(vault, 'folder', name, parentId)
    paths.set(path, folder.id)
    return folder.id
  }
  for (const entry of Object.values(zip.files)) {
    if (
      entry.name.startsWith('__MACOSX/') ||
      entry.name.split('/').some((part) => part.startsWith('.'))
    )
      continue
    if (entry.dir) {
      ensureFolder(entry.name.replace(/\/$/, ''))
      continue
    }
    if (!isSupportedName(entry.name)) continue
    const parts = entry.name.split('/')
    const name = parts.pop()
    const parentId = ensureFolder(parts.join('/'))
    if (isDocumentName(name)) {
      const fields = await sourceFields(
        new File([await entry.async('uint8array')], name),
      )
      addSourceItem(vault, name, parentId, fields)
    } else
      createItem(vault, 'file', name, parentId, await entry.async('string'))
  }
  if (!vault.items.length) throw new Error('压缩包中没有支持的笔记或资料')
  return validateVault(vault)
}

function addSourceItem(vault, name, parentId, fields) {
  validateName(name)
  if (parentId === null && name.toLowerCase() === '.zhiku.json')
    throw new Error('此名称为知识库备份保留名称')
  assertParent(vault, parentId)
  uniqueName(vault, name, parentId)
  const item = {
    id: makeId(),
    name,
    parentId,
    type: 'file',
    createdAt: timestamp(),
    updatedAt: timestamp(),
    ...fields,
  }
  vault.items.push(item)
  vault.updatedAt = timestamp()
  return item
}

export async function importSourceFile(vault, file, parentId = null) {
  const fields = await sourceFields(file)
  const draft = { ...vault, items: [...vault.items] }
  const item = addSourceItem(draft, file.name, parentId, fields)
  if (vault.storageType === 'local')
    await diskTask(vault, (handle) => createLocalEntry(handle, vault, item))
  vault.items.push(item)
  vault.updatedAt = timestamp()
  return item
}

export async function createDirectorySnapshot(files) {
  if (!files.length) throw new Error('没有选中文件，目录快照不支持空文件夹')
  const name = files[0].webkitRelativePath?.split('/')[0] || '文件夹快照'
  const vault = {
    id: makeId(),
    name,
    storageType: 'browser',
    directorySnapshot: true,
    items: await readDirectoryFiles(files, makeId),
    createdAt: timestamp(),
    updatedAt: timestamp(),
  }
  if (!vault.items.some((item) => item.type === 'file'))
    throw new Error('文件夹中没有支持的笔记或资料')
  return validateVault(vault)
}
