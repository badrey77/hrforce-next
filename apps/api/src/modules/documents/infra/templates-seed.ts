/*
 * Demo designed templates of `seed:dev` (docs/contracts/document-templates.md › Seed): a custom type « Ordre de
 * mission » / « أمر بمهمة » with a published version 1 and five fields, and the attestation de travail with a published
 * designed version 1 (the built-in wording with another closing sentence) and a draft version 2. The certificat and
 * the titre stay built-in. Runs as the MIGRATOR (owner, BYPASSRLS): company_id written explicitly. Idempotent: fixed
 * ids, `on conflict do nothing`, and nothing is done when the company already has template versions.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../platform/db/schema.js';
import { builtinLayout } from '../domain/builtin-layouts.js';
import type { Block, Inline, LeafInline, TemplateField, TemplateLayout } from '../domain/template-layout.js';

type Executor = Kysely<DB> | Transaction<DB>;

const fixed = (n: number) => `0190a5d0-0000-7000-8030-${n.toString(16).padStart(12, '0')}`;

export const DEMO_TEMPLATES = {
  ordreMissionType: fixed(1),
  ordreMissionV1: fixed(2),
  attestationV1: fixed(3),
  attestationV2: fixed(4),
} as const;

export const ORDRE_MISSION_FIELDS: TemplateField[] = [
  { key: 'destination', kind: 'text', labels: { fr: 'Destination', ar: 'الوجهة' }, required: true },
  { key: 'objet', kind: 'longText', labels: { fr: 'Objet de la mission', ar: 'موضوع المهمة' }, required: true },
  { key: 'depart', kind: 'date', labels: { fr: 'Date de départ', ar: 'تاريخ الذهاب' }, required: true },
  { key: 'retour', kind: 'date', labels: { fr: 'Date de retour', ar: 'تاريخ العودة' }, required: true },
  {
    key: 'transport',
    kind: 'choice',
    labels: { fr: 'Moyen de transport', ar: 'وسيلة النقل' },
    required: false,
    options: [
      { value: 'vehicule_service', labels: { fr: 'Véhicule de service', ar: 'سيارة المصلحة' } },
      { value: 'transport_public', labels: { fr: 'Transport public', ar: 'النقل العمومي' } },
      { value: 'avion', labels: { fr: 'Avion', ar: 'الطائرة' } },
    ],
  },
];

const t = (text: string, bold = false): LeafInline => ({ t: 'text', text, ...(bold ? { bold: true as const } : {}) });
const v = (key: string, bold = false): LeafInline => ({ t: 'var', key, ...(bold ? { bold: true as const } : {}) });
const page = { letterhead: true, footer: true, fontSize: 'normal' as const, margins: 'normal' as const };

function ordreMission(lang: 'fr' | 'ar'): TemplateLayout {
  const ar = lang === 'ar';
  const row = (label: string, value: Inline[]): Inline[][] => [[t(label, true)], value];
  const blocks: Block[] = [
    { id: 'title', type: 'title', align: 'center', content: [t(ar ? 'أمر بمهمة' : 'ORDRE DE MISSION')] },
    {
      id: 'intro',
      type: 'paragraph',
      align: 'justify',
      content: ar
        ? [t('يؤمر '), { t: 'gender', m: 'السيد', f: 'السيدة', x: 'السيد(ة)' }, t(' '), v('employee.fullName', true), t('، '), v('employee.jobTitle'), t(' ('), v('employee.unit'), t(')، بالتنقل في مهمة وفق ما يلي:')]
        : [v('employee.civility'), t(' '), v('employee.fullName', true), t(', '), v('employee.jobTitle'), t(' ('), v('employee.unit'), t('), est '), { t: 'gender', m: 'chargé', f: 'chargée', x: 'chargé(e)' }, t(' de la mission suivante :')],
    },
    {
      id: 'table',
      type: 'table',
      widths: [4, 6],
      headerRow: false,
      borders: true,
      rows: [
        row(ar ? 'رقم التسجيل' : 'Matricule', [v('employee.matricule')]),
        row(ar ? 'الوجهة' : 'Destination', [v('field.destination')]),
        row(ar ? 'موضوع المهمة' : 'Objet', [v('field.objet')]),
        row(ar ? 'تاريخ الذهاب' : 'Départ', [v('field.depart')]),
        row(ar ? 'تاريخ العودة' : 'Retour', [v('field.retour')]),
        row(ar ? 'وسيلة النقل' : 'Transport', [{ t: 'optional', key: 'field.transport', content: [v('field.transport')] }]),
      ],
    },
    {
      id: 'closing',
      type: 'paragraph',
      align: 'justify',
      content: [t(ar ? 'تطلب السلطات المدنية والعسكرية تسهيل مهمة ' : 'Les autorités civiles et militaires sont priées de faciliter la mission de '), { t: 'gender', m: ar ? 'المعني' : "l'intéressé", f: ar ? 'المعنية' : "l'intéressée", x: ar ? 'المعني(ة)' : "l'intéressé(e)" }, t('.')],
    },
    { id: 'sign', type: 'signature', align: 'end' },
  ];
  return { v: 1, page, blocks };
}

/** The built-in attestation with another closing sentence (demo of a company's own wording). */
function attestation(lang: 'fr' | 'ar', version: 1 | 2): TemplateLayout {
  const layout = builtinLayout('attestation_travail', lang);
  const closing =
    lang === 'ar'
      ? version === 1
        ? 'سلمت هذه الشهادة بطلب من المعني(ة) للإدلاء بها لدى الجهات المعنية.'
        : 'سلمت هذه الشهادة بطلب من المعني(ة) للإدلاء بها لدى الجهات المعنية، وهي صالحة لمدة ثلاثة أشهر.'
      : version === 1
        ? 'La présente attestation est délivrée à la demande de l’intéressé(e) pour être remise à qui de droit.'
        : 'La présente attestation est délivrée à la demande de l’intéressé(e) pour être remise à qui de droit. Elle est valable trois mois.';
  const blocks = layout.blocks.map((b, i) => (i === 2 && b.type === 'paragraph' ? { ...b, content: [t(closing)] } : b));
  return { ...layout, blocks };
}

