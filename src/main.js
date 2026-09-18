import {
  DOCUMENT_ACCEPT,
  DOCUMENT_VERSION,
  SOURCE_LIMITATIONS,
  isSource,
  isTextSource,
  isImageSource,
  ensureSourceParsed,
  isSourceParsing,
  containsSource,
  assertMutableItem,
  NOTE_PATTERN,
  isDocumentName,
} from './documents.js'
import { renderPdfToContainer } from './pdf-preview.js'
import {
  knowledgeSummary,
  readKnowledgeFile,
  searchKnowledgeFiles,
} from './knowledge-tools.js'
import DOMPurify from 'dompurify'
import {
  loadDatabase,
  saveDatabase,
  makeId,
  renameItem,
  moveItem,
  itemPath,
  exportVault,
  importVault,
  importSourceFile,
  createDirectorySnapshot,
  isLocalDirectoryAccessSupported,
  createLocalDirectoryVault,
  syncLocalVaultFromDisk,
  writeItemToDisk,
  createWorkspaceItem,
  deleteWorkspaceItem,
  relocateItemOnDisk,
  reconnectLocalVault,
  keepLocalConflictCopy,
  removeVaultHandle,
} from './storage'
import {
  renderMarkdown,
  buildLinkGraph,
  getBacklinks,
  resolveWikiLink,
  extractTitle,
  listNoteLinks,
} from './markdown'
import { runAgent } from './agent'
import { PROVIDERS, providerFor } from './llm-providers'
import { graphMarkup, bindGraphNavigation } from './graph'
import {
  prepareAttachment,
  storeAttachments,
  resolveAttachmentMessages,
  fillAttachmentPreviews,
  deleteConversationAttachments,
} from './attachments'
import 'highlight.js/styles/github.css'
import 'katex/dist/katex.min.css'
import '@fontsource-variable/noto-sans-sc'
import '@fontsource-variable/material-symbols-rounded'
import './styles.css'
import { enhanceSelects, closeSelectMenu } from './select.js'

const app = document.querySelector('#app')
let database
try {
  database = await loadDatabase()
} catch (error) {
  app.textContent = error.message
  throw error
}

function applyTheme(theme = database.settings.theme || 'system') {
  const isDark =
    theme === 'dark' ||
    (theme === 'system' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light')
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.content = isDark ? '#151419' : '#ffffff'
}

applyTheme(database.settings.theme)
window
  .matchMedia('(prefers-color-scheme: dark)')
  .addEventListener('change', () => {
    if ((database.settings.theme || 'system') === 'system') applyTheme('system')
  })

const state = {
  selectedId: database.selections?.[database.activeId] || 'welcome',
  activeFolderId: null,
  page: 'note',
  mode: 'read',
  search: '',
  collapsed: new Set(),
  sidebarOpen: false,
  aiOpen: false,
  menu: null,
  modal: null,
  aiBusy: false,
  aiText: '',
  aiTools: [],
  aiSearches: [],
  aiDraft: '',
  abort: null,
  attachments: [],
  readingAttachments: false,
  importingSources: false,
  graphQuery: '',
  hideIsolated: false,
  saved: true,
  sourceView: 'image',
  wikiSuggest: {
    open: false,
    query: '',
    start: 0,
    end: 0,
    index: 0,
    items: [],
    x: 0,
    y: 0,
  },
}
let previewTimer
let toastTimer
let graphRefreshTimer
const diskWriteTimers = new Map()
let cacheWrites = 0
let refreshRunning = false
let dialogSubmitting = false
const treeScrollPositions = new Map()
const sourceBlobUrls = new Map()

function getSourceBlobUrl(id, blob) {
  if (sourceBlobUrls.has(id)) return sourceBlobUrls.get(id)
  const url = URL.createObjectURL(blob)
  sourceBlobUrls.set(id, url)
  return url
}

function revokeSourceBlobUrl(id) {
  if (sourceBlobUrls.has(id)) {
    URL.revokeObjectURL(sourceBlobUrls.get(id))
    sourceBlobUrls.delete(id)
  }
}

const escape = (value = '') =>
  String(value).replace(
    /[&<>'"]/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[
        char
      ],
  )
const icon = (name, cls = '') =>
  `<span class="material-symbols-rounded ${cls}" aria-hidden="true">${name}</span>`
const iconButton = (name, action, label, cls = '') =>
  `<button type="button" class="icon-button ${cls}" data-action="${action}" title="${label}" aria-label="${label}">${icon(name)}</button>`
const vault = () =>
  database.vaults.find((entry) => entry.id === database.activeId) ||
  database.vaults[0]
const files = () => vault().items.filter((item) => item.type === 'file')
const selected = () =>
  vault().items.find(
    (item) => item.id === state.selectedId && item.type === 'file',
  )
const history = () => database.conversations?.[vault().id] || []
const missingApiKey = () =>
  !database.settings.apiKey &&
  /^https?:\/\/(?:api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com)(?:[:/]|$)/i.test(
    database.settings.endpoint,
  )
const dateLabel = (value) =>
  new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric' }).format(
    new Date(value),
  )

function notify(message) {
  const toast = document.querySelector('#toast')
  toast.textContent = message
  toast.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3400)
}

function notifyLocalVaultCreated(entry) {
  notify(
    entry.directorySnapshot
      ? '文件夹已导入为快照，不会写回本地'
      : `已直连本地文件夹「${entry.name}」`,
  )
}

const indexingVaults = new Map()
async function indexVaultSources(targetVault) {
  if (indexingVaults.has(targetVault.id))
    return indexingVaults.get(targetVault.id)
  const pending = targetVault.items.filter(
    (item) =>
      isSource(item) &&
      (item.source.status === 'pending' ||
        item.source.version !== DOCUMENT_VERSION),
  )
  if (!pending.length) return
  const task = (async () => {
    for (const file of pending) {
      if (!database.vaults.includes(targetVault)) break
      await ensureSourceParsed(file)
      const current = targetVault.items.find((item) => item.id === file.id)
      if (current?.source === file.source) current.content = file.content
      try {
        await saveDatabase(database)
      } catch (error) {
        notify(error.message)
      }
      if (vault().id === targetVault.id) {
        if (
          selected()?.id === file.id &&
          state.page === 'note' &&
          !state.modal
        ) {
          const scroll =
            document.querySelector('.document-scroll')?.scrollTop || 0
          const workspace = document.querySelector('.workspace-content')
          if (workspace) workspace.innerHTML = renderNote()
          const next = document.querySelector('.document-scroll')
          if (next) next.scrollTop = scroll
        }
        if (state.search) {
          const tree = document.querySelector('.file-tree')
          if (tree) tree.innerHTML = renderSearchResults()
        }
      }
    }
  })()
  indexingVaults.set(targetVault.id, task)
  try {
    await task
  } finally {
    indexingVaults.delete(targetVault.id)
    if (database.vaults.includes(targetVault))
      void indexVaultSources(targetVault)
  }
}

function activateImportedVault(entry) {
  if (database.vaults.some((existing) => existing.name === entry.name))
    entry.name += ' 副本'
  database.vaults.push(entry)
  database.activeId = entry.id
  state.selectedId =
    entry.items.find((item) => item.type === 'file')?.id || null
  state.search = ''
  state.page = 'note'
  state.aiDraft = ''
  state.attachments = []
  save()
  render()
  notifyLocalVaultCreated(entry)
}

function save() {
  try {
    vault().updatedAt = new Date().toISOString()
    database.selections ||= {}
    database.selections[vault().id] = state.selectedId
    cacheWrites++
    state.saved = false
    saveDatabase(database)
      .then(() => {
        cacheWrites--
        if (!cacheWrites) state.saved = true
      })
      .catch((err) => {
        cacheWrites--
        state.saved = false
        notify(err.message)
      })
    return true
  } catch (error) {
    state.saved = false
    notify(error.message)
    return false
  }
}

function localNoticeMarkup() {
  const current = vault()
  if (current.directorySnapshot)
    return `<div class="local-notice">${icon('folder_copy')}<span>文件夹快照，修改仅保存在浏览器，不会写回本地</span></div>`
  if (current.storageType !== 'local') return ''
  const conflict =
    current.items.find(
      (item) => item.localConflict && item.id === state.selectedId,
    ) || current.items.find((item) => item.localConflict)
  if (conflict)
    return `<div class="local-notice" role="status">${icon('difference')}<span>「${escape(conflict.name)}」存在本地冲突，工作区修改已保留</span><button type="button" class="text-button" data-action="keep-conflict-copy" data-id="${conflict.id}">另存副本</button></div>`
  if (current.localError)
    return `<div class="local-notice" role="status">${icon('folder_off')}<span>${escape(current.localError)}</span><button type="button" class="text-button" data-action="sync-local-vault">重新连接</button></div>`
  return ''
}

function updateLocalNotice() {
  const notice = document.querySelector('#local-notice')
  if (notice) notice.innerHTML = localNoticeMarkup()
}

function queueLocalWrite(targetVault, file) {
  if (isSource(file)) return
  if (targetVault.storageType !== 'local') return
  file.localDirty = true
  const key = `${targetVault.id}:${file.id}`
  clearTimeout(diskWriteTimers.get(key))
  // 捕获知识库和文件身份，切换笔记或知识库不会把内容写入其他目录。
  diskWriteTimers.set(
    key,
    setTimeout(async () => {
      diskWriteTimers.delete(key)
      try {
        await writeItemToDisk(targetVault, file)
      } catch (error) {
        targetVault.localError = error.message
      }
      save()
      updateLocalNotice()
    }, 400),
  )
}

async function flushLocalWrites(targetVault) {
  if (targetVault.storageType !== 'local') return
  for (const file of targetVault.items.filter(
    (item) => item.type === 'file' && item.localDirty && !item.localConflict,
  )) {
    const key = `${targetVault.id}:${file.id}`
    clearTimeout(diskWriteTimers.get(key))
    diskWriteTimers.delete(key)
    await writeItemToDisk(targetVault, file)
  }
}

async function refreshLocalWorkspace(manual = false) {
  const targetVault = vault()
  if (targetVault.storageType !== 'local' || refreshRunning) return
  if (!manual && (document.hidden || state.modal || state.aiBusy)) return
  refreshRunning = true
  const previousError = targetVault.localError
  let changed = false
  let pending = false
  try {
    if (manual) await reconnectLocalVault(targetVault)
    changed = await syncLocalVaultFromDisk(targetVault)
    pending = targetVault.items.some(
      (item) => item.localDirty && !item.localConflict,
    )
    await flushLocalWrites(targetVault)
    if (changed && vault().id === targetVault.id && !state.modal) {
      const editor = document.querySelector('#markdown-editor')
      const focused = editor && document.activeElement === editor
      const selection = editor
        ? [editor.selectionStart, editor.selectionEnd, editor.scrollTop]
        : null
      render()
      const next = document.querySelector('#markdown-editor')
      if (focused && next) {
        next.focus({ preventScroll: true })
        next.setSelectionRange(selection[0], selection[1])
        next.scrollTop = selection[2]
      }
    }
    if (manual)
      notify(
        targetVault.items.some((item) => item.localConflict)
          ? '本地冲突待处理，修改已保留'
          : '本地文件已同步',
      )
  } catch (error) {
    targetVault.localError = error.message
    if (manual) notify(error.message)
  } finally {
    refreshRunning = false
    updateLocalNotice()
    if (changed || pending || previousError !== targetVault.localError) save()
  }
}

function ensureSelection() {
  if (!selected()) state.selectedId = files()[0]?.id || null
}

