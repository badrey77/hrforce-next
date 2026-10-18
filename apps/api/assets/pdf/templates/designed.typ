// designed@1 — the ONE fixed template of designed documents (ADR 008 amendment 2026-10-09,
// docs/contracts/document-templates.md › Rendering). A company's template is DATA: the API validates it, resolves every
// placeholder, gender form and condition in TypeScript (domain/template-resolve.ts) and passes the result here as
// plain strings with formatting flags. This file only lays them out: nothing it receives is evaluated as markup.
//
// Inputs (JSON strings in sys.inputs, as the built-ins):
//   data    the document snapshot (letterhead, number, date, signatory — as letterhead.typ expects)
//   render  {specimen: bool, logo: string | none, title: string}
//   layout  {v: 1, page: {letterhead, footer, fontSize, margins}, blocks: [...]} — see ResolvedLayout
// Changing this file changes every designed document issued afterwards (stored PDFs never change).
#import "letterhead.typ": letterhead, place-date, LONG-TOKEN, TOKEN-CHUNK

#let d = json(bytes(sys.inputs.data))
#let r = json(bytes(sys.inputs.render))
#let L = json(bytes(sys.inputs.layout))
#let ar = d.lang == "ar"
#let page-settings = L.page

#let FONT-SIZES = (small: 10.5pt, normal: 11.5pt, large: 12.5pt)
#let MARGINS = (narrow: 1.6cm, normal: 2.2cm, wide: 2.8cm)
#let SPACERS = (small: 0.6em, medium: 1.5em, large: 3em)
#let MAX-PAGES = 5

// One run: its text (a `\n` is a line break), then bold / italic / underline as flagged. Only flagged properties are
// set, so a run inside a bold title stays bold.
#let run(x) = {
  let parts = x.t.split("\n")
  let body = parts.join(linebreak())
  if body == none { body = [] }
  if x.at("b", default: false) { body = text(weight: "bold", body) }
  if x.at("i", default: false) { body = text(style: "italic", body) }
  if x.at("u", default: false) { body = underline(body) }
  body
}
#let runs(xs) = xs.map(run).join()

#let align-of(a) = if a == "center" { center } else if a == "end" { end } else { start }

#let paragraph(b) = {
  let body = runs(b.runs)
  if body == none {
    // an empty paragraph keeps its line (vertical space)
    par(hide[x])
  } else if b.align == "justify" {
    par(justify: true, body)
  } else {
    align(align-of(b.align), par(justify: false, body))
  }
}

#let signature-block(a) = {
  v(2.2em)
  align(align-of(a), block(width: 45%, {
    set align(center)
    place-date(d)
    v(0.8em)
    text(weight: "bold", d.signatory.title)
    linebreak()
    d.signatory.name
    v(3.2em)
  }))
}

#let parts = d.issueDate.split("-").map(int)
#set document(
  title: r.at("title", default: "") + " " + d.number,
  author: d.company.legalName,
  date: datetime(year: parts.at(0), month: parts.at(1), day: parts.at(2), hour: 0, minute: 0, second: 0),
)
#set page(
  paper: "a4",
  margin: (x: MARGINS.at(page-settings.margins), top: 1.8cm, bottom: 2.4cm),
  footer: if page-settings.footer and d.company.footer != none {
    set align(center)
    line(length: 100%, stroke: 0.4pt + luma(60%))
    v(-0.4em)
    text(size: 8pt, fill: luma(35%), d.company.footer)
  },
  background: if r.at("specimen", default: false) {
    rotate(-40deg, text(size: 96pt, weight: "bold", fill: luma(88%), if ar { "نموذج" } else { "SPÉCIMEN" }))
  },
)
#set text(
  font: if ar { ("Cairo", "Source Sans 3") } else { ("Source Sans 3", "Cairo") },
  fallback: false,
  size: FONT-SIZES.at(page-settings.fontSize),
  lang: d.lang,
  region: "DZ",
  dir: if ar { rtl } else { ltr },
)
#set par(justify: true, leading: 0.85em, spacing: 1.2em)
// the built-ins' long-token rule (letterhead.typ › document-page)
#show regex("\S{" + str(LONG-TOKEN) + ",}"): it => it.text.clusters().chunks(TOKEN-CHUNK).map(c => c.join()).join(h(0.001pt))

#if page-settings.letterhead {
  letterhead(d, r)
  v(2.2em)
}

#for b in L.blocks {
  if b.type == "title" {
    align(align-of(b.align), text(size: 17pt, weight: "bold", tracking: if ar { 0pt } else { 0.06em }, runs(b.runs)))
    v(2em)
  } else if b.type == "heading" {
    block(above: 1.4em, below: 0.9em, align(align-of(b.align), text(size: 13pt, weight: "bold", runs(b.runs))))
  } else if b.type == "paragraph" {
    paragraph(b)
  } else if b.type == "list" {
    let items = b.items.map(i => { let c = runs(i); if c == none { [] } else { c } })
    if b.ordered { enum(..items) } else { list(..items) }
  } else if b.type == "table" {
    let total = b.widths.sum()
    let cells = ()
    for (ri, row) in b.rows.enumerate() {
      for cell in row {
        let c = runs(cell)
        if c == none { c = [] }
        cells.push(if b.headerRow and ri == 0 { text(weight: "bold", c) } else { c })
      }
    }
    table(
      columns: b.widths.map(w => w / total * 100%),
      inset: (x: 0.7em, y: 0.55em),
      stroke: if b.borders { 0.5pt + luma(55%) } else { none },
      align: start + horizon,
      ..cells,
    )
  } else if b.type == "positions" {
    if b.items.len() <= 1 {
      pad(x: 1.5em, runs(b.items.at(0, default: ())))
    } else {
      pad(x: 1.5em, list(..b.items.map(runs)))
    }
  } else if b.type == "signature" {
    signature-block(b.align)
  } else if b.type == "spacer" {
    v(SPACERS.at(b.size))
  } else if b.type == "divider" {
    line(length: 100%, stroke: 0.6pt + luma(40%))
  } else if b.type == "pageBreak" {
    pagebreak(weak: true)
  }
}

// At most MAX-PAGES pages: the API maps this error to 422 document-template-too-long.
#context {
  let n = counter(page).final().first()
  if n > MAX-PAGES { panic("document-template-too-long") }
}
