// Project slugs made from names: "Web shop" → "web-shop", "Мій магазин" → "mii-mahazyn".

/** Ukrainian (the 2010 national system, without its word-initial forms) and Russian letters. */
const CYRILLIC: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'h',
  ґ: 'g',
  д: 'd',
  е: 'e',
  є: 'ie',
  ж: 'zh',
  з: 'z',
  и: 'y',
  і: 'i',
  ї: 'i',
  й: 'i',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'kh',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'shch',
  ь: '',
  ю: 'iu',
  я: 'ia',
  ы: 'y',
  э: 'e',
  ё: 'e',
  ъ: '',
};

export const SLUG_MAX = 63;

/** A valid slug for `name`; "project" when the name has no letters or digits to use. */
export function slugFromName(name: string): string {
  const latin = [...name.toLowerCase()].map((c) => CYRILLIC[c] ?? c).join('');
  const slug = latin
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '');
  return slug.length >= 2 ? slug : 'project';
}

/** The `n`th candidate for a taken slug: base, base-2, base-3…, always within SLUG_MAX. */
export function slugCandidate(base: string, n: number): string {
  if (n === 1) return base;
  const suffix = `-${n}`;
  return `${base.slice(0, SLUG_MAX - suffix.length).replace(/-+$/, '')}${suffix}`;
}