function selectFile(id) {
  const item = vault().items.find(
    (entry) => entry.id === id && entry.type === 'file',
  )
  if (!item) return
  state.selectedId = id
  state.activeFolderId = item.parentId || null
  if (isSource(item)) {
    state.mode = 'read'
    const fmt = item.source?.format
    if (isImageSource(fmt) || fmt === 'pdf') {
      state.sourceView = 'image'
    } else {
      state.sourceView = 'text'
    }
  }
  state.page = 'note'
  state.sidebarOpen = false
  state.menu = null
  database.selections ||= {}
  database.selections[vault().id] = id
  save()
  render()
  const documentScroll = document.querySelector('.document-scroll')
  if (documentScroll) documentScroll.scrollTop = 0
}

function getCurrentFolderId() {
  if (
    state.activeFolderId &&
    vault().items.some(
      (item) => item.id === state.activeFolderId && item.type === 'folder',
    )
  ) {
    return state.activeFolderId
  }
  return selected()?.parentId || null
}

let pdfRenderController = null

async function mountPdfViewers() {
  const viewer = document.querySelector('.source-pdf-viewer[data-source-id]')
  if (!viewer) {
    if (pdfRenderController) {
      pdfRenderController.abort()
      pdfRenderController = null
    }
    return
  }
  const sourceId = viewer.dataset.sourceId
  const file = vault().items.find((item) => item.id === sourceId)
  if (!file || !isSource(file) || !file.source?.blob) return

  if (pdfRenderController) {
    pdfRenderController.abort()
  }
  pdfRenderController = new AbortController()
  const signal = pdfRenderController.signal

  try {
    await renderPdfToContainer(viewer, file.source.blob, signal)
  } catch (error) {
    if (signal.aborted || !viewer.isConnected) return
    viewer.innerHTML = `<div class="source-empty" role="alert">${icon('error')}<h2>页面渲染失败</h2><p>${escape(error.message || '无法读取文档页面')}</p></div>`
  }
}

function render() {
  closeSelectMenu()
  clearTimeout(previewTimer)
  clearTimeout(graphRefreshTimer)
  ensureSelection()
  const scroll = document.querySelector('.document-scroll')?.scrollTop || 0
  const previousTree = document.querySelector('.file-tree')
  if (previousTree)
    treeScrollPositions.set(
      previousTree.dataset.scrollKey,
      previousTree.scrollTop,
    )
  app.innerHTML = `<div class="app-shell ${state.sidebarOpen ? 'sidebar-open' : ''}">
    ${renderSidebar()}
    ${state.sidebarOpen ? '<button class="sidebar-scrim" data-action="close-sidebar" aria-label="关闭导航"></button>' : ''}
    <main class="main-content">
      ${renderTopbar()}
      <div id="local-notice">${localNoticeMarkup()}</div>
      <div class="work-area ${state.aiOpen ? 'with-ai' : ''}">
        <div class="workspace-content">${state.page === 'graph' ? renderGraph() : renderNote()}</div>
        ${state.aiOpen ? renderAi() : state.page === 'note' && selected() ? renderConnections() : ''}
      </div>
    </main>
    ${state.menu ? renderMenu() : ''}
    ${state.modal ? renderModal() : ''}
  </div>`
  void indexVaultSources(vault())
  enhanceSelects(app)
  const documentScroll = document.querySelector('.document-scroll')
  if (documentScroll) documentScroll.scrollTop = scroll
  const nextTree = document.querySelector('.file-tree')
  if (nextTree)
    nextTree.scrollTop =
      treeScrollPositions.get(nextTree.dataset.scrollKey) || 0
  if (state.page === 'graph')
    bindGraphNavigation(document.querySelector('.graph-page'))
  if (state.aiOpen)
    void fillAttachmentPreviews(document.querySelector('#ai-messages'))
  void mountPdfViewers()
  if (state.modal) {
    requestAnimationFrame(() => {
      const input =
        document.querySelector(
          '.dialog input:not([type="password"]):not([type="hidden"]):not(:disabled), .dialog .field-select-trigger',
        ) ||
        document.querySelector('.dialog button[type="submit"]') ||
        document.querySelector('.dialog button')
      input?.focus()
      if (input?.tagName === 'INPUT') input.select()
    })
  }
}

function renderSidebar() {
  const currentVault = vault()
  const isLocal = currentVault.storageType === 'local'
  return `<aside class="sidebar">
    <button class="new-note" data-action="new-note">${icon('add')}<span>新建笔记</span></button>
    <label class="search-box">${icon('search')}<input id="note-search" placeholder="搜索笔记与资料" value="${escape(state.search)}" aria-label="搜索笔记与资料" autocomplete="off">${state.search ? '<button class="clear-search" data-action="clear-search" aria-label="清空搜索">' + icon('close') + '</button>' : ''}</label>
    <nav class="main-nav" aria-label="知识库导航"><button class="nav-row ${state.page === 'note' ? 'active' : ''}" data-action="notes">${icon('description')}<span>笔记与资料</span><span class="note-count">${files().length}</span></button><button class="nav-row ${state.page === 'graph' ? 'active' : ''}" data-action="graph">${icon('hub')}<span>关系图谱</span></button></nav>
    <div class="tree-heading"><span>${state.search ? '搜索结果' : '知识库内容'}</span>${iconButton('upload_file', 'import-sources', '添加资料')}${iconButton('create_new_folder', 'new-folder', '新建文件夹')}</div>
    <div class="file-tree" data-drop-root="true" data-scroll-key="${escape(`${currentVault.id}:${state.search}`)}">${state.search ? renderSearchResults() : renderTree(null)}</div>
    <div class="sidebar-bottom"><button class="vault-switch" data-action="vault-menu" aria-label="切换知识库" aria-expanded="${state.menu?.type === 'vault'}"><span class="vault-initial">${escape(currentVault.name[0])}</span><span>${escape(currentVault.name)}</span>${isLocal ? `<span class="vault-badge" title="本地文件夹直连">` + icon('folder_open') + '</span>' : ''}${icon('unfold_more')}</button>${iconButton('settings', 'settings', '设置', 'sidebar-settings')}</div>
  </aside>`
}

function renderTree(parentId, depth = 0) {
  const entries = vault()
    .items.filter((item) => item.parentId === parentId)
    .sort((a, b) => (a.type === b.type ? 0 : a.type === 'folder' ? -1 : 1))
  return (
    entries
      .map((item) => {
        const isFolder = item.type === 'folder'
        const closed = state.collapsed.has(item.id)
        const isSelected = isFolder
          ? item.id === getCurrentFolderId() && !selected()
          : item.id === state.selectedId && state.page === 'note'
        return `<div class="tree-branch"><div class="tree-row ${isFolder ? 'folder-row' : 'note-row'} ${isSelected ? 'selected' : ''}" style="--depth:${Math.min(depth, 8)}" data-tree-id="${item.id}" draggable="${item.type === 'file' || !containsSource(vault(), item.id)}">
      <button class="tree-open" ${isFolder ? `data-folder="${item.id}" aria-expanded="${!closed}"` : `data-select="${item.id}"`} title="${escape(item.name)}">${isFolder ? icon(closed ? 'chevron_right' : 'expand_more', 'chevron') + icon('folder', 'folder-icon') : icon(isSource(item) ? sourceIcon(item) : 'article', 'file-icon')}<span>${escape(extractTitle(item))}</span></button>
      <button class="tree-more" data-item-menu="${item.id}" aria-label="${escape(extractTitle(item))}的操作">${icon('more_horiz')}</button>
    </div>${isFolder && !closed ? renderTree(item.id, depth + 1) : ''}</div>`
      })
      .join('') ||
    (depth === 0
      ? `<div class="tree-empty">${icon('note_add')}<span>从第一篇笔记开始</span></div>`
      : '')
  )
}

function renderSearchResults() {
  const query = state.search.toLowerCase().trim()
  const matches = files().filter((file) =>
    `${file.name} ${file.content}`.toLowerCase().includes(query),
  )
  return matches.length
    ? matches
        .map(
          (file) =>
            `<button class="search-result ${file.id === state.selectedId ? 'selected' : ''}" data-select="${file.id}">${icon(isSource(file) ? sourceIcon(file) : 'article')}<span>${escape(extractTitle(file))}<span class="search-path">${escape(itemPath(vault(), file))}</span></span></button>`,
        )
        .join('')
    : `<div class="tree-empty">${icon('search_off')}<span>没有找到相关内容</span></div>`
}

function renderTopbar() {
  const file = selected()
  const currentVault = vault()
  const isLocal = currentVault.storageType === 'local'
  const parentId = file ? file.parentId : getCurrentFolderId()
  const parent = currentVault.items.find((item) => item.id === parentId)
  const currentTheme = database.settings.theme || 'system'
  const themeIcon =
    currentTheme === 'dark'
      ? 'dark_mode'
      : currentTheme === 'light'
        ? 'light_mode'
        : 'brightness_auto'
  const themeLabel =
    currentTheme === 'dark'
      ? '深色模式'
      : currentTheme === 'light'
        ? '浅色模式'
        : '跟随系统'

  return `<header class="topbar">
    <div class="breadcrumbs">
      ${iconButton('menu', 'open-sidebar', '打开导航', 'mobile-only')}
      <span class="breadcrumb-parent">${escape(state.page === 'graph' ? currentVault.name : parent?.name || currentVault.name)}</span>
      ${isLocal ? `<span class="vault-badge" title="本地文件夹直连">` + icon('folder_open') + '</span>' : ''}
      ${icon('chevron_right', 'breadcrumb-arrow')}
      <span class="breadcrumb-current">${escape(state.page === 'graph' ? '关系图谱' : extractTitle(file || { name: '所有笔记' }))}</span>
    </div>
    <div class="top-actions">
      ${isLocal ? `<button type="button" class="local-sync-button" data-action="sync-local-vault" title="同步本地变更">${icon('sync')}<span>同步</span></button>` : ''}
      <button type="button" class="icon-button" data-action="cycle-theme" title="外观主题" aria-label="外观主题">${icon(themeIcon)}</button>
      <button class="ai-toggle ${state.aiOpen ? 'active' : ''}" data-action="toggle-ai">${icon('auto_awesome')}<span>知识助手</span></button>
    </div>
  </header>`
}

function renderNote() {
  const file = selected()
  if (!file)
    return `<section class="empty-state"><div class="empty-symbol">${icon('edit_note')}</div><h1>给想法一个家</h1><p>新建一篇笔记，开始连接你的知识</p><button class="new-note" data-action="new-note">${icon('add')}<span>新建笔记</span></button></section>`
  if (isSource(file)) return renderSource(file)
  const wordCount = (file.content.match(/[\u3400-\u9fff]|[a-zA-Z0-9]+/g) || [])
    .length
  return `<section class="note-workspace">
    <div class="note-toolbar"><div class="view-switch" aria-label="编辑模式"><button class="${state.mode === 'read' ? 'active' : ''}" data-mode="read">${icon('chrome_reader_mode')}<span>阅读</span></button><button class="${state.mode === 'edit' ? 'active' : ''}" data-mode="edit">${icon('edit_note')}<span>编辑</span></button><button class="${state.mode === 'split' ? 'active' : ''} split-mode" data-mode="split" aria-label="分栏编辑" title="分栏编辑">${icon('vertical_split')}</button></div><div class="note-toolbar-right">${iconButton('link', 'copy-link', '复制双链')}${iconButton('more_horiz', 'note-menu', '笔记操作')}</div></div>
    ${state.mode !== 'read' ? renderFormatting() : ''}
    <div class="document-scroll ${state.mode === 'split' ? 'split-view' : ''}">
      ${state.mode !== 'read' ? `<div class="editor-wrap" style="position:relative;flex:1;display:flex;flex-direction:column;min-height:0;"><textarea class="markdown-editor" id="markdown-editor" aria-label="Markdown 编辑器" spellcheck="false" placeholder="从一个想法开始">${escape(file.content)}</textarea></div>` : ''}
      ${state.mode !== 'edit' ? `<div class="document-page"><article class="markdown-body" id="markdown-preview">${renderMarkdown(file.content, vault().items, file.id)}</article></div>` : ''}
    </div>
    <footer class="note-status"><span>${icon('notes')}<span id="word-count">${wordCount} 字</span></span><span>${icon('update')}<span>编辑于 ${dateLabel(file.updatedAt)}</span></span><button class="mobile-links" data-action="connections">${icon('link')}<span>反向链接</span></button></footer>
  </section>`
}

