/**
 * The designer's own texts. The host passes them through the `labels` input or the {@link DESIGNER_LABELS} token;
 * without either, the package's defaults for the UI language apply (fr, ar, en). Keys are flat on purpose: the host
 * can build them from any i18n library.
 */
import { InjectionToken } from '@angular/core';

export interface DesignerLabels {
  readonly blocks: string;
  readonly page: string;
  readonly placeholders: string;
  readonly fields: string;
  readonly properties: string;
  readonly searchPlaceholders: string;
  readonly noPlaceholder: string;
  readonly insert: string;
  readonly blockType: Readonly<Record<string, string>>;
  readonly letterhead: string;
  readonly footer: string;
  readonly fontSize: string;
  readonly fontSizes: Readonly<Record<'small' | 'normal' | 'large', string>>;
  readonly margins: string;
  readonly marginSizes: Readonly<Record<'narrow' | 'normal' | 'wide', string>>;
  readonly letterheadArea: string;
  readonly footerArea: string;
  readonly emptyCanvas: string;
  readonly moveUp: string;
  readonly moveDown: string;
  readonly duplicate: string;
  readonly remove: string;
  readonly undo: string;
  readonly redo: string;
  readonly removed: string;
  readonly bold: string;
  readonly italic: string;
  readonly underline: string;
  readonly align: string;
  readonly alignments: Readonly<Record<'start' | 'center' | 'end' | 'justify', string>>;
  readonly when: string;
  readonly whenAlways: string;
  readonly ordered: string;
  readonly addItem: string;
  readonly removeItem: string;
  readonly columns: string;
  readonly rows: string;
  readonly widths: string;
  readonly headerRow: string;
  readonly borders: string;
  readonly spacerSize: string;
  readonly spacerSizes: Readonly<Record<'small' | 'medium' | 'large', string>>;
  readonly signatureHint: string;
  readonly positionsHint: string;
  readonly pageBreakHint: string;
  readonly noSelection: string;
  readonly gender: string;
  readonly genderM: string;
  readonly genderF: string;
  readonly genderX: string;
  readonly insertGender: string;
  readonly optional: string;
  readonly optionalContent: string;
  readonly insertOptional: string;
  readonly optionalKey: string;
  readonly chip: string;
  readonly removeChip: string;
  readonly addField: string;
  readonly fieldKey: string;
  readonly fieldKind: string;
  readonly fieldKinds: Readonly<Record<'text' | 'longText' | 'date' | 'number' | 'choice', string>>;
  readonly fieldLabelFr: string;
  readonly fieldLabelAr: string;
  readonly fieldRequired: string;
  readonly fieldOptions: string;
  readonly addOption: string;
  readonly optionValue: string;
  readonly noFields: string;
  readonly fieldsHint: string;
  readonly fieldKeyInvalid: string;
  readonly fieldKeyTaken: string;
  readonly preview: string;
  readonly readonly: string;
  readonly problems: string;
  readonly signaturePreview: string;
  readonly positionsPreview: string;
  readonly limits: string;
  readonly textCount: string;
  readonly dragHandle: string;
  readonly fieldsGroup: string;
  readonly signatureAlign: string;
  readonly cell: string;
  readonly item: string;
  readonly typeBracket: string;
  readonly groups: Readonly<Record<string, string>>;
}