/** DEMO: the ordre de mission type and the attestation's designed versions (skipped when versions exist). */
export async function seedDemoTemplates(db: Executor, companyId: string, adminUserId: string): Promise<{ types: number; versions: number }> {
  const existing = await db.selectFrom('document_template_version').select('id').where('company_id', '=', companyId).limit(1).executeTakeFirst();
  if (existing) return { types: 0, versions: 0 };
  const insertVersion = async (id: string, typeId: string, version: number, status: 'draft' | 'published', layouts: object, fields: TemplateField[], basedOn: string, note: string) => {
    const published = status === 'published';
    await sql`
      insert into document_template_version (id, company_id, document_type_id, version, status, layouts, fields, based_on, note, created_by, updated_by,
                                             published_by, published_at, created_at, updated_at)
      values (${id}::uuid, ${companyId}::uuid, ${typeId}::uuid, ${version}, ${status}, ${JSON.stringify(layouts)}::jsonb, ${JSON.stringify(fields)}::jsonb,
              ${basedOn}, ${note}, ${adminUserId}::uuid, ${adminUserId}::uuid, ${published ? adminUserId : null}::uuid,
              ${published ? sql`now()` : null}, now(), now())
      on conflict do nothing`.execute(db);
  };

  await sql`
    insert into document_type (id, company_id, code, kind, template_mode, name_fr, name_ar, name_en, subject, employment_rule, number_format, languages, self_service, active, sort_order)
    values (${DEMO_TEMPLATES.ordreMissionType}::uuid, ${companyId}::uuid, 'ordre_mission', 'custom', 'designed', 'Ordre de mission', 'أمر بمهمة', 'Mission order',
            'employment', 'active', 'OM-{YYYY}-{SEQ:4}', '{fr,ar}', false, false, 40)
    on conflict do nothing`.execute(db);
  await insertVersion(DEMO_TEMPLATES.ordreMissionV1, DEMO_TEMPLATES.ordreMissionType, 1, 'published', { fr: ordreMission('fr'), ar: ordreMission('ar') }, ORDRE_MISSION_FIELDS, 'blank', 'Première version');
  await sql`update document_type set template_mode = 'designed', published_template_id = ${DEMO_TEMPLATES.ordreMissionV1}::uuid, active = true
    where company_id = ${companyId}::uuid and id = ${DEMO_TEMPLATES.ordreMissionType}::uuid`.execute(db);

  const attestationType = await db.selectFrom('document_type').select('id').where('company_id', '=', companyId).where('code', '=', 'attestation_travail').executeTakeFirstOrThrow();
  await insertVersion(DEMO_TEMPLATES.attestationV1, attestationType.id, 1, 'published', { fr: attestation('fr', 1), ar: attestation('ar', 1) }, [], 'builtin:attestation_travail@2', 'Formule de clôture de l’entreprise');
  await insertVersion(DEMO_TEMPLATES.attestationV2, attestationType.id, 2, 'draft', { fr: attestation('fr', 2), ar: attestation('ar', 2) }, [], DEMO_TEMPLATES.attestationV1, 'Validité de trois mois (brouillon)');
  await sql`update document_type set template_mode = 'designed', published_template_id = ${DEMO_TEMPLATES.attestationV1}::uuid
    where company_id = ${companyId}::uuid and id = ${attestationType.id}::uuid`.execute(db);
  return { types: 1, versions: 3 };
}
