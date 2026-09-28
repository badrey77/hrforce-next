// titre_conge@1 — Titre de congé / سند عطلة (docs/contracts/documents.md › Wording). From an APPROVED leave request.
// Changing the wording means a new version: bump TEMPLATE_VERSIONS in apps/api/src/modules/documents/domain/templates.ts.
#import "letterhead.typ": *

#let (d, r) = load()
#let e = d.employee
#let l = d.leave
#let ar = is-ar(d)

#show: document-page.with(d, r, title: if ar { "سند عطلة" } else { "TITRE DE CONGÉ" })

#let row(label, value) = (text(weight: "bold", label), value)

#if ar [
  يرخص #agree(d, "للسيد", "للسيدة", "للسيد(ة)") #text(weight: "bold", e.fullName) بالاستفادة من #l.typeLabel من #l.startText إلى #l.endText.
] else [
  #e.civility #text(weight: "bold", e.fullName) est #agree(d, "autorisé", "autorisée", "autorisé(e)") à bénéficier d'un congé (#l.typeLabel) du #l.startText au #l.endText inclus, soit #l.days #(if l.days == "1" or l.days == "0,5" { "jour" } else { "jours" }).
]

#v(0.6em)
#table(
  columns: (38%, 1fr),
  inset: (x: 0.7em, y: 0.55em),
  stroke: 0.5pt + luma(55%),
  align: start + horizon,
  ..(if ar {
    (
      row("الموظف(ة)", e.fullName),
      row("رقم التسجيل", e.matricule),
      row("الهيكل", e.unitName),
      row("الوظيفة", e.jobTitle),
      row("نوع العطلة", l.typeLabel),
      row("من", l.startText),
      row("إلى", l.endText),
      row("عدد الأيام", l.days),
      row("تاريخ استئناف العمل", l.resumptionText),
    )
  } else {
    (
      row("Employé(e)", e.fullName),
      row("Matricule", e.matricule),
      row("Structure", e.unitName),
      row("Fonction", e.jobTitle),
      row("Type de congé", l.typeLabel),
      row("Du", l.startText),
      row("Au", l.endText),
      row("Nombre de jours", l.days),
      row("Date de reprise", l.resumptionText),
    )
  }).flatten()
)

#signature(d)
