import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
} from 'd3-force'
import { buildLinkGraph, extractTitle } from './markdown'

const escape = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  )

export function graphMarkup(
  items,
  selectedId,
  { compact = false, query = '', hideIsolated = false } = {},
) {
  const graph = buildLinkGraph(items)
  const connected = new Set(
    graph.edges.flatMap((edge) => [edge.source, edge.target]),
  )
  const neighbors = new Set([selectedId])
  for (const edge of graph.edges)
    if (edge.source === selectedId || edge.target === selectedId) {
      neighbors.add(edge.source)
      neighbors.add(edge.target)
    }
  const nodes = graph.nodes
    .filter(
      (file) =>
        (!compact || neighbors.has(file.id)) &&
        (!hideIsolated || connected.has(file.id)),
    )
    .map((file) => ({ ...file }))
  const ids = new Set(nodes.map((node) => node.id))
  const edges = graph.edges
    .filter((edge) => ids.has(edge.source) && ids.has(edge.target))
    .map((edge) => ({ ...edge }))
  const width = compact ? 252 : 900
  const height = compact ? 185 : 600
  const simulation = forceSimulation(nodes)
    .force(
      'link',
      forceLink(edges)
        .id((node) => node.id)
        .distance(compact ? 72 : 130),
    )
    .force('charge', forceManyBody().strength(compact ? -230 : -550))
    .force('center', forceCenter(width / 2, height / 2))
    .force('collide', forceCollide(compact ? 17 : 42))
    .stop()
  simulation.tick(180)
  let x0 = 0,
    y0 = 0,
    x1 = width,
    y1 = height
  if (!compact && nodes.length) {
    x0 = Math.min(...nodes.map((node) => node.x)) - 130
    y0 = Math.min(...nodes.map((node) => node.y)) - 110
    x1 = Math.max(...nodes.map((node) => node.x)) + 130
    y1 = Math.max(...nodes.map((node) => node.y)) + 110
  }
  return `<svg class="${compact ? 'mini-graph' : 'full-graph'}" viewBox="${x0} ${y0} ${x1 - x0} ${y1 - y0}" aria-label="笔记关系图谱"><g class="graph-transform">
    ${edges.map((edge) => `<line class="graph-edge ${edge.source.id === selectedId || edge.target.id === selectedId ? 'linked' : ''}" x1="${edge.source.x}" y1="${edge.source.y}" x2="${edge.target.x}" y2="${edge.target.y}" />`).join('')}
    ${nodes.map((node) => `<g class="graph-point ${node.id === selectedId ? 'selected' : ''} ${query && !extractTitle(node).toLowerCase().includes(query.toLowerCase()) ? 'dimmed' : ''}" data-select="${node.id}" tabindex="0" role="button" aria-label="打开${escape(extractTitle(node))}" transform="translate(${node.x},${node.y})"><title>${escape(extractTitle(node))}</title><circle class="node-halo" r="${compact ? 14 : 21}"/><circle class="node-core" r="${compact ? 5.5 : 8}"/>${compact ? '' : `<text y="32" text-anchor="middle">${escape(extractTitle(node))}</text>`}</g>`).join('')}
  </g></svg>`
}

export function bindGraphNavigation(container) {
  const svg = container?.querySelector('.full-graph')
  if (!svg) return
  const group = svg.querySelector('.graph-transform')
  let x = 0,
    y = 0,
    scale = 1,
    start = null,
    moved = false
  const apply = () =>
    group.setAttribute('transform', `translate(${x} ${y}) scale(${scale})`)
  const point = (event) =>
    new DOMPoint(event.clientX, event.clientY).matrixTransform(
      svg.getScreenCTM().inverse(),
    )
  svg.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault()
      const p = point(event)
      const next = Math.max(
        0.25,
        Math.min(4, scale * (event.deltaY > 0 ? 0.9 : 1.1)),
      )
      x = p.x - ((p.x - x) * next) / scale
      y = p.y - ((p.y - y) * next) / scale
      scale = next
      apply()
    },
    { passive: false },
  )
  svg.addEventListener('pointerdown', (event) => {
    if (event.target.closest('.graph-point')) return
    start = { p: point(event), x, y }
    moved = false
    svg.setPointerCapture(event.pointerId)
  })
  svg.addEventListener('pointermove', (event) => {
    if (!start) return
    const p = point(event)
    x = start.x + p.x - start.p.x
    y = start.y + p.y - start.p.y
    moved = true
    apply()
  })
  svg.addEventListener('pointerup', () => {
    start = null
  })
  svg.addEventListener('pointercancel', () => {
    start = null
  })
  svg.addEventListener(
    'click',
    (event) => {
      if (moved) {
        event.stopPropagation()
        moved = false
      }
    },
    true,
  )
  container.querySelectorAll('[data-zoom]').forEach((button) =>
    button.addEventListener('click', () => {
      if (button.dataset.zoom === 'reset') {
        x = 0
        y = 0
        scale = 1
      } else {
        const next = Math.max(
          0.25,
          Math.min(4, scale * (button.dataset.zoom === 'in' ? 1.2 : 0.8)),
        )
        const box = svg.viewBox.baseVal
        const cx = box.x + box.width / 2
        const cy = box.y + box.height / 2
        x = cx - ((cx - x) * next) / scale
        y = cy - ((cy - y) * next) / scale
        scale = next
      }
      apply()
    }),
  )
}