const FR: DesignerLabels = {
  blocks: 'Blocs',
  page: 'Page',
  placeholders: 'Champs à insérer',
  fields: 'Champs à saisir',
  properties: 'Propriétés',
  searchPlaceholders: 'Rechercher un champ',
  noPlaceholder: 'Aucun champ trouvé',
  insert: 'Insérer',
  blockType: {
    title: 'Titre',
    heading: 'Intertitre',
    paragraph: 'Paragraphe',
    list: 'Liste',
    table: 'Tableau',
    positions: 'Postes occupés',
    signature: 'Signature',
    spacer: 'Espace',
    divider: 'Trait',
    pageBreak: 'Saut de page',
  },
  letterhead: 'En-tête de l’entreprise',
  footer: 'Pied de page',
  fontSize: 'Taille du texte',
  fontSizes: { small: 'Petite', normal: 'Normale', large: 'Grande' },
  margins: 'Marges',
  marginSizes: { narrow: 'Étroites', normal: 'Normales', wide: 'Larges' },
  letterheadArea: 'En-tête de l’entreprise et numéro du document',
  footerArea: 'Pied de page de l’entreprise',
  emptyCanvas: 'Le modèle est vide : ajoutez un bloc depuis la liste « Blocs ».',
  moveUp: 'Monter',
  moveDown: 'Descendre',
  duplicate: 'Dupliquer',
  remove: 'Supprimer',
  undo: 'Annuler',
  redo: 'Rétablir',
  removed: 'Bloc supprimé.',
  bold: 'Gras',
  italic: 'Italique',
  underline: 'Souligné',
  align: 'Alignement',
  alignments: { start: 'Début', center: 'Centré', end: 'Fin', justify: 'Justifié' },
  when: 'Imprimer seulement si ce champ est connu',
  whenAlways: 'Toujours',
  ordered: 'Liste numérotée',
  addItem: 'Ajouter un élément',
  removeItem: 'Retirer l’élément',
  columns: 'Colonnes',
  rows: 'Lignes',
  widths: 'Largeurs relatives (1 à 10)',
  headerRow: 'Première ligne en en-tête',
  borders: 'Bordures',
  spacerSize: 'Hauteur',
  spacerSizes: { small: 'Petite', medium: 'Moyenne', large: 'Grande' },
  signatureHint: '« Fait à … le … », titre et nom du signataire, puis la place de la signature manuscrite.',
  positionsHint: 'La liste des postes occupés, avec leurs dates (certificat de travail).',
  pageBreakHint: 'La suite commence sur une nouvelle page.',
  noSelection: 'Sélectionnez un bloc pour voir ses propriétés.',
  gender: 'Accord selon le sexe',
  genderM: 'Masculin',
  genderF: 'Féminin',
  genderX: 'Sexe inconnu',
  insertGender: 'Insérer un accord',
  optional: 'Texte conditionnel',
  optionalContent: 'Texte imprimé si le champ est connu',
  insertOptional: 'Insérer un texte conditionnel',
  optionalKey: 'Champ à tester',
  chip: 'Élément sélectionné',
  removeChip: 'Retirer',
  addField: 'Ajouter un champ',
  fieldKey: 'Code',
  fieldKind: 'Type',
  fieldKinds: { text: 'Texte court', longText: 'Texte long', date: 'Date', number: 'Nombre', choice: 'Liste de choix' },
  fieldLabelFr: 'Libellé (français)',
  fieldLabelAr: 'Libellé (arabe)',
  fieldRequired: 'Obligatoire',
  fieldOptions: 'Choix',
  addOption: 'Ajouter un choix',
  optionValue: 'Code du choix',
  noFields: 'Aucun champ à saisir.',
  fieldsHint: 'Champs remplis par les RH au moment de l’émission (10 au plus).',
  fieldKeyInvalid: 'Minuscules, chiffres et « _ », en commençant par une lettre (30 caractères au plus).',
  fieldKeyTaken: 'Ce code est déjà utilisé.',
  preview: 'Aperçu PDF',
  readonly: 'Lecture seule',
  problems: 'Problèmes à corriger',
  signaturePreview: 'Fait à …, le …',
  positionsPreview: 'Poste — du … au …',
  limits: 'Limites',
  textCount: '{n} / {max} caractères',
  dragHandle: 'Déplacer',
  fieldsGroup: 'Champs à saisir',
  signatureAlign: 'Position',
  cell: 'Cellule {r}, {c}',
  item: 'Élément {n}',
  typeBracket: 'Tapez [ pour insérer un champ',
  groups: { document: 'Document', company: 'Entreprise', employee: 'Employé(e)', leave: 'Congé', signatory: 'Signataire', fields: 'Champs à saisir' },
};

