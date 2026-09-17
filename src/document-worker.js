import { GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs'
import PdfWorker from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?worker&inline'
import { parseSourceBytes } from './document-parser.js'

self.onmessage = async ({ data: { bytes, format } }) => {
  let pdfWorker
  try {
    if (format === 'pdf') {
      pdfWorker = new PdfWorker()
      GlobalWorkerOptions.workerPort = pdfWorker
    }
    self.postMessage({ result: await parseSourceBytes(bytes, format) })
  } catch (error) {
    self.postMessage({ error: error.message || '文档解析失败' })
  } finally {
    pdfWorker?.terminate()
    GlobalWorkerOptions.workerPort = null
  }
}