function sourceIcon(file) {
  return (
    {
      pdf: 'picture_as_pdf',
      pptx: 'slideshow',
      docx: 'description',
      xlsx: 'table_chart',
      html: 'language',
      htm: 'language',
      png: 'image',
      jpg: 'image',
      jpeg: 'image',
      webp: 'image',
      gif: 'image',
      bmp: 'image',
      svg: 'image',
    }[file.source.format] || 'draft'
  )
}

function renderSource(file) {
  const source = file.source
  const pending =
    source.status === 'pending' ||
    source.version !== DOCUMENT_VERSION ||
    isSourceParsing(file)
  const warnings = [SOURCE_LIMITATIONS, ...(source.warnings || [])]
  const isImage = isImageSource(source.format)
  const isPdf = source.format === 'pdf'
  const isImageView = state.sourceView === 'image' && (isImage || isPdf)

  let body
  if (isImageView) {
    if (isImage) {
      const url = getSourceBlobUrl(file.id, source.blob)
      body = `<div class="source-image-viewer"><img src="${url}" alt="${escape(file.name)}" class="source-image-preview"></div>`
    } else if (isPdf) {
      body = `<div class="source-pdf-viewer" data-source-id="${file.id}"><div class="pdf-loading">${icon('progress_activity', 'spin')}<span>正在渲染页面</span></div></div>`
    } else {
      body = `<div class="source-empty">${icon('image_not_supported')}<h2>当前格式暂无图片预览</h2><p>该格式请切换至转写文本模式查看，或下载原件在本地查看</p><button type="button" class="filled-button" data-action="set-source-view" data-view="text">查看转写文本</button></div>`
    }
  } else {
    body = pending
      ? `<div class="source-empty" role="status">${icon('hourglass_top')}<h2>正在解析资料</h2><p>文件保留在本机，解析完成后可供知识助手读取</p></div>`
      : source.status === 'error'
        ? `<div class="source-empty" role="alert">${icon('error')}<h2>暂时无法预览</h2><p>${escape(source.error)}</p><button class="text-button" data-action="retry-source">重新解析</button></div>`
        : !file.content.trim()
          ? `<div class="source-empty">${icon('find_in_page')}<h2>没有提取到文字</h2><p>扫描件与图片需要文字识别，当前版本不包含文字识别</p></div>`
          : isTextSource(source.format)
            ? `<pre class="source-text">${escape(file.content)}</pre>`
            : `<article class="markdown-body source-body">${DOMPurify.sanitize(renderMarkdown(file.content, vault().items, file.id), { FORBID_TAGS: ['img', 'picture', 'source', 'video', 'audio', 'iframe', 'object', 'embed', 'style', 'link', 'svg'], FORBID_ATTR: ['style', 'src', 'srcset', 'poster', 'background'] })}</article>`
  }

  return `<section class="note-workspace source-workspace">
    <div class="note-toolbar">
      ${isImage || isPdf ? `<div class="view-switch" aria-label="资料视图">
        <button class="${isImageView ? 'active' : ''}" data-action="set-source-view" data-view="image">${icon('image')}<span>图片</span></button>
        <button class="${!isImageView ? 'active' : ''}" data-action="set-source-view" data-view="text">${icon('text_snippet')}<span>转写文本</span></button>
      </div>` : ''}
      <div class="source-label">${icon('lock')}<span>只读资料</span><span class="source-format">${escape(source.format.toUpperCase())}</span></div>
      <div class="note-toolbar-right">
        ${iconButton('drive_file_move', 'move-source', '移动到')}
        ${iconButton('download', 'download-source', '下载原件')}
        ${iconButton('refresh', 'retry-source', '重新解析')}
        ${iconButton('link', 'copy-link', '复制双链')}
        ${iconButton('delete', 'delete-source', '删除文件')}
      </div>
    </div>
    <div class="document-scroll"><div class="document-page source-page"><header class="source-heading"><h1>${escape(file.name)}</h1><p>${escape(itemPath(vault(), file))}</p></header><div class="source-notice">${icon('info')}<div>${warnings.map((warning) => `<p>${escape(warning)}</p>`).join('')}</div></div>${body}</div></div>
    <footer class="note-status"><span>${icon(sourceIcon(file))}<span>${Math.max(1, Math.ceil(source.size / 1024))} KB</span></span><span>${icon('manage_search')}<span>${pending ? '正在建立索引' : source.status === 'error' ? '解析失败' : source.chunks.length ? '可供知识助手读取' : '暂无可读取文字'}</span></span></footer>
  </section>`
}

function renderFormatting() {
  return `<div class="formatting-bar" aria-label="Markdown 格式工具">${[
    ['title', 'heading', '标题'],
    ['format_bold', 'bold', '加粗'],
    ['format_italic', 'italic', '斜体'],
    ['format_list_bulleted', 'list', '列表'],
    ['checklist', 'task', '待办'],
    ['format_quote', 'quote', '引用'],
    ['code', 'code', '代码'],
    ['add_link', 'link', '双链'],
  ]
    .map(
      ([symbol, action, label]) =>
        `<button class="icon-button" data-format="${action}" aria-label="${label}" title="${label}">${icon(symbol)}</button>`,
    )
    .join('')}</div>`
}

function connectionContent() {
  const file = selected()
  if (!file) return ''
  const backlinks = getBacklinks(vault().items, file.id)
  const { edges } = buildLinkGraph(vault().items)
  const outgoing = [
    ...new Set(
      edges
        .filter((edge) => edge.source === file.id)
        .map((edge) => edge.target),
    ),
  ]
    .map((id) => vault().items.find((item) => item.id === id))
    .filter(Boolean)
  return `<div class="connection-section"><div class="rail-heading"><h2>局部图谱</h2>${iconButton('open_in_full', 'graph', '展开关系图谱')}</div><div class="mini-graph-wrap">${graphMarkup(vault().items, file.id, { compact: true })}</div></div>
    <div class="connection-section"><div class="rail-heading"><h2>反向链接</h2><span class="rail-count">${backlinks.length}</span></div>${backlinks.length ? backlinks.map(({ file: source }) => `<button class="related-note" data-select="${source.id}">${icon('subdirectory_arrow_left')}<span>${escape(extractTitle(source))}</span></button>`).join('') : '<p class="rail-empty">还没有笔记链接到这里</p>'}</div>
    <div class="connection-section"><div class="rail-heading"><h2>关联笔记</h2><span class="rail-count">${outgoing.length}</span></div>${outgoing.length ? outgoing.map((target) => `<button class="related-note" data-select="${target.id}">${icon('link')}<span>${escape(extractTitle(target))}</span></button>`).join('') : '<p class="rail-empty">用双链连接另一篇笔记</p>'}</div>`
}

function renderConnections() {
  return `<aside class="context-rail" aria-label="笔记链接">${connectionContent()}</aside>`
}

function renderGraph() {
  const graph = buildLinkGraph(vault().items)
  return `<section class="graph-page"><div class="graph-heading"><div><h1>关系图谱</h1><p>每一次连接，都是一次新的发现</p></div><label class="graph-search">${icon('search')}<input id="graph-search" placeholder="查找笔记" value="${escape(state.graphQuery)}"></label></div><div class="graph-surface">${graphMarkup(vault().items, state.selectedId, { query: state.graphQuery, hideIsolated: state.hideIsolated })}${!graph.nodes.length ? '<div class="graph-empty"><h2>你的知识星图，从一篇笔记开始</h2><button class="text-button" data-action="new-note">新建笔记</button></div>' : ''}<div class="graph-controls"><button class="icon-button" data-zoom="in" aria-label="放大">${icon('add')}</button><button class="icon-button" data-zoom="out" aria-label="缩小">${icon('remove')}</button><button class="icon-button" data-zoom="reset" aria-label="重置视图">${icon('center_focus_strong')}</button></div></div><div class="graph-footer"><span>${graph.nodes.length} 篇笔记 <span class="graph-separator"></span> ${graph.edges.length} 条连接</span><label><input type="checkbox" id="hide-isolated" ${state.hideIsolated ? 'checked' : ''}> 隐藏未连接笔记</label></div></section>`
}

const toolLabels = {
  list_files: '浏览知识库',
  read_file: '阅读文件',
  search_files: '查找知识',
  web_search: '联网搜索',
  create_file: '创建笔记',
  update_file: '更新笔记',
  create_folder: '创建文件夹',
  move_item: '移动文件',
  rename_item: '重命名文件',
  delete_item: '删除文件',
}
function aiMessagesMarkup() {
  const visible = history().filter(
    (message) =>
      message.search ||
      (['user', 'assistant'].includes(message.role) &&
        (message.content || message.attachments?.length)),
  )
  if (!visible.length && !state.aiBusy)
    return `<div class="ai-intro"><div class="ai-symbol">${icon('auto_awesome')}</div><h2>让灵感<br>多一种可能</h2><p>阅读、整理、连接<br>和你的知识一起思考</p><div class="ai-suggestions"><button data-prompt="请阅读并总结当前笔记，提炼最重要的观点">${icon('summarize')}<span>总结当前笔记</span>${icon('arrow_outward')}</button><button data-prompt="浏览我的知识库，发现可以连接的知识，并说明理由">${icon('hub')}<span>发现知识之间的联系</span>${icon('arrow_outward')}</button><button data-prompt="根据当前笔记，为我创建一篇延伸主题的新笔记，并使用双链连接来源">${icon('edit_square')}<span>把灵感写成新笔记</span>${icon('arrow_outward')}</button></div>${missingApiKey() ? '<button class="connect-model" data-action="settings">连接你的模型 ' + icon('arrow_forward') + '</button>' : ''}</div>`
  return `${visible.map((message) => (message.search ? renderSearchResult(message.search) : `<div class="chat-message ${message.role}">${message.role === 'assistant' ? '<div class="assistant-label">' + icon('auto_awesome') + '<span>知识助手</span></div>' : ''}<div class="markdown-body">${renderMarkdown(message.content || '', vault().items, selected()?.id)}</div>${renderSearchSuggestions(message.searchSuggestions)}${renderSentAttachments(message.attachments || [])}</div>`)).join('')}${state.aiBusy ? `<div class="chat-message assistant"><div class="assistant-label">${icon('auto_awesome', 'thinking')}<span>正在思考</span></div><div class="tool-activity">${state.aiTools.map((tool) => `<div>${icon(tool.status === 'running' ? 'progress_activity' : tool.status === 'error' ? 'error' : 'check_circle')}<span>${toolLabels[tool.name] || '执行操作'}${tool.result?.error ? '：' + escape(tool.result.error) : ''}</span></div>`).join('')}</div>${state.aiSearches.map(renderSearchResult).join('')}<div class="markdown-body live-answer">${renderMarkdown(state.aiText, vault().items, selected()?.id)}</div></div>` : ''}`
}

