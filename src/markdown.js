/**
 * 知库 Markdown 渲染引擎
 *
 * 职责：
 *  - 完整 Markdown 渲染：GFM 表格 / 任务列表 / 代码高亮(highlight.js) / KaTeX 数学 /
 *    脚注(marked-footnote) / 引用块 / 带稳定 id 的标题
 *  - Obsidian 风格双链：[[笔记]]、[[笔记|别名]]、[[笔记#标题]]、嵌入 ![[笔记]]（有界递归）
 *  - 内部 .md 链接、外部链接安全新窗口打开
 *  - 链接图 / 反向链接 / 双链解析 / 链接定位（供重命名、移动时改写链接）
 *
 * 约束：本模块不操作 DOM，也不依赖任何选择器；输出为经过 DOMPurify 消毒的 HTML 字符串，
 * 由 main.js 负责插入页面并处理 data-note-link / data-note-heading 点击。
 *
 * 代码块（围栏 / 行内）中的双链语法一律原样保留，不参与渲染链接、链接图与反链统计。
 */

import { Marked } from 'marked'
import DOMPurifyFactory from 'dompurify'
import hljs from 'highlight.js/lib/common'
import katex from 'katex'
import markedFootnote from 'marked-footnote'

/* ---------------------------------------------------------------------------
 * 常量与工具
 * ------------------------------------------------------------------------- */

/** 占位符：源码中的双链先替换为占位符，marked 渲染后再回填为最终 HTML。
 *  使用 Unicode 私用区字符，不会被 marked 转义，也不会与正文冲突。 */
const PH_OPEN = '\uE000'
const PH_CLOSE = '\uE001'
const PH_RE = new RegExp(`${PH_OPEN}(\\d+)${PH_CLOSE}`, 'g')
const PH_ANY_RE = new RegExp(`${PH_OPEN}\\d*${PH_CLOSE}`, 'g')

/** 嵌入递归上限 */
const MAX_EMBED_DEPTH = 4
/** 反向链接摘录最大长度 */
const EXCERPT_MAX = 180

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  )
}

function stripPlaceholders(s) {
  return String(s).replace(PH_ANY_RE, '')
}

/** 从 marked 的 token 树中抽取纯文本（用于标题 slug） */
function tokensToText(tokens) {
  if (!Array.isArray(tokens)) return ''
  let out = ''
  for (const t of tokens) {
    if (!t) continue
    if (t.tokens) out += tokensToText(t.tokens)
    else out += t.text || ''
  }
  return out
}

/** 标题 slug：小写、空白转连字符、仅保留 Unicode 字母/数字/连字符/下划线（保留中文） */
class Slugger {
  constructor() {
    this.seen = new Map()
  }

  slug(text) {
    let slug =
      String(text)
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^\p{L}\p{N}\-_]/gu, '') || 'section'
    const n = this.seen.get(slug) || 0
    this.seen.set(slug, n + 1)
    if (n > 0) slug = `${slug}-${n}`
    return slug
  }
}

/** 模块级活跃 slugger：renderCore 每次解析时设置；解析期间渲染器读取。
 *  嵌入的递归渲染发生在解析结束之后，因此不存在重入。 */
let activeSlugger = null

/* ---------------------------------------------------------------------------
 * 源码级扫描：在围栏代码块、行内代码、数学公式之外定位/替换双链
 *
 * 所有 token 均携带相对原文的绝对偏移（content.split('\n') 逐行扫描，
 * 每行长度 + 1 累加，故 \r\n 与 \n 下偏移均与原文一致）。
 * ------------------------------------------------------------------------- */

/**
 * 逐行扫描 Markdown 源码。onToken(token) 返回替换字符串（null 表示保留原文）。
 * token: { type:'wiki'|'mdlink', target, targetStart, targetEnd, raw, lineNo, col }
 *   - target：原始目标文本（不含括号与别名；可含 #标题）
 *   - targetStart/targetEnd：target 在原文中的 [start, end) 绝对偏移
 */
