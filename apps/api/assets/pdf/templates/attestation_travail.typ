// attestation_travail@1 — Attestation de travail / شهادة عمل (docs/contracts/documents.md › Wording).
// Changing the wording means a new version: bump TEMPLATE_VERSIONS in apps/api/src/modules/documents/domain/templates.ts.
#import "letterhead.typ": *

#let (d, r) = load()
#let e = d.employee
#let ar = is-ar(d)

#show: document-page.with(d, r, title: if ar { "شهادة عمل" } else { "ATTESTATION DE TRAVAIL" })

#if ar [
  تشهد #d.company.legalName بأن #e.civility #text(weight: "bold", e.fullName)#if e.birthDateText != none [، #agree(d, "المولود", "المولودة", "المولود(ة)") في #e.birthDateText#if e.birthPlace != none [ بـ#e.birthPlace]]، رقم التسجيل #e.matricule، #agree(d, "يعمل", "تعمل", "يعمل(تعمل)") لدى مؤسستنا منذ #e.hireDateText بصفة #e.jobTitle (#e.unitName).

  سلمت هذه الشهادة #agree(d, "للمعني بطلب منه", "للمعنية بطلب منها", "للمعني(ة) بطلب منه") لاستعمالها في حدود ما يسمح به القانون.
] else [
  Nous soussignés, #d.company.legalName, attestons que #e.civility #text(weight: "bold", e.fullName)#if e.birthDateText != none [, #agree(d, "né", "née", "né(e)") le #e.birthDateText#if e.birthPlace != none [ à #e.birthPlace]], matricule #e.matricule, est #agree(d, "employé", "employée", "employé(e)") au sein de notre organisme depuis le #e.hireDateText en qualité de #e.jobTitle (#e.unitName).

  La présente attestation est délivrée à #agree(d, "l'intéressé", "l'intéressée", "l'intéressé(e)"), sur sa demande, pour servir et valoir ce que de droit.
]

#signature(d)