function renderSearchSuggestions(suggestions = []) {
  // 保留 Google 要求展示的搜索建议；隔离脚本、表单、父页导航和页面样式。
  return suggestions
    .map(
      (html) =>
        `<iframe class="search-suggestions" title="Google 搜索建议" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer" srcdoc="${escape("<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; base-uri 'none'; form-action 'none'\"><base target=\"_blank\">" + html)}"></iframe>`,
    )
    .join('')
}

function renderSearchResult(search) {
  return `<div class="web-search-result"><details><summary>${icon('travel_explore')}<span>${escape(search.query)}</span></summary><div class="markdown-body">${renderMarkdown(search.content, vault().items, selected()?.id)}</div></details>${renderSearchSuggestions(search.searchSuggestions)}</div>`
}

function renderSentAttachments(attachments) {
  return attachments
    .map((attachment) =>
      attachment.type === 'image'
        ? `<figure class="sent-image"><img data-attachment-preview="${attachment.id}" alt="${escape(attachment.name)}"><figcaption>${escape(attachment.name)}</figcaption></figure>`
        : `<details class="sent-text"><summary>${icon('description')}<span>${escape(attachment.name)}</span></summary><pre data-attachment-preview="${attachment.id}"></pre></details>`,
    )
    .join('')
}

function renderPendingAttachments() {
  return state.attachments
    .map(
      (attachment) =>
        `<div class="pending-attachment">${attachment.type === 'image' ? `<img src="${escape(attachment.payload)}" alt="${escape(attachment.name)}">` : icon('description')}<span>${escape(attachment.name)}</span><button type="button" data-remove-attachment="${attachment.id}" aria-label="移除${escape(attachment.name)}">${icon('close')}</button></div>`,
    )
    .join('')
}

function renderAi() {
  return `<aside class="ai-panel" aria-label="知识助手">
    <div class="ai-panel-header"><h2>${icon('auto_awesome')}知识助手</h2><div>${iconButton('add_comment', 'clear-chat', '新对话')}${iconButton('close', 'close-ai', '关闭知识助手')}</div></div>
    <div class="ai-messages" id="ai-messages" aria-live="polite">${aiMessagesMarkup()}</div>
    <div class="ai-input-area"><div class="context-chip">${icon('library_books')}<span>${escape(vault().name)}</span></div>
      <form id="ai-form" class="ai-composer">
        <div class="pending-attachments">${renderPendingAttachments()}</div>
        <textarea id="ai-input" placeholder="问问你的知识库" aria-label="输入问题" rows="2">${escape(state.aiDraft)}</textarea>
        <div class="composer-bottom">${iconButton('tune', 'settings', '模型设置')}<span>${escape(database.settings.model || '选择模型')}</span>
          <button type="button" class="icon-button search-toggle ${database.settings.webSearch ? 'active' : ''}" data-action="toggle-web-search" aria-label="联网搜索" aria-pressed="${database.settings.webSearch === true}" title="${database.settings.webSearch ? '联网搜索已开启' : '开启联网搜索 产生额外服务费用'}" ${state.aiBusy ? 'disabled' : ''}>${icon('travel_explore')}</button>
          <button type="button" class="icon-button attachment-button" data-action="attach-files" aria-label="添加附件" title="添加图片、文档或文本附件" ${state.readingAttachments ? 'disabled' : ''}>${icon(state.readingAttachments ? 'progress_activity' : 'attach_file')}</button>
          <button class="send-button ${state.aiBusy ? 'stop' : ''}" ${state.aiBusy ? 'type="button" data-action="stop-ai" aria-label="停止生成"' : 'type="submit" aria-label="发送问题"'} ${state.readingAttachments ? 'disabled' : ''}>${icon(state.aiBusy ? 'stop' : 'arrow_upward')}</button>
        </div>
      </form>
    </div>
  </aside>`
}

function renderMenu() {
  const close =
    '<button class="menu-scrim" aria-label="关闭菜单" data-action="close-menu"></button>'
  if (state.menu.type === 'vault')
    return `${close}<div class="popup-menu vault-menu" role="menu"><h3>知识库</h3>${database.vaults.map((entry) => `<button data-vault="${entry.id}" class="menu-vault ${entry.id === vault().id ? 'active' : ''}"><span class="vault-initial">${escape(entry.name[0])}</span><span>${escape(entry.name)}</span>${entry.storageType === 'local' ? '<span class="vault-badge" style="margin-left:auto;margin-right:6px;">' + icon('folder_open') + '</span>' : ''}${entry.id === vault().id ? icon('check') : ''}</button>`).join('')}<div class="menu-divider"></div><button data-action="new-vault">${icon('add')}新建知识库</button>${'<button data-action="open-local-vault">' + icon('folder_open') + '打开本地文件夹</button><button data-action="import-directory">' + icon('folder_copy') + '导入文件夹快照</button>'}<button data-action="rename-vault">${icon('drive_file_rename_outline')}重命名知识库</button><button data-action="export">${icon('download')}导出知识库</button><button data-action="import">${icon('upload')}导入知识库</button>${database.vaults.length > 1 ? '<button data-action="delete-vault" class="danger">' + icon('delete') + '删除知识库</button>' : ''}</div>`
  const item = vault().items.find((entry) => entry.id === state.menu.id)
  if (!item) return ''
  if (isSource(item))
    return `${close}<div class="popup-menu item-menu" style="left:${state.menu.x}px;top:${state.menu.y}px" role="menu"><button data-action="move-item">${icon('drive_file_move')}移动到</button><button data-action="download-source" data-id="${item.id}">${icon('download')}下载原件</button><button data-action="retry-source" data-id="${item.id}">${icon('refresh')}重新解析</button><div class="menu-divider"></div><button class="danger" data-action="delete-item">${icon('delete')}删除</button></div>`
  if (containsSource(vault(), item.id))
    return `${close}<div class="popup-menu item-menu" style="left:${state.menu.x}px;top:${state.menu.y}px" role="menu"><button data-action="new-child-note">${icon('note_add')}新建笔记</button><button data-action="new-child-folder">${icon('create_new_folder')}新建文件夹</button><p class="source-menu-hint">包含只读资料，不能移动或删除</p></div>`
  return `${close}<div class="popup-menu item-menu" style="left:${state.menu.x}px;top:${state.menu.y}px" role="menu">${item.type === 'folder' ? '<button data-action="new-child-note">' + icon('note_add') + '新建笔记</button><button data-action="new-child-folder">' + icon('create_new_folder') + '新建文件夹</button>' : ''}<button data-action="rename-item">${icon('drive_file_rename_outline')}重命名</button><button data-action="move-item">${icon('drive_file_move')}移动到</button>${item.type === 'file' ? '<button data-action="download-note">' + icon('download') + '下载 Markdown</button>' : ''}<div class="menu-divider"></div><button class="danger" data-action="delete-item">${icon('delete')}删除</button></div>`
}

function renderModal() {
  const modal = state.modal
  const title = {
    settings: '模型与外观设置',
    'new-note': '新建笔记',
    'new-folder': '新建文件夹',
    'new-vault': '新建知识库',
    'rename-vault': '重命名知识库',
    rename: '重命名',
    move: '移动到',
    delete: '删除确认',
    connections: '笔记连接',
  }[modal.type]
  let body
  if (modal.type === 'settings')
    body = `<p class="dialog-description">配置模型接口与应用外观</p>
      <label class="form-field"><span>外观主题</span><select name="theme">
        <option value="system" ${(database.settings.theme || 'system') === 'system' ? 'selected' : ''}>跟随系统</option>
        <option value="light" ${database.settings.theme === 'light' ? 'selected' : ''}>浅色模式</option>
        <option value="dark" ${database.settings.theme === 'dark' ? 'selected' : ''}>深色模式</option>
      </select></label>
      <label class="form-field"><span>接口协议</span><select name="provider">${Object.entries(
        PROVIDERS,
      )
        .map(
          ([value, preset]) =>
            `<option value="${value}" ${providerFor(database.settings) === value ? 'selected' : ''}>${preset.label}</option>`,
        )
        .join(
          '',
        )}</select></label><label class="form-field"><span>模型接口</span><input name="endpoint" type="url" value="${escape(database.settings.endpoint)}" placeholder="${PROVIDERS[providerFor(database.settings)].endpoint}" required></label><label class="form-field"><span>API 密钥</span><div class="password-field"><input name="apiKey" type="password" value="${escape(database.settings.apiKey)}" autocomplete="off" placeholder="本地或免鉴权网关可留空">${iconButton('visibility', 'toggle-key', '显示或隐藏密钥')}</div></label><label class="form-field"><span>模型名称</span><input name="model" value="${escape(database.settings.model)}" required placeholder="${PROVIDERS[providerFor(database.settings)].model}"></label><label class="search-setting"><input type="checkbox" name="webSearch" ${database.settings.webSearch ? 'checked' : ''} ${providerFor(database.settings) === 'compatible' ? 'disabled' : ''}><span>允许联网搜索</span></label><p class="search-help">需要支持搜索的模型与原生协议，兼容接口不提供统一搜索工具。开启后由模型按需搜索，可能产生额外费用；搜索查询会发送给服务商。请勿用于敏感笔记。切换协议会填入官方接口并清空密钥，中转地址请重新填写。</p><div class="settings-notice">${icon('shield')}<p>密钥仅保存在此浏览器。对话和相关笔记直接发送到所填接口，需要接口允许跨域访问。仅连接可信服务。</p></div>`
  else if (modal.type === 'new-vault') {
    const isLocal = modal.storageMode === 'local'
    const directAccess = isLocalDirectoryAccessSupported()
    body = `<p class="dialog-description">选择知识库的存储位置</p>
      <label class="form-field"><span>存储方式</span><select name="storageMode" id="new-vault-mode">
        <option value="browser" data-icon="database" data-description="保存在当前浏览器，无需选择文件夹" ${isLocal ? '' : 'selected'}>浏览器存储</option>
        <option value="local" data-icon="folder_open" data-description="支持时直连目录，否则导入文件夹快照" ${isLocal ? 'selected' : ''}>本地文件夹</option>
      </select></label>
      <div id="new-vault-name-wrap" ${isLocal ? 'hidden' : ''}>
        <label class="form-field"><span>知识库名称</span><input name="name" value="新建知识库" placeholder="知识库名称" ${isLocal ? 'disabled' : 'required'} maxlength="150"></label>
      </div>
      <div id="new-vault-local-tip" class="settings-notice" ${isLocal ? '' : 'hidden'}>
        ${icon(directAccess ? 'folder_open' : 'info')}
        <p>${directAccess ? '选择文件夹并授权读写，笔记修改自动写回，资料保持只读。支持空文件夹，名称沿用所选文件夹。' : '当前环境使用标准目录选取，导入为浏览器快照，不会写回本地。不支持空目录。'}</p>
      </div>`
  } else if (modal.type === 'connections') body = connectionContent()
  else if (modal.type === 'delete') {
    const targetItem = vault().items.find((entry) => entry.id === modal.id)
    const isFolder = targetItem?.type === 'folder'
    body = `<p class="dialog-description">确定删除「${escape(modal.name)}」吗？${modal.vaultId ? (database.vaults.find((entry) => entry.id === modal.vaultId)?.storageType === 'local' ? '只移除知识库连接和对话，不会删除本地文件。' : '这会删除该知识库的全部笔记和对话。') : isFolder ? '文件夹中的内容也会一并删除。' : ''}此操作无法撤销，请先导出备份。</p>`
  }
  else if (modal.type === 'move')
    body = `<label class="form-field"><span>目标文件夹</span><select name="parentId">${folderOptions(modal.id)}</select></label>`
  else
    body = `<label class="form-field"><span>名称</span><input name="name" value="${escape(modal.value || '')}" placeholder="${modal.type.includes('folder') ? '文件夹名称' : modal.type.includes('vault') ? '知识库名称' : '笔记名称'}" required maxlength="150"></label>${['new-note', 'new-folder'].includes(modal.type) ? `<label class="form-field"><span>所在文件夹</span><select name="parentId">${folderOptions(null, modal.parentId)}</select></label>` : ''}`
  return `<div class="modal-backdrop" data-action="close-modal"><section class="dialog ${modal.type === 'settings' ? 'settings-dialog' : ''}" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><form id="dialog-form"><header class="dialog-header"><h2 id="dialog-title">${title}</h2>${iconButton('close', 'close-modal', '关闭')}</header><div class="dialog-body">${body}<p class="form-error" role="alert"></p></div>${modal.type !== 'connections' ? `<footer class="dialog-footer"><button type="button" class="text-button" data-action="close-modal">取消</button><button class="filled-button ${modal.type === 'delete' ? 'danger-filled' : ''}" type="submit" >${modal.type === 'delete' ? '确认删除' : modal.type === 'settings' ? '保存设置' : modal.type === 'new-vault' ? (modal.storageMode === 'local' ? '选择文件夹' : '创建知识库') : '确定'}</button></footer>` : ''}</form></section></div>`
}

