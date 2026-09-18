import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import PdfWorker from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?worker&inline'

let workerInstance = null

function getPdfWorker() {
  if (!workerInstance) {
    workerInstance = new PdfWorker()
  }
  return workerInstance
}

export async function renderPdfToContainer(container, blob, signal) {
  try {
    GlobalWorkerOptions.workerPort = getPdfWorker()
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const loadingTask = getDocument({ data: bytes })
    if (signal) {
      signal.addEventListener('abort', () => {
        try {
          loadingTask.destroy()
        } catch {
          /* 忽略中止 */
        }
      })
    }
    const pdf = await loadingTask.promise
    if (signal?.aborted || !container.isConnected) return

    const wrap = document.createElement('div')
    wrap.className = 'pdf-pages-list'

    for (let i = 1; i <= pdf.numPages; i++) {
      if (signal?.aborted || !container.isConnected) return
      const page = await pdf.getPage(i)
      const viewport = page.getViewport({ scale: 1.5 })

      const card = document.createElement('div')
      card.className = 'pdf-page-card'

      const badge = document.createElement('div')
      badge.className = 'pdf-page-badge'
      badge.textContent = `第 ${i} 页 / 共 ${pdf.numPages} 页`

      const canvas = document.createElement('canvas')
      canvas.className = 'pdf-page-canvas'
      canvas.width = viewport.width
      canvas.height = viewport.height

      const context = canvas.getContext('2d')
      await page.render({ canvasContext: context, viewport }).promise

      card.appendChild(badge)
      card.appendChild(canvas)
      wrap.appendChild(card)
    }

    if (!signal?.aborted && container.isConnected) {
      container.innerHTML = ''
      container.appendChild(wrap)
    }
  } catch (error) {
    if (signal?.aborted || !container.isConnected) return
    container.innerHTML = `<div class="source-empty" role="alert"><span class="material-symbols-rounded">error</span><h2>页面渲染失败</h2><p>${error.message || '无法读取文档页面'}</p></div>`
  }
}
