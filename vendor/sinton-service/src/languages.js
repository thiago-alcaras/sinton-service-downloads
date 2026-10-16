export function languageCode(value) {
  const language = String(value || '').trim().toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
  if (/^(pt|por|pob)([-_].*)?$/.test(language) || /portuguese|portugues|brazilian|brasil/.test(language)) return 'pt';
  for (const [code, pattern] of Object.entries({ en: /^(en|eng)([-_].*)?$|english|ingles/, ja: /^(ja|jpn)([-_].*)?$|japanese|japones/, ko: /^(ko|kor)([-_].*)?$|korean|coreano/, es: /^(es|spa)([-_].*)?$|spanish|espanhol/, fr: /^(fr|fra|fre)([-_].*)?$|french|frances/, de: /^(de|deu|ger)([-_].*)?$|german|alemao/, it: /^(it|ita)([-_].*)?$|italian|italiano/ })) if (pattern.test(language)) return code;
  return /^[a-z]{2}(?:[-_].*)?$/.test(language) ? language.slice(0, 2) : '';
}
export const isPortuguese = value => languageCode(value) === 'pt';
export function originalAudioIndex(tracks, originalLanguage) {
  const expected = languageCode(originalLanguage);
  const code = track => languageCode(track.lang || track.language || track.name || track.label);
  let index = expected ? tracks.findIndex(track => code(track) === expected && !/description|coment[aá]rio/i.test(track.name || track.label || '')) : -1;
  if (index < 0) index = tracks.findIndex(track => /original/i.test(track.name || track.label || ''));
  if (index < 0 && !expected) index = tracks.findIndex(track => code(track) && code(track) !== 'pt');
  return index;
}

// Subtitle selection keeps the requested language; Brazilian variants win over
// generic Portuguese, while a mislabeled track never matches by name alone.
export function subtitleMatches(track, language='pt-BR') {
 const expected=languageCode(language), code=languageCode(track.lang || track.language);
 return (code || languageCode(track.label || track.name))===expected;
}
export function subtitlePriority(track,language='pt-BR') {
 if(!subtitleMatches(track,language))return -1;
 const label=String(`${track.lang || track.language || ''} ${track.label || track.name || ''}`).toLowerCase();
 return language==='pt-BR'&&/pt[-_]br|\bpob\b|brazil|brasil/.test(label)?3:language==='pt-BR'&&/pt[-_]pt|portugal/.test(label)?0:1;
}