function folderOptions(excludeId, selectedParent = null) {
  const excluded = new Set(excludeId ? [excludeId] : [])
  for (let i = 0; i < vault().items.length; i++)
    for (const item of vault().items)
      if (excluded.has(item.parentId)) excluded.add(item.id)
  return `<option value="" ${!selectedParent ? 'selected' : ''}>知识库根目录</option>${vault()
    .items.filter((item) => item.type === 'folder' && !excluded.has(item.id))
    .map(
      (item) =>
        `<option value="${item.id}" ${item.id === selectedParent ? 'selected' : ''}>${escape(itemPath(vault(), item))}</option>`,
    )
    .join('')}`
}

function showModal(type, options = {}) {
  state.menu = null
  state.modal = { type, ...options }
  render()
}

function showItemMenu(id, target) {
  const rect = target.getBoundingClientRect()
  state.menu = {
    type: 'item',
    id,
    x: Math.min(rect.left, innerWidth - 234),
    y: Math.min(rect.bottom + 6, innerHeight - 300),
  }
  render()
}

function download(blob, name) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

async function handleAction(action, target) {
  const menuItem = vault().items.find((item) => item.id === state.menu?.id)
  if (action === 'import-sources') {
    if (state.importingSources) return notify('资料正在导入')
    document.querySelector('#source-input').click()
    return
  }
  if (action === 'download-source' || action === 'retry-source') {
    const file =
      vault().items.find((item) => item.id === target.dataset.id) ||
      menuItem ||
      selected()
    if (!isSource(file)) return
    state.menu = null
    if (action === 'download-source') download(file.source.blob, file.name)
    else {
      if (isSourceParsing(file)) return notify('资料正在解析')
      const task = ensureSourceParsed(file, { force: true })
      render()
      await task
      await saveDatabase(database)
    }
    render()
    return
  }
  if (action === 'import-directory') {
    if (state.aiBusy) return notify('请先停止当前对话')
    state.menu = null
    document.querySelector('#directory-input').click()
    render()
    return
  }
  if (action === 'close-menu') {
    state.menu = null
    render()
  } else if (action === 'vault-menu') {
    state.menu = state.menu?.type === 'vault' ? null : { type: 'vault' }
    render()
  } else if (action === 'note-menu') showItemMenu(state.selectedId, target)
  else if (action === 'new-note' || action === 'new-folder')
    showModal(action, { parentId: getCurrentFolderId() })
  else if (action === 'new-child-note' || action === 'new-child-folder')
    showModal(action === 'new-child-note' ? 'new-note' : 'new-folder', {
      parentId: menuItem.id,
    })
  else if (action === 'new-vault') {
    if (state.aiBusy) return notify('请先停止当前对话')
    showModal('new-vault')
  } else if (action === 'rename-vault')
    showModal('rename-vault', { value: vault().name })
  else if (action === 'delete-vault') {
    if (state.aiBusy) return notify('请先停止当前对话')
    showModal('delete', { vaultId: vault().id, name: vault().name })
  }  else if (action === 'delete-source') {
    const file =
      vault().items.find((item) => item.id === target.dataset.id) ||
      menuItem ||
      selected()
    if (!file || !isSource(file)) return
    state.menu = null
    showModal('delete', { id: file.id, name: file.name })
  } else if (action === 'set-source-view') {
    const btn = target.closest('[data-view]')
    const view = btn?.dataset.view
    if (view && ['image', 'text'].includes(view)) {
      state.sourceView = view
      render()
    }
  } else if (action === 'rename-item')
    showModal('rename', { id: menuItem.id, value: extractTitle(menuItem) })
  else if (action === 'move-item' || action === 'move-source') {
    const targetItem =
      vault().items.find((item) => item.id === target.dataset.id) ||
      menuItem ||
      selected()
    if (!targetItem) return
    state.menu = null
    showModal('move', { id: targetItem.id })
  }
  else if (action === 'delete-item') {
    const targetItem =
      vault().items.find((item) => item.id === target.dataset.id) ||
      menuItem ||
      selected()
    if (!targetItem) return
    state.menu = null
    showModal('delete', { id: targetItem.id, name: extractTitle(targetItem) })
  }
  else if (action === 'download-note') {
    download(
      new Blob([menuItem.content], { type: 'text/markdown;charset=utf-8' }),
      menuItem.name,
    )
    state.menu = null
    render()
  } else if (action === 'settings') showModal('settings')
  else if (action === 'toggle-web-search') {
    if (state.aiBusy) return notify('请先停止当前生成')
    if (providerFor(database.settings) === 'compatible') {
      showModal('settings')
      return notify('请先选择支持搜索的原生接口协议')
    }
    database.settings.webSearch = !database.settings.webSearch
    save()
    render()
    if (database.settings.webSearch)
      notify('联网搜索已开启，可能产生额外费用；请勿搜索敏感内容')
  } else if (action === 'cycle-theme') {
    const current = database.settings.theme || 'system'
    const next =
      current === 'system' ? 'dark' : current === 'dark' ? 'light' : 'system'
    database.settings.theme = next
    applyTheme(next)
    save()
    render()
    const label =
      next === 'dark' ? '深色模式' : next === 'light' ? '浅色模式' : '跟随系统'
    notify(`外观主题已切换为${label}`)
  } else if (action === 'open-local-vault') {
    if (state.aiBusy) return notify('请先停止当前对话')
    if (!isLocalDirectoryAccessSupported()) {
      state.menu = null
      document.querySelector('#directory-input').click()
      render()
      return
    }
    state.menu = null
    render()
    try {
      const entry = await createLocalDirectoryVault()
      if (database.vaults.some((existing) => existing.name === entry.name))
        entry.name += ' 副本'
      database.vaults.push(entry)
      database.activeId = entry.id
      state.selectedId = entry.items[0]?.id || null
      state.search = ''
      state.aiDraft = ''
      state.attachments = []
      save()
      render()
      notifyLocalVaultCreated(entry)
    } catch (err) {
      if (err.name !== 'AbortError') {
        notify(`打开本地文件夹失败: ${err.message}`)
      }
    }
  } else if (action === 'sync-local-vault') {
    await refreshLocalWorkspace(true)
  } else if (action === 'keep-conflict-copy') {
    try {
      const targetVault = vault()
      await reconnectLocalVault(targetVault)
      const id = await keepLocalConflictCopy(targetVault, target.dataset.id)
      if (vault().id === targetVault.id) state.selectedId = id
      save()
      render()
      notify('工作区修改已另存副本，本地原文件未覆盖')
    } catch (error) {
      notify(error.message)
      updateLocalNotice()
    }
  } else if (action === 'close-modal') {
    if (dialogSubmitting) return
    state.modal = null
    render()
  } else if (action === 'toggle-key') {
    const input = document.querySelector('[name="apiKey"]')
    input.type = input.type === 'password' ? 'text' : 'password'
    target.innerHTML = icon(
      input.type === 'password' ? 'visibility' : 'visibility_off',
    )
  } else if (action === 'connections') showModal('connections')
  else if (action === 'notes') {
    state.page = 'note'
    state.search = ''
    state.sidebarOpen = false
    render()
  } else if (action === 'graph') {
    state.page = 'graph'
    state.sidebarOpen = false
    state.modal = null
    render()
  } else if (action === 'open-sidebar' || action === 'close-sidebar') {
    state.sidebarOpen = action === 'open-sidebar'
    render()
  } else if (action === 'clear-search') {
    state.search = ''
    render()
    document.querySelector('#note-search')?.focus()
  } else if (action === 'toggle-ai' || action === 'close-ai') {
    state.aiOpen = action === 'toggle-ai' ? !state.aiOpen : false
    render()
  } else if (action === 'stop-ai') state.abort?.abort()
  else if (action === 'attach-files')
    document.querySelector('#attachment-input').click()
  else if (action === 'clear-chat') {
    if (state.aiBusy) return notify('请先停止当前生成')
    await deleteConversationAttachments(history())
    database.conversations[vault().id] = []
    state.aiText = ''
    state.aiTools = []
    state.attachments = []
    save()
    render()
  } else if (action === 'copy-link') {
    try {
      await navigator.clipboard.writeText(`[[${extractTitle(selected())}]]`)
      notify('双链已复制')
    } catch {
      notify('浏览器不允许访问剪贴板')
    }
  } else if (action === 'export') {
    state.menu = null
    render()
    const blob = await exportVault(vault())
    download(blob, `${vault().name}.zip`)
    notify('知识库已导出')
  } else if (action === 'import') {
    if (state.aiBusy) return notify('请先停止当前对话')
    state.menu = null
    render()
    document.querySelector('#import-input').click()
  }
}

