import JSZip from 'jszip'

const STORE_KEY = 'zhiku-v2'
export const makeId = () => crypto.randomUUID()
const timestamp = () => new Date().toISOString()

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
        '# Markdown 入门\n\n用简单的语法，把注意力留给内容。\n\n## 基础格式\n\n用 **加粗** 突出重点，用 *斜体* 表达强调，用 ~~删除线~~ 标记修订。\n\n- 无序列表整理想法\n- `行内代码` 记录命令\n- [[欢迎来到知库]] 连接另一篇笔记\n\n## 待办清单\n\n- [x] 创建第一篇笔记\n- [ ] 为笔记添加一条双链\n- [ ] 在关系图谱中发现连接\n\n## 表格与代码\n\n| 语法 | 用途 |\n| --- | --- |\n| `# 标题` | 组织层级 |\n| `[[笔记]]` | 双向链接 |\n\n```javascript\nconst ideas = ["记录", "连接", "创造"];\nideas.forEach(idea => console.log(idea));\n```\n\n## 数学公式\n\n行内公式 $E = mc^2$。\n\n$$\n\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}\n$$\n\n## 引用\n\n> 写作是让思考变得可见。\n',
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
        '# 关于本地存储\n\n你的知识属于你。\n\n## 保存在浏览器\n\n知库使用浏览器本地存储，不需要注册账号。你的笔记不会发送到服务器。\n\n清除浏览器数据会删除知识库。建议定期使用知识库菜单中的 **导出知识库**，下载包含 Markdown 文件的 ZIP 备份。\n\n## 自己选择模型\n\n只有使用知识助手时，相关笔记和对话才会直接发送至你配置的模型接口。API 密钥也仅保存在当前设备。\n\n兼容 OpenAI 的接口需要允许浏览器跨域请求。请使用 HTTPS 接口或可信的本地模型服务。\n\n[[欢迎来到知库]]',
      ),
    ],
  }
}

export function loadDatabase() {
  const raw = localStorage.getItem(STORE_KEY)
  if (raw) {
    let data
    try {
      data = JSON.parse(raw)
    } catch {
      throw new Error('本地数据无法读取，请先备份浏览器数据')
    }
    if (!Array.isArray(data.vaults) || !data.vaults.length)
      throw new Error('本地知识库数据不完整')
    data.vaults.forEach(validateVault)
    return data
  }
  const vault = seededVault()
  const database = {
    vaults: [vault],
    activeId: vault.id,
    settings: {
      endpoint: 'https://api.openai.com/v1/chat/completions',
      apiKey: '',
      model: 'gpt-4o-mini',
    },
    conversations: {},
  }
  saveDatabase(database)
  return database
}

export function saveDatabase(database) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(database))
  } catch {
    throw new Error('本地存储空间不足，请导出备份后释放空间')
  }
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
    if (item.type === 'file' && typeof item.content !== 'string')
      throw new Error('笔记内容格式不正确')
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
  if (type === 'file' && !/\.md$/i.test(name)) name += '.md'
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
  validateName(name)
  const item = vault.items.find((entry) => entry.id === id)
  if (!item) throw new Error('文件不存在')
  name = name.trim()
  if (item.type === 'file' && !/\.md$/i.test(name)) name += '.md'
  uniqueName(vault, name, item.parentId, id)
  item.name = name
  item.updatedAt = timestamp()
}

export function moveItem(vault, id, parentId) {
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
  zip.file('.zhiku.json', JSON.stringify({ version: 1, vault }, null, 2))
  for (const item of vault.items) {
    if (item.type === 'folder') zip.folder(itemPath(vault, item))
    else zip.file(itemPath(vault, item), item.content)
  }
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' })
}

export async function importVault(file) {
  if (/\.(json|zhiku)$/i.test(file.name)) {
    const parsed = JSON.parse(await file.text())
    return { ...validateVault(parsed.vault || parsed), id: makeId() }
  }
  const zip = await JSZip.loadAsync(file)
  const manifest = zip.file('.zhiku.json')
  if (manifest) {
    const parsed = JSON.parse(await manifest.async('string'))
    return { ...validateVault(parsed.vault), id: makeId() }
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
    if (!/\.md$/i.test(entry.name)) continue
    const parts = entry.name.split('/')
    const name = parts.pop()
    createItem(
      vault,
      'file',
      name,
      ensureFolder(parts.join('/')),
      await entry.async('string'),
    )
  }
  if (!vault.items.length) throw new Error('压缩包中没有 Markdown 笔记')
  return validateVault(vault)
}
