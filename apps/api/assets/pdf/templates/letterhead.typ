// Shared page layout of every generated HR document (ADR 008, docs/contracts/documents.md › Wording).
// Changing this shared layout changes every document: bump all three TEMPLATE_VERSIONS (apps/api/src/modules/documents/domain/types.ts).
//
// Data reaches templates ONLY as JSON strings in `sys.inputs` (strings are content, never evaluated as markup):
//   sys.inputs.data    the document snapshot (DocumentSnapshot, every value already formatted by the API)
//   sys.inputs.render  {specimen: bool, logo: string | none} — rendering options that are not part of the record
// The company logo is a virtual file mapped by the API (mapShadow) at the path given in `render.logo`.
// No wall clock: the PDF date is the issue date, so the same snapshot always gives the same bytes.

#let load() = (json(bytes(sys.inputs.data)), json(bytes(sys.inputs.render)))

#let is-ar(d) = d.lang == "ar"

// Long unbroken values (see document-page): a run of LONG-TOKEN or more non-space characters may break every
// TOKEN-CHUNK characters.
#let LONG-TOKEN = 40
#let TOKEN-CHUNK = 8

// Latin text inside Arabic paragraphs (numbers, matricules) keeps its own direction thanks to the Unicode bidi
// algorithm; `ltr-box` forces it for a whole run (the document number).
#let ltr-box(body) = box(text(dir: ltr, body))

#let letterhead(d, r) = {
  let c = d.company
  let ar = is-ar(d)
  grid(
    columns: (1fr, auto),
    column-gutter: 1.2em,
    align: (start + top, end + top),
    {
      if r.at("logo", default: none) != none {
        image(r.logo, height: 1.5cm)
        v(0.3em, weak: true)
      }
      text(weight: "bold", size: 12.5pt, c.legalName)
      linebreak()
      text(size: 9.5pt, c.address)
      let contact = (c.phone, c.email).filter(x => x != none)
      if contact.len() > 0 {
        linebreak()
        text(size: 9pt, contact.map(ltr-box).join("  ·  "))
      }
      for id in c.ids {
        linebreak()
        text(size: 8.5pt, [#id.label : #ltr-box(id.value)])
      }
    },
    text(size: 10.5pt, [#(if ar { "رقم" } else { "N°" }) #ltr-box(text(weight: "bold", d.number))]),
  )
  v(0.4em)
  line(length: 100%, stroke: 0.6pt + luma(40%))
}

#let place-date(d) = {
  let city = d.company.city
  if is-ar(d) [حرر في #city بتاريخ #d.issueDateText] else [Fait à #city, le #d.issueDateText]
}

#let signature(d) = {
  v(2.2em)
  align(end, block(width: 45%, {
    set align(center)
    place-date(d)
    v(0.8em)
    text(weight: "bold", d.signatory.title)
    linebreak()
    d.signatory.name
    v(3.2em)
  }))
}

// Gender agreement from the employee's sex ("M", "F" or none): the masculine, feminine and unknown forms.
#let agree(d, m, f, x) = {
  let s = d.employee.at("sex", default: none)
  if s == "M" { m } else if s == "F" { f } else { x }
}

// The page: A4, fonts (Cairo first for Arabic, Source Sans 3 first for French), direction, justification,
// footer, and the diagonal SPÉCIMEN / نموذج watermark of previews.
#let document-page(d, r, title: "", body) = {
  let ar = is-ar(d)
  let parts = d.issueDate.split("-").map(int)
  set document(
    title: title + " " + d.number,
    author: d.company.legalName,
    date: datetime(year: parts.at(0), month: parts.at(1), day: parts.at(2), hour: 0, minute: 0, second: 0),
  )
  set page(
    paper: "a4",
    margin: (x: 2.2cm, top: 1.8cm, bottom: 2.4cm),
    footer: if d.company.footer != none {
      set align(center)
      line(length: 100%, stroke: 0.4pt + luma(60%))
      v(-0.4em)
      text(size: 8pt, fill: luma(35%), d.company.footer)
    },
    background: if r.at("specimen", default: false) {
      rotate(-40deg, text(size: 96pt, weight: "bold", fill: luma(88%), if ar { "نموذج" } else { "SPÉCIMEN" }))
    },
  )
  set text(
    font: if ar { ("Cairo", "Source Sans 3") } else { ("Source Sans 3", "Cairo") },
    // only the vendored fonts: no fallback to whatever the host has (same bytes on every machine)
    fallback: false,
    size: 11.5pt,
    lang: d.lang,
    region: "DZ",
    dir: if ar { rtl } else { ltr },
  )
  set par(justify: true, leading: 0.85em, spacing: 1.2em)
  // A long unbroken value (a 200-character name, address or title typed without spaces) has no break opportunity
  // and would run past the margin. In a run of LONG-TOKEN or more non-space characters, a 0.001pt space every
  // TOKEN-CHUNK characters gives the line breaker a place to break (h(0pt) would be dropped; a zero-width space
  // character would end up in the PDF text layer and garble copy/search of the glyph it is attached to).
  // An Arabic run loses its joining only at those points. Ordinary words, numbers, e-mails and identifiers are
  // shorter than LONG-TOKEN, so documents without such a value typeset exactly as before (same bytes).
  show regex("\S{" + str(LONG-TOKEN) + ",}"): it => it.text.clusters().chunks(TOKEN-CHUNK).map(c => c.join()).join(h(0.001pt))
  letterhead(d, r)
  v(2.2em)
  align(center, text(size: 17pt, weight: "bold", tracking: if ar { 0pt } else { 0.06em }, title))
  v(2em)
  body
}