app.addEventListener('click', async (event) => {
  const target = event.target.closest(
    'button, [data-note-link], [data-select], [data-folder], [data-wiki-suggest-idx], [data-code-copy]',
  )
  if (event.target.classList.contains('modal-backdrop')) {
    if (dialogSubmitting) return
    state.modal = null
    render()
    return
  }
  const suggestItem = event.target.closest('[data-wiki-suggest-idx]')
  if (suggestItem) {
    event.preventDefault()
    selectWikiSuggestItem(Number(suggestItem.dataset.wikiSuggestIdx))
    return
  }
  const copyBtn = event.target.closest('[data-code-copy]')
  if (copyBtn) {
    event.preventDefault()
    const wrapper = copyBtn.closest('.code-block-wrapper')
    const code = wrapper?.querySelector('code')
    if (code) {
      try {
        await navigator.clipboard.writeText(code.textContent)
        copyBtn.classList.add('copied')
        copyBtn.innerHTML = `${icon('check')}<span>已复制</span>`
        setTimeout(() => {
          copyBtn.classList.remove('copied')
          copyBtn.innerHTML = `${icon('content_copy')}<span>复制</span>`
        }, 1800)
      } catch {
        notify('复制失败，请手动选择复制')
      }
    }
    return
  }
  if (
    !event.target.closest('.wikilink-suggest-menu') &&
    state.wikiSuggest?.open
  ) {
    state.wikiSuggest.open = false
    document.querySelector('.wikilink-suggest-menu')?.remove()
  }
  if (!target) return
  if (
    target.closest('.markdown-body') &&
    !target.hasAttribute('data-note-link') &&
    !target.hasAttribute('data-code-copy')
  )
    return
  try {
    if (target.dataset.action) {
      event.preventDefault()
      await handleAction(target.dataset.action, target)
    } else if (target.dataset.removeAttachment) {
      state.attachments = state.attachments.filter(
        (attachment) => attachment.id !== target.dataset.removeAttachment,
      )
      render()
    } else if (target.dataset.select) selectFile(target.dataset.select)
    else if (target.dataset.folder) {
      const id = target.dataset.folder
      state.activeFolderId = id
      state.collapsed.has(id)
        ? state.collapsed.delete(id)
        : state.collapsed.add(id)
      render()
    } else if (target.dataset.itemMenu)
      showItemMenu(target.dataset.itemMenu, target)
    else if (target.dataset.mode) {
      if (isSource(selected())) return
      state.mode = target.dataset.mode
      render()
      document.querySelector('#markdown-editor')?.focus()
    } else if (target.dataset.vault) {
      if (state.aiBusy) return notify('请先停止当前对话')
      database.activeId = target.dataset.vault
      state.selectedId = database.selections?.[database.activeId]
      state.activeFolderId = null
      state.menu = null
      state.page = 'note'
      state.search = ''
      state.aiDraft = ''
      state.attachments = []
      state.collapsed.clear()
      save()
      render()
      void refreshLocalWorkspace()
    } else if (target.dataset.noteLink !== undefined) {
      event.preventDefault()
      const raw = target.dataset.noteLink
      const file = resolveWikiLink(raw, vault().items, selected()?.id)
      if (file) {
        selectFile(file.id)
        const heading = raw.split('#')[1]
        if (heading) {
          const node = [
            ...document.querySelectorAll(
              '.markdown-body :is(h1,h2,h3,h4,h5,h6)',
            ),
          ].find(
            (node) => node.textContent.trim() === decodeURIComponent(heading),
          )
          node?.scrollIntoView({ block: 'start', behavior: 'smooth' })
        }
      } else
        showModal('new-note', {
          value: raw.split('#')[0].split('/').pop(),
          parentId: selected()?.parentId || null,
        })
    } else if (target.dataset.format) formatEditor(target.dataset.format)
    else if (target.dataset.prompt) await sendMessage(target.dataset.prompt)
  } catch (error) {
    notify(error.message)
  }
})

app.addEventListener('input', (event) => {
  if (event.target.closest('.markdown-body')) return
  if (event.target.id === 'note-search') {
    state.search = event.target.value
    const position = event.target.selectionStart
    render()
    const input = document.querySelector('#note-search')
    input.focus()
    input.setSelectionRange(position, position)
  } else if (event.target.id === 'markdown-editor') {
    const file = selected()
    if (!file || isSource(file)) return
    file.content = event.target.value
    file.updatedAt = new Date().toISOString()
    queueLocalWrite(vault(), file)
    save()
    updateWikiSuggest(event.target)
    const count = (file.content.match(/[\u3400-\u9fff]|[a-zA-Z0-9]+/g) || [])
      .length
    document.querySelector('#word-count').textContent = `${count} 字`
    clearTimeout(previewTimer)
    previewTimer = setTimeout(() => {
      const preview = document.querySelector('#markdown-preview')
      if (preview)
        preview.innerHTML = renderMarkdown(file.content, vault().items, file.id)
    }, 150)
    clearTimeout(graphRefreshTimer)
    graphRefreshTimer = setTimeout(() => {
      const rail = document.querySelector('.context-rail')
      if (rail) rail.innerHTML = connectionContent()
    }, 650)
  } else if (event.target.id === 'ai-input') state.aiDraft = event.target.value
  else if (event.target.id === 'graph-search') {
    state.graphQuery = event.target.value
    document
      .querySelectorAll('.full-graph .graph-point')
      .forEach((node) =>
        node.classList.toggle(
          'dimmed',
          !!state.graphQuery &&
            !node.textContent
              .toLowerCase()
              .includes(state.graphQuery.toLowerCase()),
        ),
      )
  }
})

app.addEventListener('change', (event) => {
  if (event.target.closest('.markdown-body')) return
  if (
    event.target.name === 'provider' &&
    event.target.closest('#dialog-form')
  ) {
    const form = event.target.form
    const preset = PROVIDERS[event.target.value]
    form.elements.endpoint.value = preset.endpoint
    form.elements.model.value = preset.model
    form.elements.apiKey.value = ''
    form.elements.webSearch.disabled = event.target.value === 'compatible'
    if (form.elements.webSearch.disabled)
      form.elements.webSearch.checked = false
  }
  if (event.target.id === 'new-vault-mode') {
    const isLocal = event.target.value === 'local'
    state.modal.storageMode = event.target.value
    const nameWrap = document.querySelector('#new-vault-name-wrap')
    const tip = document.querySelector('#new-vault-local-tip')
    nameWrap.hidden = isLocal
    const nameInput = nameWrap.querySelector('input')
    nameInput.disabled = isLocal
    nameInput.required = !isLocal
    tip.hidden = !isLocal
    const submit = document.querySelector('#dialog-form button[type="submit"]')
    submit.textContent = isLocal ? '选择文件夹' : '创建知识库'
    submit.disabled = false
  }
  if (event.target.id === 'hide-isolated') {
    state.hideIsolated = event.target.checked
    render()
  }
})

