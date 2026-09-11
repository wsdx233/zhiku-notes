import {
  loadDatabase,
  saveDatabase,
  makeId,
  createItem,
  renameItem,
  moveItem,
  deleteItem,
  itemPath,
  exportVault,
  importVault,
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

const app = document.querySelector('#app')
let database
try {
  database = loadDatabase()
} catch (error) {
  app.textContent = error.message
  throw error
}
const state = {
  selectedId: database.selections?.[database.activeId] || 'welcome',
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
  aiDraft: '',
  abort: null,
  attachments: [],
  readingAttachments: false,
  graphQuery: '',
  hideIsolated: false,
  saved: true,
}
let previewTimer
let toastTimer
let graphRefreshTimer
const treeScrollPositions = new Map()

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

function save() {
  try {
    vault().updatedAt = new Date().toISOString()
    database.selections ||= {}
    database.selections[vault().id] = state.selectedId
    saveDatabase(database)
    state.saved = true
  } catch (error) {
    state.saved = false
    notify(error.message)
  }
  const status = document.querySelector('.save-status')
  if (status)
    status.innerHTML = `${icon(state.saved ? 'cloud_done' : 'error')}<span>${state.saved ? '已保存到本地' : '保存失败'}</span>`
  return state.saved
}

function ensureSelection() {
  if (!selected()) state.selectedId = files()[0]?.id || null
}

function selectFile(id) {
  if (!vault().items.some((item) => item.id === id && item.type === 'file'))
    return
  state.selectedId = id
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

function render() {
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
      <div class="work-area ${state.aiOpen ? 'with-ai' : ''}">
        <div class="workspace-content">${state.page === 'graph' ? renderGraph() : renderNote()}</div>
        ${state.aiOpen ? renderAi() : state.page === 'note' && selected() ? renderConnections() : ''}
      </div>
    </main>
    ${state.menu ? renderMenu() : ''}
    ${state.modal ? renderModal() : ''}
  </div>`
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
  if (state.modal) {
    requestAnimationFrame(() => {
      const input =
        document.querySelector('.dialog input:not([type="password"]), .dialog select') ||
        document.querySelector('.dialog button[type="submit"]') ||
        document.querySelector('.dialog button')
      input?.focus()
      if (input?.tagName === 'INPUT') input.select()
    })
  }
}

function renderSidebar() {
  return `<aside class="sidebar">
    <button class="new-note" data-action="new-note">${icon('add')}<span>新建笔记</span></button>
    <label class="search-box">${icon('search')}<input id="note-search" placeholder="搜索笔记" value="${escape(state.search)}" aria-label="搜索笔记" autocomplete="off">${state.search ? '<button class="clear-search" data-action="clear-search" aria-label="清空搜索">' + icon('close') + '</button>' : ''}</label>
    <nav class="main-nav" aria-label="知识库导航"><button class="nav-row ${state.page === 'note' ? 'active' : ''}" data-action="notes">${icon('description')}<span>所有笔记</span><span class="note-count">${files().length}</span></button><button class="nav-row ${state.page === 'graph' ? 'active' : ''}" data-action="graph">${icon('hub')}<span>关系图谱</span></button></nav>
    <div class="tree-heading"><span>${state.search ? '搜索结果' : '我的笔记'}</span>${iconButton('create_new_folder', 'new-folder', '新建文件夹')}</div>
    <div class="file-tree" data-drop-root="true" data-scroll-key="${escape(`${vault().id}:${state.search}`)}">${state.search ? renderSearchResults() : renderTree(null)}</div>
    <div class="sidebar-bottom"><button class="vault-switch" data-action="vault-menu" aria-label="切换知识库" aria-expanded="${state.menu?.type === 'vault'}"><span class="vault-initial">${escape(vault().name[0])}</span><span>${escape(vault().name)}</span>${icon('unfold_more')}</button>${iconButton('settings', 'settings', '设置', 'sidebar-settings')}</div>
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
        return `<div class="tree-branch"><div class="tree-row ${isFolder ? 'folder-row' : 'note-row'} ${item.id === state.selectedId && state.page === 'note' ? 'selected' : ''}" style="--depth:${Math.min(depth, 8)}" data-tree-id="${item.id}" draggable="true">
      <button class="tree-open" ${isFolder ? `data-folder="${item.id}" aria-expanded="${!closed}"` : `data-select="${item.id}"`} title="${escape(item.name)}">${isFolder ? icon(closed ? 'chevron_right' : 'expand_more', 'chevron') + icon('folder', 'folder-icon') : icon('article', 'file-icon')}<span>${escape(extractTitle(item))}</span></button>
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
            `<button class="search-result ${file.id === state.selectedId ? 'selected' : ''}" data-select="${file.id}">${icon('article')}<span>${escape(extractTitle(file))}<span class="search-path">${escape(itemPath(vault(), file))}</span></span></button>`,
        )
        .join('')
    : `<div class="tree-empty">${icon('search_off')}<span>没有找到相关笔记</span></div>`
}

function renderTopbar() {
  const file = selected()
  const parent = vault().items.find((item) => item.id === file?.parentId)
  return `<header class="topbar"><div class="breadcrumbs">${iconButton('menu', 'open-sidebar', '打开导航', 'mobile-only')}<span class="breadcrumb-parent">${escape(state.page === 'graph' ? vault().name : parent?.name || vault().name)}</span>${icon('chevron_right', 'breadcrumb-arrow')}<span class="breadcrumb-current">${escape(state.page === 'graph' ? '关系图谱' : extractTitle(file || { name: '所有笔记' }))}</span></div><div class="top-actions"><span class="save-status">${icon(state.saved ? 'cloud_done' : 'error')}<span>${state.saved ? '已保存到本地' : '保存失败'}</span></span><button class="ai-toggle ${state.aiOpen ? 'active' : ''}" data-action="toggle-ai">${icon('auto_awesome')}<span>知识助手</span></button></div></header>`
}

function renderNote() {
  const file = selected()
  if (!file)
    return `<section class="empty-state"><div class="empty-symbol">${icon('edit_note')}</div><h1>给想法一个家</h1><p>新建一篇笔记，开始连接你的知识</p><button class="new-note" data-action="new-note">${icon('add')}<span>新建笔记</span></button></section>`
  const wordCount = (file.content.match(/[\u3400-\u9fff]|[a-zA-Z0-9]+/g) || [])
    .length
  return `<section class="note-workspace">
    <div class="note-toolbar"><div class="view-switch" aria-label="编辑模式"><button class="${state.mode === 'read' ? 'active' : ''}" data-mode="read">${icon('chrome_reader_mode')}<span>阅读</span></button><button class="${state.mode === 'edit' ? 'active' : ''}" data-mode="edit">${icon('edit_note')}<span>编辑</span></button><button class="${state.mode === 'split' ? 'active' : ''} split-mode" data-mode="split" aria-label="分栏编辑" title="分栏编辑">${icon('vertical_split')}</button></div><div class="note-toolbar-right">${iconButton('link', 'copy-link', '复制双链')}${iconButton('more_horiz', 'note-menu', '笔记操作')}</div></div>
    ${state.mode !== 'read' ? renderFormatting() : ''}
    <div class="document-scroll ${state.mode === 'split' ? 'split-view' : ''}">
      ${state.mode !== 'read' ? `<textarea class="markdown-editor" id="markdown-editor" aria-label="Markdown 编辑器" spellcheck="false" placeholder="从一个想法开始">${escape(file.content)}</textarea>` : ''}
      ${state.mode !== 'edit' ? `<div class="document-page"><article class="markdown-body" id="markdown-preview">${renderMarkdown(file.content, vault().items, file.id)}</article></div>` : ''}
    </div>
    <footer class="note-status"><span>${icon('notes')}<span id="word-count">${wordCount} 字</span></span><span>${icon('update')}<span>编辑于 ${dateLabel(file.updatedAt)}</span></span><button class="mobile-links" data-action="connections">${icon('link')}<span>反向链接</span></button></footer>
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
  read_file: '阅读笔记',
  search_files: '查找知识',
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
      ['user', 'assistant'].includes(message.role) &&
      (message.content || message.attachments?.length),
  )
  if (!visible.length && !state.aiBusy)
    return `<div class="ai-intro"><div class="ai-symbol">${icon('auto_awesome')}</div><h2>让灵感<br>多一种可能</h2><p>阅读、整理、连接<br>和你的知识一起思考</p><div class="ai-suggestions"><button data-prompt="请阅读并总结当前笔记，提炼最重要的观点">${icon('summarize')}<span>总结当前笔记</span>${icon('arrow_outward')}</button><button data-prompt="浏览我的知识库，发现可以连接的知识，并说明理由">${icon('hub')}<span>发现知识之间的联系</span>${icon('arrow_outward')}</button><button data-prompt="根据当前笔记，为我创建一篇延伸主题的新笔记，并使用双链连接来源">${icon('edit_square')}<span>把灵感写成新笔记</span>${icon('arrow_outward')}</button></div>${!database.settings.apiKey && database.settings.endpoint.includes('api.openai.com') ? '<button class="connect-model" data-action="settings">连接你的模型 ' + icon('arrow_forward') + '</button>' : ''}</div>`
  return `${visible.map((message) => `<div class="chat-message ${message.role}">${message.role === 'assistant' ? '<div class="assistant-label">' + icon('auto_awesome') + '<span>知识助手</span></div>' : ''}<div class="markdown-body">${renderMarkdown(message.content || '', vault().items, selected()?.id)}</div>${renderSentAttachments(message.attachments || [])}</div>`).join('')}${state.aiBusy ? `<div class="chat-message assistant"><div class="assistant-label">${icon('auto_awesome', 'thinking')}<span>正在思考</span></div><div class="tool-activity">${state.aiTools.map((tool) => `<div>${icon(tool.status === 'running' ? 'progress_activity' : tool.status === 'error' ? 'error' : 'check_circle')}<span>${toolLabels[tool.name] || '执行操作'}</span></div>`).join('')}</div><div class="markdown-body live-answer">${renderMarkdown(state.aiText, vault().items, selected()?.id)}</div></div>` : ''}`
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
          <button type="button" class="icon-button attachment-button" data-action="attach-files" aria-label="添加附件" title="添加图片或文本附件" ${state.readingAttachments ? 'disabled' : ''}>${icon(state.readingAttachments ? 'progress_activity' : 'attach_file')}</button>
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
    return `${close}<div class="popup-menu vault-menu" role="menu"><h3>知识库</h3>${database.vaults.map((entry) => `<button data-vault="${entry.id}" class="menu-vault ${entry.id === vault().id ? 'active' : ''}"><span class="vault-initial">${escape(entry.name[0])}</span><span>${escape(entry.name)}</span>${entry.id === vault().id ? icon('check') : ''}</button>`).join('')}<div class="menu-divider"></div><button data-action="new-vault">${icon('add')}新建知识库</button><button data-action="rename-vault">${icon('drive_file_rename_outline')}重命名知识库</button><button data-action="export">${icon('download')}导出知识库</button><button data-action="import">${icon('upload')}导入知识库</button>${database.vaults.length > 1 ? '<button data-action="delete-vault" class="danger">' + icon('delete') + '删除知识库</button>' : ''}</div>`
  const item = vault().items.find((entry) => entry.id === state.menu.id)
  if (!item) return ''
  return `${close}<div class="popup-menu item-menu" style="left:${state.menu.x}px;top:${state.menu.y}px" role="menu">${item.type === 'folder' ? '<button data-action="new-child-note">' + icon('note_add') + '新建笔记</button><button data-action="new-child-folder">' + icon('create_new_folder') + '新建文件夹</button>' : ''}<button data-action="rename-item">${icon('drive_file_rename_outline')}重命名</button><button data-action="move-item">${icon('drive_file_move')}移动到</button>${item.type === 'file' ? '<button data-action="download-note">' + icon('download') + '下载 Markdown</button>' : ''}<div class="menu-divider"></div><button class="danger" data-action="delete-item">${icon('delete')}删除</button></div>`
}

function renderModal() {
  const modal = state.modal
  const title = {
    settings: '模型设置',
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
    body = `<p class="dialog-description">连接自己的模型，让知识开始对话</p><label class="form-field"><span>模型接口</span><input name="endpoint" type="url" value="${escape(database.settings.endpoint)}" placeholder="https://api.openai.com/v1" required></label><label class="form-field"><span>API 密钥</span><div class="password-field"><input name="apiKey" type="password" value="${escape(database.settings.apiKey)}" autocomplete="off" placeholder="本地模型可留空">${iconButton('visibility', 'toggle-key', '显示或隐藏密钥')}</div></label><label class="form-field"><span>模型名称</span><input name="model" value="${escape(database.settings.model)}" required placeholder="gpt-4o-mini"></label><div class="settings-notice">${icon('shield')}<p>密钥仅保存在此浏览器。请求直接发送到模型接口，需要接口允许跨域访问。</p></div>`
  else if (modal.type === 'connections') body = connectionContent()
  else if (modal.type === 'delete')
    body = `<p class="dialog-description">确定删除「${escape(modal.name)}」吗？${modal.vaultId ? '这会删除该知识库的全部笔记和对话。' : '文件夹中的内容也会一并删除。'}此操作无法撤销，请先导出备份。</p>`
  else if (modal.type === 'move')
    body = `<label class="form-field"><span>目标文件夹</span><select name="parentId">${folderOptions(modal.id)}</select></label>`
  else
    body = `<label class="form-field"><span>名称</span><input name="name" value="${escape(modal.value || '')}" placeholder="${modal.type.includes('folder') ? '文件夹名称' : modal.type.includes('vault') ? '知识库名称' : '笔记名称'}" required maxlength="150"></label>${['new-note', 'new-folder'].includes(modal.type) ? `<label class="form-field"><span>所在文件夹</span><select name="parentId">${folderOptions(null, modal.parentId)}</select></label>` : ''}`
  return `<div class="modal-backdrop" data-action="close-modal"><section class="dialog ${modal.type === 'settings' ? 'settings-dialog' : ''}" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><form id="dialog-form"><header class="dialog-header"><h2 id="dialog-title">${title}</h2>${iconButton('close', 'close-modal', '关闭')}</header><div class="dialog-body">${body}<p class="form-error" role="alert"></p></div>${modal.type !== 'connections' ? `<footer class="dialog-footer"><button type="button" class="text-button" data-action="close-modal">取消</button><button class="filled-button ${modal.type === 'delete' ? 'danger-filled' : ''}" type="submit">${modal.type === 'delete' ? '确认删除' : modal.type === 'settings' ? '保存设置' : '确定'}</button></footer>` : ''}</form></section></div>`
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
  if (action === 'close-menu') {
    state.menu = null
    render()
  } else if (action === 'vault-menu') {
    state.menu = state.menu?.type === 'vault' ? null : { type: 'vault' }
    render()
  } else if (action === 'note-menu') showItemMenu(state.selectedId, target)
  else if (action === 'new-note' || action === 'new-folder')
    showModal(action, { parentId: selected()?.parentId || null })
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
  } else if (action === 'rename-item')
    showModal('rename', { id: menuItem.id, value: extractTitle(menuItem) })
  else if (action === 'move-item') showModal('move', { id: menuItem.id })
  else if (action === 'delete-item')
    showModal('delete', { id: menuItem.id, name: extractTitle(menuItem) })
  else if (action === 'download-note') {
    download(
      new Blob([menuItem.content], { type: 'text/markdown;charset=utf-8' }),
      menuItem.name,
    )
    state.menu = null
    render()
  } else if (action === 'settings') showModal('settings')
  else if (action === 'close-modal') {
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
    'button, [data-note-link], [data-select], [data-folder]',
  )
  if (event.target.classList.contains('modal-backdrop')) {
    state.modal = null
    render()
    return
  }
  if (!target) return
  if (
    target.closest('.markdown-body') &&
    !target.hasAttribute('data-note-link')
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
      state.collapsed.has(id)
        ? state.collapsed.delete(id)
        : state.collapsed.add(id)
      render()
    } else if (target.dataset.itemMenu)
      showItemMenu(target.dataset.itemMenu, target)
    else if (target.dataset.mode) {
      state.mode = target.dataset.mode
      render()
      document.querySelector('#markdown-editor')?.focus()
    } else if (target.dataset.vault) {
      if (state.aiBusy) return notify('请先停止当前对话')
      database.activeId = target.dataset.vault
      state.selectedId = database.selections?.[database.activeId]
      state.menu = null
      state.page = 'note'
      state.search = ''
      state.aiDraft = ''
      state.attachments = []
      state.collapsed.clear()
      save()
      render()
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
    file.content = event.target.value
    file.updatedAt = new Date().toISOString()
    save()
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
  if (event.target.id !== 'dialog-form') return
  const form = new FormData(event.target)
  const modal = state.modal
  try {
    if (modal.type === 'settings') {
      const endpoint = form.get('endpoint').trim()
      const url = new URL(endpoint)
      if (!['http:', 'https:'].includes(url.protocol))
        throw new Error('请输入有效的 HTTP 或 HTTPS 接口')
      database.settings = {
        endpoint,
        apiKey: form.get('apiKey').trim(),
        model: form.get('model').trim(),
      }
    } else if (modal.type === 'new-note' || modal.type === 'new-folder') {
      const type = modal.type === 'new-note' ? 'file' : 'folder'
      const name = form.get('name').trim()
      const item = createItem(
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
      const name = form.get('name').trim()
      if (!name) throw new Error('请输入知识库名称')
      const entry = {
        id: makeId(),
        name,
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
    } else if (modal.type === 'rename')
      updateLocation(vault(), modal.id, { name: form.get('name') })
    else if (modal.type === 'move')
      updateLocation(vault(), modal.id, {
        parentId: form.get('parentId') || null,
      })
    else if (modal.type === 'delete') {
      if (modal.vaultId) {
        await deleteConversationAttachments(
          database.conversations[modal.vaultId] || [],
        )
        database.vaults = database.vaults.filter(
          (entry) => entry.id !== modal.vaultId,
        )
        delete database.conversations[modal.vaultId]
        database.activeId = database.vaults[0].id
        state.selectedId = null
        state.search = ''
        state.attachments = []
      } else deleteItem(vault(), modal.id)
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
    if (modal.type === 'settings') notify('模型设置已保存')
  } catch (error) {
    document.querySelector('.form-error').textContent = error.message
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
  if (event.target.id === 'markdown-editor' && event.key === 'Tab') {
    event.preventDefault()
    event.target.setRangeText(
      '  ',
      event.target.selectionStart,
      event.target.selectionEnd,
      'end',
    )
    event.target.dispatchEvent(new Event('input', { bubbles: true }))
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
    ].filter((node) => !node.disabled && node.getClientRects().length)
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

app.addEventListener('dragstart', (event) => {
  const row = event.target.closest('[data-tree-id]')
  if (row) {
    event.dataTransfer.setData('text/plain', row.dataset.treeId)
    event.dataTransfer.effectAllowed = 'move'
  }
})
app.addEventListener('dragover', (event) => {
  const row = event.target.closest('[data-tree-id]')
  if (
    (row &&
      vault().items.find((item) => item.id === row.dataset.treeId)?.type ===
        'folder') ||
    event.target.hasAttribute('data-drop-root')
  ) {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }
})
app.addEventListener('drop', (event) => {
  const row = event.target.closest('[data-tree-id]')
  const parentId = row?.dataset.treeId || null
  if (
    row &&
    vault().items.find((item) => item.id === parentId)?.type !== 'folder'
  )
    return
  if (!event.target.closest('.file-tree')) return
  event.preventDefault()
  try {
    updateLocation(vault(), event.dataTransfer.getData('text/plain'), {
      parentId,
    })
    if (parentId) state.collapsed.delete(parentId)
    save()
    render()
  } catch (error) {
    notify(error.message)
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

function updateLocation(targetVault, id, change) {
  const references = targetVault.items
    .filter((file) => file.type === 'file')
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
    }
  }
}

async function executeTool(targetVault, name, args) {
  const find = () => {
    const item = targetVault.items.find((item) => item.id === args.id)
    if (!item) throw new Error('文件不存在')
    return item
  }
  const summary = (item) => ({
    id: item.id,
    type: item.type,
    name: item.name,
    path: itemPath(targetVault, item),
    parentId: item.parentId,
  })
  if (name === 'list_files') return targetVault.items.map(summary)
  if (name === 'read_file') {
    const file = find()
    if (file.type !== 'file') throw new Error('目标不是笔记')
    return { ...summary(file), content: file.content }
  }
  if (name === 'search_files') {
    if (typeof args.query !== 'string') throw new Error('查询内容必须为文本')
    const query = args.query.toLowerCase()
    return targetVault.items
      .filter(
        (item) =>
          item.type === 'file' &&
          `${item.name}\n${item.content}`.toLowerCase().includes(query),
      )
      .map((file) => {
        const at = file.content.toLowerCase().indexOf(query)
        return {
          ...summary(file),
          excerpt: file.content.slice(
            Math.max(0, at - 100),
            Math.max(0, at - 100) + 700,
          ),
        }
      })
  }
  let result
  if (name === 'create_file') {
    if (typeof args.content !== 'string') throw new Error('笔记内容必须为文本')
    result = summary(
      createItem(
        targetVault,
        'file',
        args.name,
        args.parentId || null,
        args.content,
      ),
    )
  } else if (name === 'create_folder')
    result = summary(
      createItem(targetVault, 'folder', args.name, args.parentId || null),
    )
  else if (name === 'update_file') {
    const file = find()
    if (file.type !== 'file' || typeof args.content !== 'string')
      throw new Error('目标或笔记内容不正确')
    file.content = args.content
    file.updatedAt = new Date().toISOString()
    result = summary(file)
  } else if (name === 'rename_item') {
    updateLocation(targetVault, args.id, { name: args.name })
    result = summary(find())
  } else if (name === 'move_item') {
    updateLocation(targetVault, args.id, { parentId: args.parentId })
    result = summary(find())
  } else if (name === 'delete_item') {
    const item = find()
    if (
      !window.confirm(`知识助手请求删除「${item.name}」及其子内容，是否允许？`)
    )
      return { error: '用户拒绝删除' }
    deleteItem(targetVault, args.id)
    result = { deleted: args.id }
  } else throw new Error('不支持此工具')
  targetVault.updatedAt = new Date().toISOString()
  saveDatabase(database)
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
    (!database.settings.apiKey &&
      database.settings.endpoint.includes('api.openai.com'))
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
      {
        role: 'assistant',
        content: `${state.aiText ? state.aiText + '\n\n' : ''}${message}`,
      },
    ]
  } finally {
    state.aiBusy = false
    state.abort = null
    state.aiText = ''
    save()
    render()
    const container = document.querySelector('#ai-messages')
    if (container) container.scrollTop = container.scrollHeight
  }
}

window.addEventListener('beforeunload', (event) => {
  if (!state.saved || state.aiBusy) {
    event.preventDefault()
    event.returnValue = ''
  }
})
render()
