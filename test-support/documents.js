import JSZip from 'jszip'

const rels = (target, type = 'slide') =>
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/></Relationships>`

export async function fixtureFile(format, text = '资料测试正文') {
  if (format === 'html')
    return new File(
      [
        `<!doctype html><html><body><h1>资料标题</h1><p>${text}</p><table><tr><th>项目</th><th>数值</th></tr><tr><td>收入</td><td>42</td></tr></table></body></html>`,
      ],
      '资料.html',
    )
  if (format === 'pdf') return new File([pdfBytes()], '资料.pdf')
  if (format === 'csv') return new File([`项目,数值\n${text},42`], '资料.csv')
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
  )
  if (format === 'docx') {
    zip.file(
      'word/document.xml',
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>资料标题</w:t></w:r></w:p><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
    )
  }
  if (format === 'pptx') {
    zip.file(
      'ppt/presentation.xml',
      '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>',
    )
    zip.file('ppt/_rels/presentation.xml.rels', rels('slides/slide1.xml'))
    zip.file(
      'ppt/slides/slide1.xml',
      `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="标题"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>资料标题</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="内容"/><p:cNvSpPr/><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
    )
    zip.file(
      'ppt/slides/_rels/slide1.xml.rels',
      rels('../notesSlides/notesSlide1.xml', 'notesSlide'),
    )
    zip.file(
      'ppt/notesSlides/notesSlide1.xml',
      '<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>私密备注</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>',
    )
  }
  if (format === 'xlsx') {
    zip.file(
      'xl/workbook.xml',
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="工作表" sheetId="1" r:id="rId1"/></sheets></workbook>',
    )
    zip.file(
      'xl/_rels/workbook.xml.rels',
      rels('worksheets/sheet1.xml', 'worksheet'),
    )
    zip.file(
      'xl/worksheets/sheet1.xml',
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${text}</t></is></c><c r="B1"><v>42</v></c></row></sheetData></worksheet>`,
    )
  }
  return new File(
    [await zip.generateAsync({ type: 'uint8array' })],
    `资料.${format}`,
  )
}

export function pdfBytes(empty = false) {
  const content = empty
    ? ''
    : 'BT /F1 20 Tf 50 750 Td (Document title) Tj 0 -50 Td (Knowledge PDF text) Tj ET'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ]
  let result = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, index) => {
    offsets.push(result.length)
    result += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const start = result.length
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  result += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')
  result += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`
  return new TextEncoder().encode(result)
}