function processContent(src, onToken) {
  const text = String(src || '')
  const lines = text.split('\n')
  const out = []
  let fence = null // { char, len }
  let mathOpen = false // 处于跨行 $$ ... $$ 展示公式中
  let lineStart = 0 // 当前行首字符在原文中的偏移

  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    let line = lines[lineNo]

    // 围栏代码块内部
    if (fence) {
      if (new RegExp(`^ {0,3}\\${fence.char}{${fence.len},}\\s*$`).test(line))
        fence = null
      out.push(line)
      lineStart += line.length + 1
      continue
    }
    // 开启围栏
    const fm = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (fm) {
      fence = { char: fm[1][0], len: fm[1].length }
      out.push(line)
      lineStart += line.length + 1
      continue
    }
    // 跨行展示公式内部：保留闭合 $$ 及其前文，仅对余下内容扫描（偏移同步前移）
    if (mathOpen) {
      const p = line.indexOf('$$')
      if (p === -1) {
        out.push(line)
        lineStart += line.length + 1
        continue
      }
      mathOpen = false
      const prefix = line.slice(0, p + 2)
      const res = scanLine(
        line.slice(p + 2),
        onToken,
        lineNo,
        lineStart + p + 2,
      )
      out.push(prefix + res.text)
      if (res.mathOpen) mathOpen = true
      lineStart += lines[lineNo].length + 1
      continue
    }

    const res = scanLine(line, onToken, lineNo, lineStart)
    out.push(res.text)
    if (res.mathOpen) mathOpen = true
    lineStart += lines[lineNo].length + 1
  }
  return out.join('\n')
}

