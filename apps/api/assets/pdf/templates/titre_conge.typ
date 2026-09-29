// titre_conge@2 — Titre de congé / سند عطلة (docs/contracts/documents.md › Wording). From an APPROVED leave request.
// Changing the wording means a new version: bump TEMPLATE_VERSIONS in apps/api/src/modules/documents/domain/types.ts.
#import "letterhead.typ": *

#let (d, r) = load()
#let e = d.employee
#let l = d.leave
#let ar = is-ar(d)

#show: document-page.with(d, r, title: if ar { "سند عطلة" } else { "TITRE DE CONGÉ" })

#let row(label, value) = (text(weight: "bold", label), value)

// The day count in Arabic, with the counted noun agreeing with the number (nominative, after « أي ما مجموعه »):
// 1 → يوم واحد, 2 → يومان, 3–10 → N أيام, 11–99 → N يومًا, and for 100 and more by the last two digits
// (00–02 → N يوم, 03–10 → N أيام, 11–99 → N يومًا). Half days: 0.5 → نصف يوم, otherwise N يوم (e.g. 2.5 يوم).
#let ar-days(days) = {
  if days.contains(".") {
    if days == "0.5" { "نصف يوم" } else { days + " يوم" }
  } else {
    let n = int(days)
    let tail = calc.rem(n, 100)
    if n == 1 { "يوم واحد" } else if n == 2 { "يومان" } else if tail >= 3 and tail <= 10 { days + " أيام" } else if tail >= 11 {
      days + " يومًا"
    } else { days + " يوم" }
  }
}

#if ar [
  يرخص #agree(d, "للسيد", "للسيدة", "للسيد(ة)") #text(weight: "bold", e.fullName) بالاستفادة من #l.typeLabel من #l.startText إلى #l.endText، أي ما مجموعه #ar-days(l.days).
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