const AR: DesignerLabels = {
  blocks: 'الكتل',
  page: 'الصفحة',
  placeholders: 'حقول للإدراج',
  fields: 'حقول تُملأ عند الإصدار',
  properties: 'الخصائص',
  searchPlaceholders: 'البحث عن حقل',
  noPlaceholder: 'لا يوجد حقل مطابق',
  insert: 'إدراج',
  blockType: {
    title: 'العنوان',
    heading: 'عنوان فرعي',
    paragraph: 'فقرة',
    list: 'قائمة',
    table: 'جدول',
    positions: 'المناصب المشغولة',
    signature: 'التوقيع',
    spacer: 'فراغ',
    divider: 'خط فاصل',
    pageBreak: 'فاصل صفحة',
  },
  letterhead: 'ترويسة المؤسسة',
  footer: 'تذييل الصفحة',
  fontSize: 'حجم النص',
  fontSizes: { small: 'صغير', normal: 'عادي', large: 'كبير' },
  margins: 'الهوامش',
  marginSizes: { narrow: 'ضيقة', normal: 'عادية', wide: 'واسعة' },
  letterheadArea: 'ترويسة المؤسسة ورقم الوثيقة',
  footerArea: 'تذييل المؤسسة',
  emptyCanvas: 'النموذج فارغ: يمكن إضافة كتلة من قائمة « الكتل ».',
  moveUp: 'نقل إلى الأعلى',
  moveDown: 'نقل إلى الأسفل',
  duplicate: 'نسخ',
  remove: 'حذف',
  undo: 'تراجع',
  redo: 'إعادة',
  removed: 'تم حذف الكتلة.',
  bold: 'غامق',
  italic: 'مائل',
  underline: 'تسطير',
  align: 'المحاذاة',
  alignments: { start: 'البداية', center: 'الوسط', end: 'النهاية', justify: 'ضبط' },
  when: 'الطباعة فقط عند توفر هذا الحقل',
  whenAlways: 'دائمًا',
  ordered: 'قائمة مرقمة',
  addItem: 'إضافة عنصر',
  removeItem: 'إزالة العنصر',
  columns: 'الأعمدة',
  rows: 'الأسطر',
  widths: 'العروض النسبية (من 1 إلى 10)',
  headerRow: 'السطر الأول عنوان',
  borders: 'الحدود',
  spacerSize: 'الارتفاع',
  spacerSizes: { small: 'صغير', medium: 'متوسط', large: 'كبير' },
  signatureHint: '« حرر في … بتاريخ … »، صفة الموقع واسمه، ثم مكان التوقيع باليد.',
  positionsHint: 'قائمة المناصب المشغولة بتواريخها (شهادة نهاية العمل).',
  pageBreakHint: 'يبدأ ما يلي في صفحة جديدة.',
  noSelection: 'يمكن اختيار كتلة لعرض خصائصها.',
  gender: 'المطابقة حسب الجنس',
  genderM: 'مذكر',
  genderF: 'مؤنث',
  genderX: 'جنس غير معروف',
  insertGender: 'إدراج مطابقة',
  optional: 'نص مشروط',
  optionalContent: 'النص المطبوع عند توفر الحقل',
  insertOptional: 'إدراج نص مشروط',
  optionalKey: 'الحقل المختبر',
  chip: 'العنصر المحدد',
  removeChip: 'إزالة',
  addField: 'إضافة حقل',
  fieldKey: 'الرمز',
  fieldKind: 'النوع',
  fieldKinds: { text: 'نص قصير', longText: 'نص طويل', date: 'تاريخ', number: 'رقم', choice: 'قائمة اختيارات' },
  fieldLabelFr: 'التسمية (بالفرنسية)',
  fieldLabelAr: 'التسمية (بالعربية)',
  fieldRequired: 'إلزامي',
  fieldOptions: 'الاختيارات',
  addOption: 'إضافة اختيار',
  optionValue: 'رمز الاختيار',
  noFields: 'لا توجد حقول تُملأ.',
  fieldsHint: 'حقول تملؤها الموارد البشرية عند الإصدار (10 على الأكثر).',
  fieldKeyInvalid: 'حروف لاتينية صغيرة وأرقام و« _ »، تبدأ بحرف (30 حرفًا على الأكثر).',
  fieldKeyTaken: 'هذا الرمز مستعمل.',
  preview: 'معاينة PDF',
  readonly: 'للاطلاع فقط',
  problems: 'مشاكل يجب تصحيحها',
  signaturePreview: 'حرر في … بتاريخ …',
  positionsPreview: 'المنصب — من … إلى …',
  limits: 'الحدود',
  textCount: '{n} / {max} حرف',
  dragHandle: 'نقل',
  fieldsGroup: 'حقول تُملأ عند الإصدار',
  signatureAlign: 'الموضع',
  cell: 'الخانة {r}، {c}',
  item: 'العنصر {n}',
  typeBracket: 'اكتب [ لإدراج حقل',
  groups: { document: 'الوثيقة', company: 'المؤسسة', employee: 'الموظف(ة)', leave: 'العطلة', signatory: 'الموقع', fields: 'حقول تُملأ عند الإصدار' },
};