/** 单行内扫描：跳过行内代码与行内公式，定位/替换双链与内部 .md 链接 */
function scanLine(line, onToken, lineNo, lineStart) {
  let out = ''
  let i = 0
  const n = line.length

  while (i < n) {
    const ch = line[i]
    // 转义字符：原样保留两个字符（\[\[ 不会成链）
    if (ch === '\\') {
      out += line.slice(i, i + 2)
      i += 2
      continue
    }

    // 行内代码
    if (ch === '`') {
      const tick = /^`+/.exec(line.slice(i))[0]
      const close = line.indexOf(tick, i + tick.length)
      if (close !== -1) {
        out += line.slice(i, close + tick.length)
        i = close + tick.length
        continue
      }
      out += tick
      i += tick.length
      continue
    }

    // 行内/展示数学（单行内的 $...$ 或 $$...$$）
    if (ch === '$') {
      if (line.startsWith('$$', i)) {
        const close = line.indexOf('$$', i + 2)
        if (close !== -1) {
          out += line.slice(i, close + 2)
          i = close + 2
          continue
        }
        return { text: out + line.slice(i), mathOpen: true }
      }
      if (i + 1 < n && !/\s/.test(line[i + 1])) {
        const close = findInlineMathClose(line, i + 1)
        if (close !== -1) {
          out += line.slice(i, close)
          i = close
          continue
        }
      }
      out += ch
      i++
      continue
    }

    // 图片 ![alt](src)：整体保留（双链嵌入是 ![[ 形式）
    if (ch === '!' && line.startsWith('![', i) && !line.startsWith('![[', i)) {
      const end = findLinkEnd(line, i + 1)
      if (end !== -1) {
        out += line.slice(i, end)
        i = end
        continue
      }
      out += ch
      i++
      continue
    }

    // 嵌入 ![[...]]
    if (line.startsWith('![[', i)) {
      const end = line.indexOf(']]', i + 3)
      if (end !== -1) {
        const raw = line.slice(i, end + 2)
        const token = makeWikiToken(
          line.slice(i + 3, end),
          raw,
          true,
          lineNo,
          i,
          lineStart,
        )
        const repl = onToken(token)
        out += repl != null ? repl : raw
        i = end + 2
        continue
      }
    }

    // 双链 [[...]]
    if (line.startsWith('[[', i)) {
      const end = line.indexOf(']]', i + 2)
      if (end !== -1) {
        const raw = line.slice(i, end + 2)
        const token = makeWikiToken(
          line.slice(i + 2, end),
          raw,
          false,
          lineNo,
          i,
          lineStart,
        )
        const repl = onToken(token)
        out += repl != null ? repl : raw
        i = end + 2
        continue
      }
      out += ch
      i++
      continue
    }

    // Markdown 内部链接 [text](target.md)
    if (ch === '[') {
      const m = /^\[([^[\]]*)\]\(/.exec(line.slice(i))
      if (m) {
        const end = findLinkEnd(line, i + m[0].length - 1)
        if (end !== -1) {
          const parenOpen = i + m[0].length - 1
          const destRaw = line.slice(parenOpen + 1, end - 1)
          // 目标为首个空白前的 token（可写 <path with spaces> 形式）
          const tm = /^\s*(<[^<>]*>|[^\s)]+)/.exec(destRaw)
          if (tm) {
            let target = tm[1]
            let off = tm[0].length - target.length
            if (target.startsWith('<') && target.endsWith('>')) {
              target = target.slice(1, -1)
              off += 1
            }
            if (/\.md(#[^\s]*)?$/i.test(target)) {
              const token = {
                type: 'mdlink',
                target,
                targetStart: lineStart + parenOpen + 1 + off,
                targetEnd: lineStart + parenOpen + 1 + off + target.length,
                text: m[1],
                raw: line.slice(i, end),
                lineNo,
                col: i,
              }
              const repl = onToken(token)
              if (repl != null) {
                out += repl
                i = end
                continue
              }
            }
          }
          out += line.slice(i, end)
          i = end
          continue
        }
      }
      out += ch
      i++
      continue
    }

    out += ch
    i++
  }
  return { text: out, mathOpen: false }
}

/** 行内公式闭合 $ 位置（返回其后索引）：闭合 $ 后不得紧跟数字（保护货币） */
function findInlineMathClose(line, start) {
  for (let j = start; j < line.length; j++) {
    const ch = line[j]
    if (ch === '\\') {
      j++
      continue
    }
    if (ch === '$') {
      if (/\d/.test(line[j + 1] || '')) continue
      return j + 1
    }
  }
  return -1
}

/** 从 '(' 起找匹配的 ')' 之后的位置；失败返回 -1 */
function findLinkEnd(line, openParen) {
  let depth = 0
  for (let j = openParen; j < line.length; j++) {
    const ch = line[j]
    if (ch === '\\') {
      j++
      continue
    }
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return j + 1
    }
  }
  return -1
}

/**
 * 解析 [[...]] 内部：别名（首个未转义 |）、章节锚点（首个 #）。
 * 返回相对 inner 的偏移：targetStart / targetLen 圈定目标原文（不含别名）。
 */
function parseWikiInner(inner) {
  let s = String(inner)
  const lead = s.length - s.trimStart().length
  s = s.trimStart()
  let alias = ''
  const pipe = findUnescapedPipe(s)
  if (pipe !== -1) {
    alias = s
      .slice(pipe + 1)
      .trim()
      .replace(/\\\|/g, '|')
    s = s.slice(0, pipe)
  }
  s = s.trimEnd()
  let heading = ''
  // 目标原文包含 #标题 部分（供 data-note-link 与重命名定位），仅别名剔除
  const targetLen = s.length
  const hash = s.indexOf('#')
  if (hash !== -1) {
    heading = s.slice(hash + 1).trim()
  }
  return {
    noteTarget: hash === -1 ? s : s.slice(0, hash),
    heading,
    alias,
    targetStart: lead,
    targetLen,
  }
}

/** 首个未转义 | 的位置；无则 -1 */
function findUnescapedPipe(s) {
  for (let j = 0; j < s.length; j++) {
    if (s[j] === '\\') {
      j++
      continue
    }
    if (s[j] === '|') return j
  }
  return -1
}

function makeWikiToken(inner, raw, embed, lineNo, col, lineStart) {
  const parsed = parseWikiInner(inner)
  const innerStart = lineStart + col + (embed ? 3 : 2)
  const tStart = innerStart + parsed.targetStart
  return {
    type: 'wiki',
    embed,
    raw,
    lineNo,
    col,
    noteTarget: parsed.noteTarget,
    heading: parsed.heading,
    alias: parsed.alias,
    target: String(inner).slice(
      parsed.targetStart,
      parsed.targetStart + parsed.targetLen,
    ),
    targetStart: tStart,
    targetEnd: tStart + parsed.targetLen,
  }
}

/* ---------------------------------------------------------------------------
 * 双链解析与路径工具
 * ------------------------------------------------------------------------- */

/** 计算条目完整路径（沿 parentId 链拼接祖先名） */
function itemPath(item, items) {
  const byId = new Map(items.map((it) => [it.id, it]))
  const parts = [item.name]
  const guard = new Set([item.id])
  let cur = item
  while (cur.parentId && byId.has(cur.parentId) && !guard.has(cur.parentId)) {
    guard.add(cur.parentId)
    cur = byId.get(cur.parentId)
    parts.unshift(cur.name)
  }
  return parts.join('/')
}

/**
 * 解析双链目标为文件对象；找不到返回 null。
 * 支持：标题、path/to/标题、含 .md 的路径、#标题（当前文件）、note#标题。
 * 规则：精确路径 > 路径后缀匹配 > 标题匹配；同级优先，其次路径短者优先，最后按路径字典序。
 */
export function resolveWikiLink(target, items, currentFileId) {
  const files = (items || []).filter((item) => item?.type === 'file')
  let text = String(target || '')
    .trim()
    .split('|')[0]
    .split('#')[0]
    .trim()
  try {
    text = decodeURIComponent(text)
  } catch {
    /* 保留非编码名称 */
  }
  const current = files.find((file) => file.id === currentFileId)
  if (!text)
    return String(target || '').startsWith('#') ? current || null : null
  if (/^[a-z][a-z\d+.-]*:/i.test(text)) return null
  const normalize = (path) => {
    const parts = []
    for (const part of path.toLowerCase().replace(/\\/g, '/').split('/')) {
      if (!part || part === '.') continue
      if (part === '..') parts.pop()
      else parts.push(part)
    }
    return parts.join('/').replace(/\.md$/i, '')
  }
  const path = normalize(text)
  const currentDirectory = current
    ? itemPath(current, items).split('/').slice(0, -1).join('/')
    : ''
  const relative = normalize(`${currentDirectory}/${text}`)
  const explicitRelative = /^\.{1,2}\//.test(text)
  const hasPath = text.includes('/')
  const candidates = files
    .map((file) => {
      const fullPath = normalize(itemPath(file, items))
      let score = 0
      if (explicitRelative) score = fullPath === relative ? 5 : 0
      else if (hasPath)
        score = fullPath === path ? 5 : fullPath === relative ? 4 : 0
      else if (extractTitle(file).toLowerCase() === path)
        score =
          file.parentId === current?.parentId
            ? 5
            : file.parentId === null
              ? 3
              : 1
      return { file, fullPath, score }
    })
    .filter((entry) => entry.score)
  candidates.sort(
    (a, b) =>
      b.score - a.score ||
      a.fullPath.length - b.fullPath.length ||
      a.fullPath.localeCompare(b.fullPath),
  )
  return candidates[0]?.file || null
}

/** 文件标题：去掉 .md 后缀 */
export function extractTitle(file) {
  const name = file && typeof file.name === 'string' ? file.name : ''
  return name.replace(/\.md$/i, '')
}

/** 用户原生 HTML 片段单独消毒：禁止 data-* / id / class / style / name 及交互控件，
 *  防止点击委托误触与 DOM 冒名；KaTeX 样式与双链 data-* 在最终消毒层保留，不受影响。 */
function sanitizeUserHtml(text) {
  ensureHook()
  return DOMPurify.sanitize(String(text), {
    ALLOW_DATA_ATTR: false,
    FORBID_ATTR: ['id', 'class', 'style', 'name'],
    FORBID_TAGS: [
      'form',
      'button',
      'input',
      'select',
      'textarea',
      'style',
      'iframe',
      'object',
      'embed',
    ],
  })
}

/* ---------------------------------------------------------------------------
 * marked 实例：KaTeX 数学扩展 + 脚注 + 标题/代码渲染器
 * ------------------------------------------------------------------------- */

function renderKatex(tex, displayMode) {
  try {
    return katex.renderToString(tex, {
      displayMode,
      throwOnError: false,
      strict: false,
      trust: false,
      output: 'htmlAndMathml',
    })
  } catch {
    return `<code class="katex-error">${escapeHtml(tex)}</code>`
  }
}

/** 块级数学 $$...$$（可跨行） */
const mathBlockExt = {
  name: 'mathBlock',
  level: 'block',
  start(src) {
    const i = src.indexOf('$$')
    return i === -1 ? undefined : i
  },
  tokenizer(src) {
    const m = /^\$\$([\s\S]+?)\$\$(?:\n+|$)/.exec(src)
    if (!m) return null
    return { type: 'mathBlock', raw: m[0], text: m[1].trim() }
  },
  renderer(token) {
    return renderKatex(token.text, true)
  },
}

/** 行内数学 $...$：开 $ 后不得为空白/数字；闭 $ 前不得为空白、后不得为数字 —— 避免吞掉货币 $5 */
const inlineMathExt = {
  name: 'inlineMath',
  level: 'inline',
  start(src) {
    const i = src.indexOf('$')
    return i === -1 ? undefined : i
  },
  tokenizer(src) {
    if (src.startsWith('$$')) {
      // 行内出现的 $$...$$
      const end = src.indexOf('$$', 2)
      if (end === -1) return null
      return {
        type: 'inlineMath',
        raw: src.slice(0, end + 2),
        text: src.slice(2, end).trim(),
        display: true,
      }
    }
    if (!/^\$(?![\s\d$])/.test(src)) return null // 开 $ 守卫（含货币 $5 场景）
    for (let j = 1; j < src.length; j++) {
      const ch = src[j]
      if (ch === '\\') {
        j++
        continue
      }
      if (ch === '\n') return null
      if (ch === '$') {
        if (/\s/.test(src[j - 1])) return null // 闭 $ 前不得为空白
        if (/\d/.test(src[j + 1] || '')) return null // 闭 $ 后不得为数字
        return {
          type: 'inlineMath',
          raw: src.slice(0, j + 1),
          text: src.slice(1, j),
        }
      }
    }
    return null
  },
  renderer(token) {
    return renderKatex(token.text, Boolean(token.display))
  },
}

const CALLOUT_CONFIGS = {
  note: { title: '说明', icon: 'info', type: 'note' },
  info: { title: '信息', icon: 'info', type: 'info' },
  tip: { title: '提示', icon: 'lightbulb', type: 'tip' },
  hint: { title: '建议', icon: 'lightbulb', type: 'tip' },
  important: { title: '重要', icon: 'priority_high', type: 'important' },
  warning: { title: '警告', icon: 'warning', type: 'warning' },
  caution: { title: '小心', icon: 'warning', type: 'warning' },
  danger: { title: '危险', icon: 'bolt', type: 'danger' },
  error: { title: '错误', icon: 'error', type: 'danger' },
  bug: { title: '缺陷', icon: 'bug_report', type: 'danger' },
  example: { title: '示例', icon: 'auto_stories', type: 'example' },
  quote: { title: '引用', icon: 'format_quote', type: 'quote' },
  todo: { title: '待办', icon: 'checklist', type: 'todo' },
  success: { title: '完成', icon: 'check_circle', type: 'success' },
  done: { title: '完成', icon: 'check_circle', type: 'success' },
  question: { title: '疑问', icon: 'help', type: 'question' },
  help: { title: '帮助', icon: 'help', type: 'question' },
  faq: { title: '常见问题', icon: 'help', type: 'question' },
}

const md = new Marked(markedFootnote())
md.use({
  gfm: true,
  breaks: true,
  extensions: [mathBlockExt, inlineMathExt],
  walkTokens(token) {
    if (token.type === 'blockquote') {
      const first = token.tokens?.[0]
      if (first && first.type === 'paragraph') {
        const text = first.text || ''
        const match =
          /^\[!([a-zA-Z0-9_-]+)\]([+-]?)(?:[ \t]+([^\n]*))?(?:\n([\s\S]*))?$/.exec(
            text,
          )
        if (match) {
          token.isCallout = true
          token.calloutKey = match[1].toLowerCase()
          token.calloutFold = match[2]
          token.calloutTitle = match[3]?.trim()
          const restText = match[4] || ''
          if (restText.trim()) {
            first.text = restText
            first.tokens = this.Lexer.lexInline(restText)
          } else {
            token.tokens.shift()
          }
        }
      }
    }
  },
  renderer: {
    heading(token) {
      const text = stripPlaceholders(tokensToText(token.tokens))
      const id = activeSlugger ? activeSlugger.slug(text) : ''
      const inner = this.parser.parseInline(token.tokens)
      return `<h${token.depth} id="${escapeHtml(id)}">${inner}</h${token.depth}>\n`
    },
    blockquote(token) {
      if (token.isCallout) {
        const cfg = CALLOUT_CONFIGS[token.calloutKey] || {
          title: token.calloutKey.toUpperCase(),
          icon: 'info',
          type: 'note',
        }
        const title = token.calloutTitle || cfg.title
        const body = token.tokens?.length ? this.parser.parse(token.tokens) : ''
        const isCollapsible =
          token.calloutFold === '-' || token.calloutFold === '+'
        const defaultOpen = token.calloutFold !== '-'
        const iconHtml = `<span class="material-symbols-rounded callout-icon" aria-hidden="true">${cfg.icon}</span>`
        const titleHtml = `<span class="callout-title-text">${escapeHtml(title)}</span>`

        if (isCollapsible) {
          return `<details class="callout callout-${cfg.type}" ${defaultOpen ? 'open' : ''} data-callout="${escapeHtml(token.calloutKey)}"><summary class="callout-title">${iconHtml}${titleHtml}<span class="material-symbols-rounded callout-fold-icon" aria-hidden="true">expand_more</span></summary>${body ? `<div class="callout-content">${body}</div>` : ''}</details>\n`
        }
        return `<div class="callout callout-${cfg.type}" data-callout="${escapeHtml(token.calloutKey)}"><div class="callout-title">${iconHtml}${titleHtml}</div>${body ? `<div class="callout-content">${body}</div>` : ''}</div>\n`
      }
      return `<blockquote>${this.parser.parse(token.tokens)}</blockquote>\n`
    },
    code(token) {
      const lang = (token.lang || '').trim().split(/\s+/)[0]
      let body = null
      if (lang && hljs.getLanguage(lang)) {
        try {
          body = hljs.highlight(token.text, {
            language: lang,
            ignoreIllegals: true,
          }).value
        } catch {
          /* 忽略高亮失败 */
        }
      }
      if (body == null) body = escapeHtml(token.text)
      const cls = lang
        ? ` class="hljs language-${escapeHtml(lang)}"`
        : ' class="hljs"'
      const langBadge = lang
        ? `<span class="code-lang">${escapeHtml(lang)}</span>`
        : '<span></span>'
      return `<div class="code-block-wrapper"><div class="code-block-header">${langBadge}<button type="button" class="code-copy-button" data-code-copy="true" aria-label="复制代码"><span class="material-symbols-rounded" aria-hidden="true">content_copy</span><span>复制</span></button></div><pre><code${cls}>${body}\n</code></pre></div>\n`
    },
    // 用户原生 HTML：单独消毒，剥离 id/class/style/name、data-* 与交互控件
    html(token) {
      return sanitizeUserHtml(token.text)
    },
  },
})

/* ---------------------------------------------------------------------------
 * 消毒
 * ------------------------------------------------------------------------- */

const DOMPurify =
  typeof window !== 'undefined'
    ? typeof DOMPurifyFactory.sanitize === 'function'
      ? DOMPurifyFactory
      : DOMPurifyFactory(window)
    : { sanitize: (s) => s, addHook: () => {} }

let hookInstalled = false
function ensureHook() {
  if (hookInstalled || typeof DOMPurify.addHook !== 'function') return
  hookInstalled = true
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A' && node.hasAttribute('href')) {
      const href = node.getAttribute('href') || ''
      // 外部链接安全地在新标签页打开；内部双链（data-note-link）由 main.js 处理
      if (/^https?:/i.test(href) && !node.hasAttribute('data-note-link')) {
        node.setAttribute('target', '_blank')
        node.setAttribute('rel', 'noopener noreferrer')
      }
    }
  })
}

const SANITIZE_CONFIG = {
  USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true },
  ADD_ATTR: [
    'target',
    'rel',
    'id',
    'aria-hidden',
    'data-note-link',
    'data-note-heading',
    'data-embed-target',
    'data-callout',
    'data-code-copy',
    'open',
  ],
}

/* ---------------------------------------------------------------------------
 * 渲染
 * ------------------------------------------------------------------------- */

/** token 描述符收集器：登记 token 并返回占位符 */
function makeSink(tokens) {
  return (token) => {
    tokens.push(token)
    return PH_OPEN + (tokens.length - 1) + PH_CLOSE
  }
}

function renderWikiLink(token, items, currentFileId, current) {
  const file = resolveWikiLink(token.target, items, currentFileId)
  let label = token.alias
  if (!label) {
    label = token.noteTarget
      ? token.noteTarget.split('/').pop()
      : current
        ? extractTitle(current)
        : token.heading || '未命名'
  }
  const cls = file ? 'wiki-link' : 'wiki-link unresolved'
  const headingAttr = token.heading
    ? ` data-note-heading="${escapeHtml(token.heading)}"`
    : ''
  return `<a href="#" class="${cls}" data-note-link="${escapeHtml(token.target)}"${headingAttr}>${escapeHtml(label)}</a>`
}

function renderMdLink(token, items, currentFileId) {
  const file = resolveWikiLink(token.target, items, currentFileId)
  const cls = file ? 'wiki-link' : 'wiki-link unresolved'
  return `<a href="#" class="${cls}" data-note-link="${escapeHtml(token.target)}">${escapeHtml(token.text || token.target)}</a>`
}

function renderEmbed(token, items, currentFileId, ctx, block) {
  const tag = block ? 'div' : 'span'
  const current = items.find((f) => f.id === currentFileId) || null
  const targetAttr = ` data-embed-target="${escapeHtml(token.target)}"`

  if (ctx.depth >= MAX_EMBED_DEPTH) {
    return `<${tag} class="wiki-embed wiki-embed-missing"${targetAttr}>嵌套引用层级过深，已停止展开</${tag}>`
  }
  const file = resolveWikiLink(token.target, items, currentFileId)
  const label = token.noteTarget
    ? token.noteTarget.split('/').pop()
    : current
      ? extractTitle(current)
      : token.heading
  if (!file) {
    return `<${tag} class="wiki-embed wiki-embed-missing"${targetAttr}>未找到笔记「${escapeHtml(label || token.target)}」</${tag}>`
  }
  if (ctx.visiting.has(file.id)) {
    return `<${tag} class="wiki-embed wiki-embed-missing"${targetAttr}>检测到循环引用「${escapeHtml(label)}」</${tag}>`
  }

  let content = file.content || ''
  if (token.heading) {
    const section = extractSection(content, token.heading)
    if (section == null) {
      return `<${tag} class="wiki-embed wiki-embed-missing"${targetAttr}>未找到章节「${escapeHtml(token.heading)}」</${tag}>`
    }
    content = section
  }
  const inner = renderCore(content, items, file.id, {
    depth: ctx.depth + 1,
    visiting: new Set([...ctx.visiting, file.id]),
  })
  return `<${tag} class="wiki-embed"${targetAttr}>${inner}</${tag}>`
}

/** 将渲染结果中的占位符回填为最终 HTML */
function substituteTokens(html, tokens, items, currentFileId, ctx) {
  html = html.replace(
    /<pre\b[\s\S]*?<\/pre>|<code\b[\s\S]*?<\/code>/gi,
    (code) =>
      code.replace(PH_RE, (_, index) =>
        escapeHtml(tokens[Number(index)]?.raw || ''),
      ),
  )
  // 独占一段的嵌入 → 块级 <div>
  html = html.replace(
    new RegExp(`<p>${PH_OPEN}(\\d+)${PH_CLOSE}</p>`, 'g'),
    (m, d) => {
      const t = tokens[Number(d)]
      if (t && t.type === 'wiki' && t.embed)
        return renderEmbed(t, items, currentFileId, ctx, true)
      return m
    },
  )
  // 其余占位符
  html = html.replace(PH_RE, (m, d) => {
    const t = tokens[Number(d)]
    if (!t) return ''
    if (t.type === 'wiki') {
      return t.embed
        ? renderEmbed(t, items, currentFileId, ctx, false)
        : renderWikiLink(
            t,
            items,
            currentFileId,
            items.find((f) => f.id === currentFileId) || null,
          )
    }
    if (t.type === 'mdlink') return renderMdLink(t, items, currentFileId)
    return m
  })
  // 兜底清理未消费的占位符
  return html.replace(PH_ANY_RE, '')
}

function renderCore(content, items, currentFileId, ctx) {
  const tokens = []
  const processed = processContent(content, makeSink(tokens))

  activeSlugger = new Slugger()
  let html
  try {
    html = md.parse(processed)
  } finally {
    activeSlugger = null
  }

  html = substituteTokens(html, tokens, items || [], currentFileId, ctx)
  ensureHook()
  return DOMPurify.sanitize(html, SANITIZE_CONFIG)
}

/**
 * 渲染 Markdown 为消毒后的 HTML。
 * @param {string} content Markdown 源码
 * @param {Array} items 工作区条目
 * @param {string|null} currentFileId 当前文件 id（用于相对解析与嵌入循环检测）
 */
export function renderMarkdown(content, items, currentFileId) {
  return renderCore(content, items || [], currentFileId, {
    depth: 0,
    visiting: new Set(currentFileId ? [currentFileId] : []),
  })
}

/**
 * 提取标题大纲：[{ level, text, id }]，id 与 renderMarkdown 生成的标题 id 完全一致，
 * 可用于目录导航与 [[笔记#标题]] 跳转。
 */
export function extractHeadings(content) {
  const headings = []
  const slugger = new Slugger()
  const prev = activeSlugger
  activeSlugger = null
  try {
    md.parse(String(content || ''), {
      walkTokens(token) {
        if (token.type !== 'heading') return
        const text = stripPlaceholders(tokensToText(token.tokens))
        headings.push({ level: token.depth, text, id: slugger.slug(text) })
      },
    })
  } catch {
    // 解析失败时返回已收集部分
  } finally {
    activeSlugger = prev
  }
  return headings
}

/* ---------------------------------------------------------------------------
 * 链接定位 / 链接收集 / 图谱 / 反向链接
 * ------------------------------------------------------------------------- */

/**
 * 列出内容中的全部内部链接（已排除围栏代码块、行内代码与数学公式）。
 * 返回 [{ target, start, end }]：start/end 为原文中目标文本的 [start, end) 绝对偏移，
 * 仅圈定目标本身（不含括号与别名；目标可含 #标题）。
 * 供重命名/移动笔记时定位并改写链接：Main 先 resolveWikiLink 校验目标，
 * 变更后按偏移替换 [start, end) 即可保留别名与章节锚点。
 */
export function listNoteLinks(content) {
  return extractLinks(content).map((token) => ({
    target: token.target,
    start: token.targetStart,
    end: token.targetEnd,
  }))
}

/** 收集文件内容中的全部内部链接 token（已排除代码块与行内代码） */
function extractLinks(content) {
  const links = []
  const processed = processContent(content, makeSink(links))
  const visible = new Set()
  let htmlCodeDepth = 0
  md.walkTokens(md.lexer(processed), (token) => {
    if (token.type === 'html') {
      for (const match of token.raw.matchAll(/<(\/?)(?:pre|code)\b[^>]*>/gi))
        htmlCodeDepth = Math.max(0, htmlCodeDepth + (match[1] ? -1 : 1))
    }
    if (token.type !== 'text' || token.tokens || htmlCodeDepth) return
    for (const match of token.raw.matchAll(PH_RE)) visible.add(Number(match[1]))
  })
  return links.filter((_, index) => visible.has(index))
}

/**
 * 构建链接图。
 * @returns {{ nodes: Array, edges: Array<{source:string,target:string}> }}
 * nodes 为文件对象；边已去重，排除自环；解析与渲染链接一致。
 */
export function buildLinkGraph(items) {
  const all = items || []
  const nodes = all.filter((it) => it && it.type === 'file')
  const edges = []
  const seen = new Set()
  for (const f of nodes) {
    for (const link of extractLinks(f.content || '')) {
      const target = resolveWikiLink(link.target, all, f.id)
      if (!target || target.id === f.id) continue
      const key = `${f.id}\u0000${target.id}`
      if (!seen.has(key)) {
        seen.add(key)
        edges.push({ source: f.id, target: target.id })
      }
    }
  }
  return { nodes, edges }
}

/** 生成反向链接摘录：纯文本（无 HTML），调用方应使用 textContent 插入 */
function makeExcerpt(lines, lineNo, col) {
  let s = (lines[lineNo] || '').replace(/\r$/, '')
  if (s.length > EXCERPT_MAX + 40) {
    const start = Math.max(0, col - EXCERPT_MAX / 2)
    const end = Math.min(s.length, start + EXCERPT_MAX)
    s =
      (start > 0 ? '…' : '') + s.slice(start, end) + (end < s.length ? '…' : '')
  }
  return s
    .replace(/!?\[\[([^[\]]+)\]\]/g, (_, inner) => {
      const [t, a] = inner.split('|')
      return a != null && a !== '' ? a : t.split('#')[0].split('/').pop()
    })
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 反向链接：[{ file, excerpt }]
 * excerpt 为包含链接的那一行（纯文本，已去除双链语法），不包含任何 HTML。
 */
export function getBacklinks(items, fileId) {
  const all = items || []
  if (!fileId) return []
  const out = []
  for (const f of all) {
    if (!f || f.type !== 'file' || f.id === fileId) continue
    const content = f.content || ''
    const lines = content.split('\n')
    let excerpt = null
    for (const link of extractLinks(content)) {
      const target = resolveWikiLink(link.target, all, f.id)
      if (target && target.id === fileId) {
        excerpt = makeExcerpt(lines, link.lineNo, link.col)
        break
      }
    }
    if (excerpt !== null) out.push({ file: f, excerpt })
  }
  return out
}

/* ---------------------------------------------------------------------------
 * 章节抽取（供 ![[笔记#标题]] 使用）
 * ------------------------------------------------------------------------- */

/** 抽取从指定标题到下一个同级/更高级标题之间的内容；未找到返回 null */
function extractSection(content, headingText) {
  const lines = String(content || '').split(/\r?\n/)
  const needle = String(headingText).replace(/\s+/g, ' ').trim().toLowerCase()
  let start = -1
  let level = 1
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(lines[i])
    if (m && m[2].replace(/\s+/g, ' ').trim().toLowerCase() === needle) {
      start = i
      level = m[1].length
      break
    }
  }
  if (start === -1) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(#{1,6})\s+/.exec(lines[i])
    if (m && m[1].length <= level) {
      end = i
      break
    }
  }
  return lines.slice(start, end).join('\n')
}
