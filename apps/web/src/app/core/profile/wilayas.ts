/** The 58 wilayas (code `01`–`58`) with their names in fr / ar / en, for the address forms and views. */
export interface Wilaya {
  readonly code: string;
  readonly fr: string;
  readonly ar: string;
  readonly en: string;
}

const W = (code: string, fr: string, ar: string, en: string = fr): Wilaya => ({ code, fr, ar, en });

export const WILAYAS: readonly Wilaya[] = [
  W('01', 'Adrar', 'أدرار'),
  W('02', 'Chlef', 'الشلف'),
  W('03', 'Laghouat', 'الأغواط'),
  W('04', 'Oum El Bouaghi', 'أم البواقي'),
  W('05', 'Batna', 'باتنة'),
  W('06', 'Béjaïa', 'بجاية', 'Bejaia'),
  W('07', 'Biskra', 'بسكرة'),
  W('08', 'Béchar', 'بشار', 'Bechar'),
  W('09', 'Blida', 'البليدة'),
  W('10', 'Bouira', 'البويرة'),
  W('11', 'Tamanrasset', 'تمنراست'),
  W('12', 'Tébessa', 'تبسة', 'Tebessa'),
  W('13', 'Tlemcen', 'تلمسان'),
  W('14', 'Tiaret', 'تيارت'),
  W('15', 'Tizi Ouzou', 'تيزي وزو'),
  W('16', 'Alger', 'الجزائر', 'Algiers'),
  W('17', 'Djelfa', 'الجلفة'),
  W('18', 'Jijel', 'جيجل'),
  W('19', 'Sétif', 'سطيف', 'Setif'),
  W('20', 'Saïda', 'سعيدة', 'Saida'),
  W('21', 'Skikda', 'سكيكدة'),
  W('22', 'Sidi Bel Abbès', 'سيدي بلعباس', 'Sidi Bel Abbes'),
  W('23', 'Annaba', 'عنابة'),
  W('24', 'Guelma', 'قالمة'),
  W('25', 'Constantine', 'قسنطينة'),
  W('26', 'Médéa', 'المدية', 'Medea'),
  W('27', 'Mostaganem', 'مستغانم'),
  W('28', "M'Sila", 'المسيلة'),
  W('29', 'Mascara', 'معسكر'),
  W('30', 'Ouargla', 'ورقلة'),
  W('31', 'Oran', 'وهران'),
  W('32', 'El Bayadh', 'البيض'),
  W('33', 'Illizi', 'إليزي'),
  W('34', 'Bordj Bou Arréridj', 'برج بوعريريج', 'Bordj Bou Arreridj'),
  W('35', 'Boumerdès', 'بومرداس', 'Boumerdes'),
  W('36', 'El Tarf', 'الطارف'),
  W('37', 'Tindouf', 'تندوف'),
  W('38', 'Tissemsilt', 'تيسمسيلت'),
  W('39', 'El Oued', 'الوادي'),
  W('40', 'Khenchela', 'خنشلة'),
  W('41', 'Souk Ahras', 'سوق أهراس'),
  W('42', 'Tipaza', 'تيبازة'),
  W('43', 'Mila', 'ميلة'),
  W('44', 'Aïn Defla', 'عين الدفلى', 'Ain Defla'),
  W('45', 'Naâma', 'النعامة', 'Naama'),
  W('46', 'Aïn Témouchent', 'عين تموشنت', 'Ain Temouchent'),
  W('47', 'Ghardaïa', 'غرداية', 'Ghardaia'),
  W('48', 'Relizane', 'غليزان'),
  W('49', 'Timimoun', 'تيميمون'),
  W('50', 'Bordj Badji Mokhtar', 'برج باجي مختار'),
  W('51', 'Ouled Djellal', 'أولاد جلال'),
  W('52', 'Béni Abbès', 'بني عباس', 'Beni Abbes'),
  W('53', 'In Salah', 'عين صالح'),
  W('54', 'In Guezzam', 'عين قزام'),
  W('55', 'Touggourt', 'تقرت'),
  W('56', 'Djanet', 'جانت'),
  W('57', "El M'Ghair", 'المغير'),
  W('58', 'El Meniaa', 'المنيعة'),
];

const BY_CODE = new Map(WILAYAS.map((w) => [w.code, w]));

export function wilayaByCode(code: string | null | undefined): Wilaya | null {
  return code ? (BY_CODE.get(code) ?? null) : null;
}

/** `23 — Annaba` in the given language (`ar` → Arabic name, `en` → English, else French); `''` for none. */
export function wilayaLabel(code: string | null | undefined, lang: string): string {
  const wilaya = wilayaByCode(code);
  if (!wilaya) return code ?? '';
  const name = lang === 'ar' ? wilaya.ar : lang === 'en' ? wilaya.en : wilaya.fr;
  return `${wilaya.code} — ${name}`;
}