app.addEventListener('submit', async (event) => {
  event.preventDefault()
  if (event.target.id === 'ai-form') {
    await sendMessage()
    return
  }
  if (event.target.id !== 'dialog-form' || dialogSubmitting) return
  const formElement = event.target
  const form = new FormData(event.target)
  const modal = state.modal
  dialogSubmitting = true
  const submit = formElement.querySelector('button[type="submit"]')
  if (submit) submit.disabled = true
  try {
    if (modal.type === 'settings') {
      const endpoint = form.get('endpoint').trim()
      const url = new URL(endpoint)
      if (!['http:', 'https:'].includes(url.protocol))
        throw new Error('请输入有效的 HTTP 或 HTTPS 接口')
      const theme = form.get('theme') || 'system'
      database.settings = {
        theme,
        provider: form.get('provider'),
        webSearch: form.get('webSearch') === 'on',
        endpoint,
        apiKey: form.get('apiKey').trim(),
        model: form.get('model').trim(),
      }
      applyTheme(theme)
    } else if (modal.type === 'new-note' || modal.type === 'new-folder') {
      const type = modal.type === 'new-note' ? 'file' : 'folder'
      const name = form.get('name').trim()
      const item = await createWorkspaceItem(
        vault(),
        type,
        name,
        form.get('parentId') || null,
        `# ${name.replace(/\.md$/i, '')}\n\n`,
      )
      if (type === 'file') {
        state.selectedId = item.id
        state.mode = 'edit'
        state.page = 'note'
        state.sidebarOpen = false
      }
      if (item.parentId) state.collapsed.delete(item.parentId)
    } else if (modal.type === 'new-vault') {
      const storageMode = form.get('storageMode') || 'browser'
      if (storageMode === 'local') {
        if (!isLocalDirectoryAccessSupported()) {
          state.modal = null
          document.querySelector('#directory-input').click()
          render()
          return
        }
        state.modal = null
        render()
        try {
          const entry = await createLocalDirectoryVault()
          if (database.vaults.some((existing) => existing.name === entry.name))
            entry.name += ' 副本'
          database.vaults.push(entry)
          database.activeId = entry.id
          state.selectedId = entry.items[0]?.id || null
          state.search = ''
          state.aiDraft = ''
          state.attachments = []
          save()
          render()
          notifyLocalVaultCreated(entry)
        } catch (err) {
          if (err.name !== 'AbortError') {
            notify(`连接本地文件夹失败 ${err.message}`)
          }
        }
        return
      }
      const name = form.get('name').trim()
      if (!name) throw new Error('请输入知识库名称')
      const entry = {
        id: makeId(),
        name,
        storageType: 'browser',
        items: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      database.vaults.push(entry)
      database.activeId = entry.id
      state.selectedId = null
      state.search = ''
      state.aiDraft = ''
      state.attachments = []
    } else if (modal.type === 'rename-vault') {
      const name = form.get('name').trim()
      if (!name) throw new Error('请输入知识库名称')
      vault().name = name
    } else if (modal.type === 'rename') {
      await updateLocation(vault(), modal.id, { name: form.get('name') })
    } else if (modal.type === 'move')
      await updateLocation(vault(), modal.id, {
        parentId: form.get('parentId') || null,
      })
    else if (modal.type === 'delete') {
      if (modal.vaultId) {
        const removed = database.vaults.find(
          (entry) => entry.id === modal.vaultId,
        )
        if (removed?.storageType === 'local') {
          if (removed.items.some((item) => item.localConflict))
            throw new Error('请先处理冲突或导出备份，再移除此连接')
          await flushLocalWrites(removed)
        }
        await deleteConversationAttachments(
          database.conversations[modal.vaultId] || [],
        )
        await removeVaultHandle(modal.vaultId)
        database.vaults = database.vaults.filter(
          (entry) => entry.id !== modal.vaultId,
        )
        delete database.conversations[modal.vaultId]
        database.activeId = database.vaults[0].id
        state.selectedId = null
        state.search = ''
        state.attachments = []
      } else {
        const targetVault = vault()
        await flushLocalWrites(targetVault)
        revokeSourceBlobUrl(modal.id)
        await deleteWorkspaceItem(targetVault, modal.id)
        if (state.selectedId === modal.id) {
          const remaining = targetVault.items.filter(
            (entry) => entry.type === 'file',
          )
          state.selectedId = remaining[0]?.id || null
          database.selections ||= {}
          database.selections[targetVault.id] = state.selectedId
        }
      }
    }
    const saved = save()
    if (!saved) {
      document.querySelector('.form-error').textContent =
        '保存失败，请先导出数据备份'
      return
    }
    state.modal = null
    render()
    if (modal.type === 'new-note')
      document.querySelector('#markdown-editor')?.focus()
    if (modal.type === 'settings') notify('设置已保存')
  } catch (error) {
    const field = document.querySelector('.form-error')
    if (field) field.textContent = error.message
    else notify(error.message)
    updateLocalNotice()
    save()
  } finally {
    dialogSubmitting = false
    if (submit?.isConnected) submit.disabled = false
  }
})

function formatEditor(format) {
  const editor = document.querySelector('#markdown-editor')
  if (!editor) return
  const { selectionStart: start, selectionEnd: end } = editor
  const text = editor.value.slice(start, end)
  const formats = {
    heading: [`## ${text || '标题'}`, 3],
    bold: [`**${text || '重点'}**`, 2],
    italic: [`*${text || '文本'}*`, 1],
    list: [`- ${text || '列表内容'}`, 2],
    task: [`- [ ] ${text || '待办事项'}`, 6],
    quote: [`> ${text || '引用内容'}`, 2],
    code: [`\n\`\`\`\n${text || '代码'}\n\`\`\`\n`, 5],
    link: [`[[${text || '笔记名称'}]]`, 2],
  }
  const [value, offset] = formats[format]
  editor.setRangeText(value, start, end, 'end')
  editor.focus()
  editor.setSelectionRange(
    start + offset,
    start +
      value.length -
      (format === 'bold' || format === 'link'
        ? 2
        : format === 'italic'
          ? 1
          : 0),
  )
  editor.dispatchEvent(new Event('input', { bubbles: true }))
}

function getCaretPosition(textarea) {
  const value = textarea.value.slice(0, textarea.selectionStart)
  const lines = value.split('\n')
  const lineNo = lines.length - 1
  const lineHeight = 24
  const charWidth = 8.5
  const currentLine = lines[lines.length - 1]
  const top = Math.min(
    lineNo * lineHeight + 36,
    Math.max(40, textarea.clientHeight - 180),
  )
  const left = Math.min(
    20 + currentLine.length * charWidth,
    Math.max(20, textarea.clientWidth - 300),
  )
  return {
    x: Math.max(16, left),
    y: Math.max(16, top),
  }
}

function updateWikiSuggest(editor) {
  const cursor = editor.selectionStart
  const textBefore = editor.value.slice(0, cursor)
  const match = /(?:^|[^\\])\[\[([^\]\n\r]*)$/.exec(textBefore)
  if (!match) {
    if (state.wikiSuggest.open) {
      state.wikiSuggest.open = false
      document.querySelector('.wikilink-suggest-menu')?.remove()
    }
    return
  }

  const query = match[1].toLowerCase().trim()
  const matchStart = cursor - match[1].length - 2
  const candidateFiles = files().filter((file) => file.id !== selected()?.id)

  const matches = candidateFiles
    .filter((file) => {
      if (!query) return true
      const title = extractTitle(file).toLowerCase()
      const path = itemPath(vault(), file).toLowerCase()
      return title.includes(query) || path.includes(query)
    })
    .sort((a, b) => {
      const aTitle = extractTitle(a).toLowerCase()
      const bTitle = extractTitle(b).toLowerCase()
      if (query) {
        if (aTitle.startsWith(query) && !bTitle.startsWith(query)) return -1
        if (!aTitle.startsWith(query) && bTitle.startsWith(query)) return 1
      }
      return aTitle.localeCompare(bTitle, 'zh-CN')
    })
    .slice(0, 8)

  if (!matches.length) {
    state.wikiSuggest.open = false
    document.querySelector('.wikilink-suggest-menu')?.remove()
    return
  }

  const pos = getCaretPosition(editor)
  state.wikiSuggest = {
    open: true,
    query,
    start: matchStart,
    end: cursor,
    index: 0,
    items: matches,
    x: pos.x,
    y: pos.y,
  }

  const container = editor.parentElement
  if (!container) return
  let menu = container.querySelector('.wikilink-suggest-menu')
  if (!menu) {
    menu = document.createElement('div')
    menu.className = 'wikilink-suggest-menu'
    container.appendChild(menu)
  }
  menu.style.left = `${pos.x}px`
  menu.style.top = `${pos.y}px`
  menu.innerHTML = matches
    .map(
      (file, idx) =>
        `<div class="wikilink-suggest-item ${idx === 0 ? 'active' : ''}" data-wiki-suggest-idx="${idx}">
          ${icon('article')}
          <span class="suggest-title">${escape(extractTitle(file))}</span>
          <span class="suggest-path">${escape(itemPath(vault(), file))}</span>
        </div>`,
    )
    .join('')
}

function updateWikiSuggestActive() {
  const items = document.querySelectorAll('.wikilink-suggest-item')
  items.forEach((item, idx) => {
    item.classList.toggle('active', idx === state.wikiSuggest.index)
    if (idx === state.wikiSuggest.index) {
      item.scrollIntoView({ block: 'nearest' })
    }
  })
}

function selectWikiSuggestItem(idx) {
  const item = state.wikiSuggest.items[idx]
  if (!item) return
  const editor = document.querySelector('#markdown-editor')
  if (!editor) return

  const before = editor.value.slice(0, state.wikiSuggest.start)
  const after = editor.value.slice(state.wikiSuggest.end)
  const hasClosing = after.startsWith(']]')
  const inserted = `[[${extractTitle(item)}]]`
  const nextAfter = hasClosing ? after.slice(2) : after

  editor.value = before + inserted + nextAfter
  const newPos = before.length + inserted.length
  editor.setSelectionRange(newPos, newPos)
  editor.focus()

  state.wikiSuggest.open = false
  document.querySelector('.wikilink-suggest-menu')?.remove()
  editor.dispatchEvent(new Event('input', { bubbles: true }))
}

app.addEventListener('keydown', (event) => {
  if (
    event.target.id === 'ai-input' &&
    event.key === 'Enter' &&
    !event.shiftKey &&
    !event.isComposing
  ) {
    event.preventDefault()
    sendMessage()
  }
  if (event.target.id === 'markdown-editor') {
    if (event.key === '[') {
      const pos = event.target.selectionStart
      if (pos > 0 && event.target.value[pos - 1] === '[') {
        event.preventDefault()
        event.target.setRangeText('[]]', pos, pos, 'end')
        event.target.setSelectionRange(pos, pos)
        event.target.dispatchEvent(new Event('input', { bubbles: true }))
        return
      }
    }
    if (state.wikiSuggest?.open && state.wikiSuggest.items.length) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        state.wikiSuggest.index =
          (state.wikiSuggest.index + 1) % state.wikiSuggest.items.length
        updateWikiSuggestActive()
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        state.wikiSuggest.index =
          (state.wikiSuggest.index - 1 + state.wikiSuggest.items.length) %
          state.wikiSuggest.items.length
        updateWikiSuggestActive()
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        selectWikiSuggestItem(state.wikiSuggest.index)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        state.wikiSuggest.open = false
        document.querySelector('.wikilink-suggest-menu')?.remove()
        return
      }
    }
    if (event.key === 'Tab') {
      event.preventDefault()
      event.target.setRangeText(
        '  ',
        event.target.selectionStart,
        event.target.selectionEnd,
        'end',
      )
      event.target.dispatchEvent(new Event('input', { bubbles: true }))
    }
  }
  if (
    event.target.classList.contains('graph-point') &&
    ['Enter', ' '].includes(event.key)
  ) {
    event.preventDefault()
    selectFile(event.target.dataset.select)
  }
})

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (dialogSubmitting) return
    state.modal = null
    state.menu = null
    state.sidebarOpen = false
    render()
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    state.sidebarOpen = true
    render()
    document.querySelector('#note-search').focus()
  }
  if (state.modal && event.key === 'Tab') {
    const focusable = [
      ...document.querySelectorAll(
        '.dialog button, .dialog input, .dialog select, .dialog textarea, .dialog a',
      ),
    ].filter(
      (node) => !node.disabled && !node.hidden && node.getClientRects().length,
    )
    const first = focusable[0],
      last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last?.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first?.focus()
    }
  }
})

let dragTargetRow = null

app.addEventListener('dragstart', (event) => {
  const row = event.target.closest('[data-tree-id]')
  if (row) {
    const item = vault().items.find((entry) => entry.id === row.dataset.treeId)
    if (item?.type === 'folder' && containsSource(vault(), row.dataset.treeId))
      return event.preventDefault()
    event.dataTransfer.setData('application/x-zhiku-tree-id', row.dataset.treeId)
    event.dataTransfer.setData('text/plain', row.dataset.treeId)
    event.dataTransfer.effectAllowed = 'move'
  }
})
app.addEventListener('dragover', (event) => {
  const isFiles = event.dataTransfer.types.includes('Files')
  if (isFiles) {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    const row = event.target.closest('[data-tree-id]')
    const rowItem = row
      ? vault().items.find((item) => item.id === row.dataset.treeId)
      : null
    const targetRow =
      rowItem?.type === 'folder'
        ? row
        : rowItem?.type === 'file' && rowItem.parentId
          ? document.querySelector(`[data-tree-id="${rowItem.parentId}"]`)
          : null
    if (dragTargetRow !== targetRow) {
      if (dragTargetRow) dragTargetRow.classList.remove('drag-target')
      dragTargetRow = targetRow
      if (dragTargetRow) dragTargetRow.classList.add('drag-target')
    }
    return
  }
  const row = event.target.closest('[data-tree-id]')
  const rowItem = row
    ? vault().items.find((item) => item.id === row.dataset.treeId)
    : null
  if (
    rowItem?.type === 'folder' ||
    event.target.hasAttribute('data-drop-root') ||
    event.target.closest('[data-drop-root]')
  ) {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const targetRow = rowItem?.type === 'folder' ? row : null
    if (dragTargetRow !== targetRow) {
      if (dragTargetRow) dragTargetRow.classList.remove('drag-target')
      dragTargetRow = targetRow
      if (dragTargetRow) dragTargetRow.classList.add('drag-target')
    }
  } else if (dragTargetRow) {
    dragTargetRow.classList.remove('drag-target')
    dragTargetRow = null
  }
})
app.addEventListener('dragleave', (event) => {
  if (!event.relatedTarget || !app.contains(event.relatedTarget)) {
    if (dragTargetRow) {
      dragTargetRow.classList.remove('drag-target')
      dragTargetRow = null
    }
  }
})
app.addEventListener('dragend', () => {
  if (dragTargetRow) {
    dragTargetRow.classList.remove('drag-target')
    dragTargetRow = null
  }
})
app.addEventListener('drop', async (event) => {
  event.preventDefault()
  if (dragTargetRow) {
    dragTargetRow.classList.remove('drag-target')
    dragTargetRow = null
  }
  const isFiles =
    event.dataTransfer.types.includes('Files') &&
    event.dataTransfer.files &&
    event.dataTransfer.files.length > 0

  if (isFiles) {
    const chosen = [...event.dataTransfer.files]
    if (!chosen.length) return
    const row = event.target.closest('[data-tree-id]')
    const rowItem = row
      ? vault().items.find((item) => item.id === row.dataset.treeId)
      : null
    let targetFolderId = null
    if (rowItem?.type === 'folder') {
      targetFolderId = rowItem.id
    } else if (rowItem?.type === 'file') {
      targetFolderId = rowItem.parentId || null
    } else {
      targetFolderId = getCurrentFolderId()
    }
    await uploadDroppedFiles(chosen, targetFolderId)
    return
  }

  const treeId =
    event.dataTransfer.getData('application/x-zhiku-tree-id') ||
    event.dataTransfer.getData('text/plain')
  if (!treeId) return

  const row = event.target.closest('[data-tree-id]')
  let parentId = null
  if (row) {
    const targetItem = vault().items.find((item) => item.id === row.dataset.treeId)
    if (targetItem?.type === 'folder') {
      parentId = targetItem.id
    } else if (targetItem?.type === 'file') {
      parentId = targetItem.parentId || null
    } else {
      return
    }
  } else if (!event.target.closest('[data-drop-root]')) {
    return
  }

  try {
    await updateLocation(vault(), treeId, { parentId })
    if (parentId) state.collapsed.delete(parentId)
    save()
    render()
  } catch (error) {
    notify(error.message)
  }
})

window.addEventListener('dragover', (event) => {
  if (event.dataTransfer.types.includes('Files')) {
    event.preventDefault()
  }
})
window.addEventListener('drop', (event) => {
  if (event.dataTransfer.types.includes('Files')) {
    event.preventDefault()
  }
})

