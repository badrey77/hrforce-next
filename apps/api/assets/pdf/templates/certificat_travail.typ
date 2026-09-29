// certificat_travail@2 — Certificat de travail / شهادة نهاية العمل (docs/contracts/documents.md › Wording).
// Ended employments only; the end reason is NOT printed. Positions: consecutive distinct job titles.
// Changing the wording means a new version: bump TEMPLATE_VERSIONS in apps/api/src/modules/documents/domain/types.ts.
#import "letterhead.typ": *

#let (d, r) = load()
#let e = d.employee
#let ar = is-ar(d)
#let positions = e.at("positions", default: ())

#show: document-page.with(d, r, title: if ar { "شهادة نهاية العمل" } else { "CERTIFICAT DE TRAVAIL" })

#if ar [
  نشهد نحن الموقعين أدناه، #d.company.legalName، بأن #e.civility #text(weight: "bold", e.fullName)#if e.birthDateText != none [، #agree(d, "المولود", "المولودة", "المولود(ة)") في #e.birthDateText#if e.birthPlace != none [ بـ#e.birthPlace]]، رقم التسجيل #e.matricule، #agree(d, "عمل", "عملت", "عمل(ت)") لدى مؤسستنا من #e.hireDateText إلى #e.endDateText بصفة:
] else [
  Nous soussignés, #d.company.legalName, certifions que #e.civility #text(weight: "bold", e.fullName)#if e.birthDateText != none [, #agree(d, "né", "née", "né(e)") le #e.birthDateText#if e.birthPlace != none [ à #e.birthPlace]], matricule #e.matricule, a été #agree(d, "employé", "employée", "employé(e)") au sein de notre organisme du #e.hireDateText au #e.endDateText en qualité de :
]

#if positions.len() <= 1 {
  pad(x: 1.5em, text(weight: "bold", if positions.len() == 1 { positions.at(0).jobTitle } else { e.jobTitle }))
} else {
  pad(x: 1.5em, list(..positions.map(p => if ar [#text(weight: "bold", p.jobTitle) من #p.fromText إلى #p.toText] else [#text(weight: "bold", p.jobTitle) du #p.fromText au #p.toText])))
}

#if ar [
  #agree(d, "وهو حر", "وهي حرة", "وهو(هي) حر(ة)") من كل التزام تجاه مؤسستنا.

  سلمت هذه الشهادة لاستعمالها في حدود ما يسمح به القانون.
] else [
  #e.civility #e.fullName est #agree(d, "libre", "libre", "libre") de tout engagement envers notre organisme.

  Le présent certificat est délivré pour servir et valoir ce que de droit.
]

#signature(d)