const EN: DesignerLabels = {
  ...FR,
  blocks: 'Blocks',
  page: 'Page',
  placeholders: 'Placeholders',
  fields: 'Fields to fill in',
  properties: 'Properties',
  searchPlaceholders: 'Search placeholders',
  noPlaceholder: 'No placeholder found',
  insert: 'Insert',
  blockType: {
    title: 'Title',
    heading: 'Heading',
    paragraph: 'Paragraph',
    list: 'List',
    table: 'Table',
    positions: 'Positions held',
    signature: 'Signature',
    spacer: 'Space',
    divider: 'Line',
    pageBreak: 'Page break',
  },
  letterhead: 'Company letterhead',
  footer: 'Footer',
  fontSize: 'Text size',
  fontSizes: { small: 'Small', normal: 'Normal', large: 'Large' },
  margins: 'Margins',
  marginSizes: { narrow: 'Narrow', normal: 'Normal', wide: 'Wide' },
  letterheadArea: 'Company letterhead and document number',
  footerArea: 'Company footer',
  emptyCanvas: 'The template is empty: add a block from the “Blocks” list.',
  moveUp: 'Move up',
  moveDown: 'Move down',
  duplicate: 'Duplicate',
  remove: 'Delete',
  undo: 'Undo',
  redo: 'Redo',
  removed: 'Block deleted.',
  bold: 'Bold',
  italic: 'Italic',
  underline: 'Underline',
  align: 'Alignment',
  alignments: { start: 'Start', center: 'Centre', end: 'End', justify: 'Justified' },
  when: 'Print only when this placeholder is known',
  whenAlways: 'Always',
  ordered: 'Numbered list',
  addItem: 'Add an item',
  removeItem: 'Remove the item',
  columns: 'Columns',
  rows: 'Rows',
  widths: 'Relative widths (1 to 10)',
  headerRow: 'First row as header',
  borders: 'Borders',
  spacerSize: 'Height',
  spacerSizes: { small: 'Small', medium: 'Medium', large: 'Large' },
  signatureHint: '“Done at … on …”, the signatory’s title and name, then room for the handwritten signature.',
  positionsHint: 'The positions held, with their dates (certificate of employment).',
  pageBreakHint: 'What follows starts on a new page.',
  noSelection: 'Select a block to see its properties.',
  gender: 'Agreement by sex',
  genderM: 'Masculine',
  genderF: 'Feminine',
  genderX: 'Sex unknown',
  insertGender: 'Insert an agreement',
  optional: 'Conditional text',
  optionalContent: 'Text printed when the placeholder is known',
  insertOptional: 'Insert conditional text',
  optionalKey: 'Placeholder to test',
  chip: 'Selected item',
  removeChip: 'Remove',
  addField: 'Add a field',
  fieldKey: 'Code',
  fieldKind: 'Kind',
  fieldKinds: { text: 'Short text', longText: 'Long text', date: 'Date', number: 'Number', choice: 'Choice list' },
  fieldLabelFr: 'Label (French)',
  fieldLabelAr: 'Label (Arabic)',
  fieldRequired: 'Required',
  fieldOptions: 'Choices',
  addOption: 'Add a choice',
  optionValue: 'Choice code',
  noFields: 'No field to fill in.',
  fieldsHint: 'Fields HR fills in when issuing (10 at most).',
  fieldKeyInvalid: 'Lower-case letters, digits and “_”, starting with a letter (30 characters at most).',
  fieldKeyTaken: 'This code is already used.',
  preview: 'PDF preview',
  readonly: 'Read-only',
  problems: 'Problems to fix',
  signaturePreview: 'Done at …, on …',
  positionsPreview: 'Position — from … to …',
  limits: 'Limits',
  textCount: '{n} / {max} characters',
  dragHandle: 'Move',
  fieldsGroup: 'Fields to fill in',
  signatureAlign: 'Position',
  cell: 'Cell {r}, {c}',
  item: 'Item {n}',
  typeBracket: 'Type [ to insert a placeholder',
  groups: { document: 'Document', company: 'Company', employee: 'Employee', leave: 'Leave', signatory: 'Signatory', fields: 'Fields to fill in' },
};

export const DEFAULT_DESIGNER_LABELS: Readonly<Record<'fr' | 'ar' | 'en', DesignerLabels>> = { fr: FR, ar: AR, en: EN };

/** Optional app-wide override of the designer's texts per UI language. */
export const DESIGNER_LABELS = new InjectionToken<Partial<Record<'fr' | 'ar' | 'en', DesignerLabels>>>('DESIGNER_LABELS');

/** `{n}`-style interpolation. */
export function fill(text: string, values: Readonly<Record<string, string | number>>): string {
  return text.replace(/\{(\w+)\}/g, (all, name: string) => (name in values ? String(values[name]) : all));
}