async function uploadDroppedFiles(files, parentId = null) {
  if (!files.length || state.importingSources) return
  const targetVault = vault()
  const failures = []
  let count = 0
  let firstId = null
  state.importingSources = true
  notify('正在导入文件，原件仅保存在本机')
  try {
    for (const file of files) {
      if (!database.vaults.includes(targetVault)) break
      try {
        if (NOTE_PATTERN.test(file.name)) {
          const content = await file.text()
          const item = await createWorkspaceItem(
            targetVault,
            'file',
            file.name,
            parentId,
            content,
          )
          firstId ||= item.id
          count++
        } else if (isDocumentName(file.name)) {
          const item = await importSourceFile(targetVault, file, parentId)
          firstId ||= item.id
          count++
        } else {
          failures.push(`${file.name} 不支持此文件格式`)
        }
      } catch (error) {
        failures.push(`${file.name} ${error.message}`)
      }
    }
    if (parentId) state.collapsed.delete(parentId)
    state.activeFolderId = parentId
    if (vault().id === targetVault.id && firstId) {
      state.selectedId = firstId
      state.mode = 'read'
      state.page = 'note'
      state.sidebarOpen = false
      const fmt = targetVault.items.find((item) => item.id === firstId)?.source?.format
      if (fmt && (isImageSource(fmt) || fmt === 'pdf')) {
        state.sourceView = 'image'
      } else {
        state.sourceView = 'text'
      }
      database.selections ||= {}
      database.selections[targetVault.id] = firstId
    }
    await saveDatabase(database)
    render()
    notify(
      failures.length
        ? `已导入 ${count} 份，${failures[0]}`
        : `已添加 ${count} 份资料`,
    )
  } catch (error) {
    notify(error.message)
  } finally {
    state.importingSources = false
  }
}

document.querySelector('#attachment-input').accept += ',' + DOCUMENT_ACCEPT
document.querySelector('#source-input').accept = DOCUMENT_ACCEPT + ',.md,.markdown,.txt'
document
  .querySelector('#source-input')
  .addEventListener('change', async (event) => {
    const chosen = [...event.target.files]
    event.target.value = ''
    if (!chosen.length || state.importingSources) return
    const parentId = getCurrentFolderId()
    await uploadDroppedFiles(chosen, parentId)
  })

document
  .querySelector('#directory-input')
  .addEventListener('change', async (event) => {
    const files = [...event.target.files]
    event.target.value = ''
    if (!files.length) return
    if (state.aiBusy) return notify('请先停止当前对话')
    try {
      activateImportedVault(await createDirectorySnapshot(files))
    } catch (error) {
      notify(`文件夹导入失败：${error.message}`)
    }
  })

document.querySelector('#import-input').accept = '.zip,.zhiku,.json'
document
  .querySelector('#import-input')
  .addEventListener('change', async (event) => {
    const file = event.target.files[0]
    event.target.value = ''
    if (!file) return
    try {
      const entry = await importVault(file)
      if (database.vaults.some((existing) => existing.name === entry.name))
        entry.name += ' 副本'
      database.vaults.push(entry)
      database.activeId = entry.id
      state.selectedId = null
      state.search = ''
      state.page = 'note'
      state.aiDraft = ''
      if (save()) notify('知识库已导入')
      render()
    } catch (error) {
      notify(`导入失败 ${error.message}`)
    }
  })

async function updateLocation(targetVault, id, change) {
  if (Object.hasOwn(change, 'name')) assertMutableItem(targetVault, id)
  await flushLocalWrites(targetVault)
  const commit = () => {
    const references = targetVault.items
      .filter((file) => file.type === 'file' && !isSource(file))
      .map((file) => ({
        file,
        links: listNoteLinks(file.content)
          .map((link) => ({
            ...link,
            file: resolveWikiLink(link.target, targetVault.items, file.id),
          }))
          .filter((link) => link.file),
      }))
    if (Object.hasOwn(change, 'name')) renameItem(targetVault, id, change.name)
    else moveItem(targetVault, id, change.parentId)
    for (const { file, links } of references) {
      for (const link of links.reverse()) {
        if (
          resolveWikiLink(link.target, targetVault.items, file.id)?.id ===
          link.file.id
        )
          continue
        const anchorIndex = link.target.indexOf('#')
        const anchor = anchorIndex < 0 ? '' : link.target.slice(anchorIndex)
        let path = extractTitle(link.file)
        if (
          resolveWikiLink(path, targetVault.items, file.id)?.id !== link.file.id
        )
          path = itemPath(targetVault, link.file).replace(/\.md$/i, '')
        if (/\.md(?:#|$)/i.test(link.target)) path = encodeURI(path + '.md')
        file.content =
          file.content.slice(0, link.start) +
          path +
          anchor +
          file.content.slice(link.end)
        file.updatedAt = new Date().toISOString()
        queueLocalWrite(targetVault, file)
      }
    }
  }
  if (targetVault.storageType === 'local') {
    const draft = structuredClone(targetVault)
    if (Object.hasOwn(change, 'name')) renameItem(draft, id, change.name)
    else moveItem(draft, id, change.parentId)
    await relocateItemOnDisk(targetVault, id, draft, commit)
    await flushLocalWrites(targetVault)
  } else commit()
}

async function executeTool(targetVault, name, args) {
  const find = () => {
    const item = targetVault.items.find((item) => item.id === args.id)
    if (!item) throw new Error('文件不存在')
    return item
  }
  const summary = (item) => knowledgeSummary(targetVault, item)
  if (name === 'list_files') return targetVault.items.map(summary)
  if (name === 'read_file') {
    const result = await readKnowledgeFile(targetVault, args)
    await saveDatabase(database)
    return result
  }
  if (name === 'search_files') {
    const result = await searchKnowledgeFiles(
      targetVault,
      args.query,
      state.abort?.signal,
    )
    await saveDatabase(database)
    return result
  }
  if (['update_file', 'rename_item', 'delete_item'].includes(name))
    assertMutableItem(targetVault, args.id)
  let result
  if (name === 'create_file') {
    if (typeof args.content !== 'string') throw new Error('笔记内容必须为文本')
    const item = await createWorkspaceItem(
      targetVault,
      'file',
      args.name,
      args.parentId || null,
      args.content,
    )
    result = summary(item)
  } else if (name === 'create_folder') {
    const item = await createWorkspaceItem(
      targetVault,
      'folder',
      args.name,
      args.parentId || null,
    )
    result = summary(item)
  } else if (name === 'update_file') {
    const file = find()
    if (file.type !== 'file' || typeof args.content !== 'string')
      throw new Error('目标或笔记内容不正确')
    file.content = args.content
    file.updatedAt = new Date().toISOString()
    if (targetVault.storageType === 'local') {
      file.localDirty = true
      try {
        await writeItemToDisk(targetVault, file)
      } finally {
        await saveDatabase(database)
        updateLocalNotice()
      }
    }
    result = summary(file)
  } else if (name === 'rename_item') {
    await updateLocation(targetVault, args.id, { name: args.name })
    result = summary(find())
  } else if (name === 'move_item') {
    await updateLocation(targetVault, args.id, { parentId: args.parentId })
    result = summary(find())
  } else if (name === 'delete_item') {
    const item = find()
    if (
      !window.confirm(`知识助手请求删除「${item.name}」及其子内容，是否允许？`)
    )
      return { error: '用户拒绝删除' }
    await flushLocalWrites(targetVault)
    await deleteWorkspaceItem(targetVault, args.id)
    result = { deleted: args.id }
  } else throw new Error('不支持此工具')
  targetVault.updatedAt = new Date().toISOString()
  await saveDatabase(database)
  return result
}

document
  .querySelector('#attachment-input')
  .addEventListener('change', async (event) => {
    const chosen = [...event.target.files]
    event.target.value = ''
    if (!chosen.length) return
    if (state.attachments.length + chosen.length > 8)
      return notify('每次最多添加 8 个附件')
    const vaultId = vault().id
    state.readingAttachments = true
    render()
    try {
      for (const file of chosen) {
        const attachment = await prepareAttachment(file)
        if (vault().id !== vaultId) break
        state.attachments.push(attachment)
      }
    } catch (error) {
      notify(error.message)
    } finally {
      state.readingAttachments = false
      render()
    }
  })

async function sendMessage(prompt) {
  if (state.aiBusy || state.readingAttachments) return
  const text = (prompt || state.aiDraft).trim()
  if (!text && !state.attachments.length) return
  if (
    !database.settings.model ||
    !database.settings.endpoint ||
    missingApiKey()
  ) {
    state.aiDraft = text
    showModal('settings')
    notify('请先连接模型后开始对话')
    return
  }
  const targetVault = vault()
  const pending = state.attachments
  state.aiBusy = true
  state.abort = new AbortController()
  let attachments
  try {
    attachments = await storeAttachments(pending)
  } catch (error) {
    state.aiBusy = false
    state.abort = null
    notify(error.message)
    return
  }
  const userMessage = {
    role: 'user',
    content: text,
    ...(attachments.length ? { attachments } : {}),
  }
  const messages = [...history(), userMessage]
  database.conversations ||= {}
  database.conversations[targetVault.id] = messages
  state.aiText = ''
  state.aiTools = []
  state.aiSearches = []
  state.aiDraft = ''
  state.attachments = []
  state.aiOpen = true
  if (!save()) {
    database.conversations[targetVault.id] = messages.slice(0, -1)
    state.aiBusy = false
    state.abort = null
    state.aiDraft = text
    state.attachments = pending
    await deleteConversationAttachments([userMessage])
    render()
    return
  }
  render()
  const refreshMessages = () => {
    const container = document.querySelector('#ai-messages')
    if (container) {
      const atEnd =
        container.scrollHeight - container.scrollTop - container.clientHeight <
        90
      container.innerHTML = aiMessagesMarkup()
      void fillAttachmentPreviews(container)
      if (atEnd) container.scrollTop = container.scrollHeight
    }
  }
  let roundStart = 0
  try {
    const result = await runAgent({
      settings: database.settings,
      messages,
      workspaceName: targetVault.name,
      currentFile: selected()
        ? { id: selected().id, name: selected().name }
        : null,
      signal: state.abort.signal,
      executeTool: (name, args) => executeTool(targetVault, name, args),
      resolveMessages: resolveAttachmentMessages,
      onEvent: (event) => {
        if (event.type === 'text') state.aiText += event.content
        if (event.type === 'round') {
          if (state.aiText) state.aiText += '\n\n'
          roundStart = state.aiText.length
        }
        if (event.type === 'answer')
          state.aiText = state.aiText.slice(0, roundStart) + event.content
        if (event.type === 'search') state.aiSearches.push(event.search)
        if (event.type === 'tool') {
          const last = state.aiTools.findLast(
            (tool) => tool.name === event.name && tool.status === 'running',
          )
          if (last && event.status !== 'running') Object.assign(last, event)
          else state.aiTools.push(event)
        }
        refreshMessages()
      },
    })
    database.conversations[targetVault.id] = result
  } catch (error) {
    const stopped = state.abort.signal.aborted
    const message = stopped
      ? '已停止生成。已经完成的笔记操作已保留。'
      : `请求未完成：${error.message}`
    database.conversations[targetVault.id] = [
      ...messages,
      ...state.aiSearches.map((search) => ({
        role: 'assistant',
        content: search.content,
        search,
      })),
      {
        role: 'assistant',
        content: `${state.aiText ? state.aiText + '\n\n' : ''}${message}`,
      },
    ]
  } finally {
    state.aiBusy = false
    state.abort = null
    state.aiText = ''
    state.aiSearches = []
    save()
    render()
    const container = document.querySelector('#ai-messages')
    if (container) container.scrollTop = container.scrollHeight
  }
}

window.addEventListener('beforeunload', (event) => {
  if (
    !state.saved ||
    state.aiBusy ||
    database.vaults.some(
      (entry) =>
        entry.storageType === 'local' &&
        entry.items.some((item) => item.localDirty || item.localConflict),
    )
  ) {
    event.preventDefault()
    event.returnValue = ''
  }
})
render()
void refreshLocalWorkspace()
setInterval(() => void refreshLocalWorkspace(), 4000)
window.addEventListener('focus', () => void refreshLocalWorkspace())
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void refreshLocalWorkspace()
})
