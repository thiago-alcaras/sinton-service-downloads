import { requestResource, supports, fingerprint, canonicalID } from './addons.js';

export const CHANNELS = [
  { id: 'cinema', number: '01', name: 'Cinema', tag: 'Uma boa história, a qualquer hora.', types: ['movie'], genres: [], color: '#7684ff', symbol: 'film' },
  { id: 'series', number: '02', name: 'Séries', tag: 'Entre em outra história.', types: ['series'], genres: [], color: '#c995ff', symbol: 'series' },
  { id: 'animation', number: '03', name: 'Desenhos', tag: 'Imaginação sem intervalo.', types: ['movie', 'series'], genres: ['Animation', 'Animação', 'Animacao'], color: '#ffbb70', symbol: 'animation' },
  { id: 'documentary', number: '04', name: 'Documentários', tag: 'O mundo tem muito para contar.', types: ['movie', 'series'], genres: ['Documentary', 'Documentário', 'Documentario'], color: '#62d5af', symbol: 'documentary' },
  { id: 'anime', number: '05', name: 'Anime', tag: 'Outros universos estão no ar.', types: ['anime', 'movie', 'series'], genres: ['Anime', 'Japanese Animation', 'Animation'], color: '#ff8ca5', symbol: 'anime' },
  { id: 'variety', number: '06', name: 'Variedades', tag: 'A surpresa faz parte da programação.', types: ['movie', 'series', 'tv'], genres: ['Talk-Show', 'Reality-TV', 'Game-Show', 'Reality', 'Talk Show'], color: '#78cced', symbol: 'variety' }
];
const cache = new Map();
export function random(seed) { let state = parseInt(fingerprint(seed).slice(0, 8), 16); return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; }; }
export function shuffle(values, seed) { const out = [...values], next = random(seed); for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; } return out; }
const norm = x => String(x).normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
export function catalogQueries(catalog, channel) {
  if (!channel.types.includes(catalog.type)) return [];
  const extra = catalog.extra || (catalog.extraSupported || []).map(name => ({ name, isRequired: (catalog.extraRequired || []).includes(name) }));
  if (extra.some(e => e.isRequired && e.name !== 'genre')) return [];
  const genre = extra.find(e => e.name === 'genre');
  const options = genre?.options || catalog.genres || [];
  if (!channel.genres.length) return genre?.isRequired ? [] : [{}];
  if (channel.id === 'anime' && catalog.type === 'anime') return [{}];
  if (genre) {
    const matches = channel.genres.map(wanted => options.find(x => norm(x) === norm(wanted)) || (!options.length && wanted)).filter(Boolean);
    if (!matches.length) return [];
    return [...new Set(matches)].slice(0, 3).map(value => ({ genre: value }));
  }
  return [{}];
}
function matchesCategory(meta, channel, inherited) {
  if (!channel.genres.length) return true;
  if (channel.id === 'anime' && meta.type === 'anime') return true;
  const genres = meta.genres?.length ? meta.genres : inherited ? [inherited] : [];
  // Some compatible catalogs (including custom addons) return only title and
  // artwork. A missing genre is not evidence that the title is unrelated.
  // Keep those results eligible so a channel does not go empty solely because
  // the addon omits optional metadata.
  if (!genres.length) return true;
  if (!genres.some(g => channel.genres.some(w => norm(w) === norm(g)))) return false;
  if (channel.id === 'anime') return /japan|jap[aã]o|japanese/i.test(`${meta.country || ''} ${meta.language || ''} ${genres.join(' ')}`) || genres.some(g => /anime|japanese/i.test(g));
  return true;
}
export function duration(meta, type) {
  const minutes = parseFloat(String(meta.runtime || meta.duration || '').replace(',', '.'));
  return Number.isFinite(minutes) && minutes > 0 && minutes < 360 ? Math.round(minutes * 60) : type === 'movie' ? 6600 : 1440;
}
export function makeSchedule(items, seed, now = Date.now()) {
  if (!items.length) return [];
  const day = Math.floor(now / 86400000) * 86400000;
  let time = day; const entries = []; let round = 0; let previous;
  while (time < day + 2 * 86400000) {
    const pool = shuffle(items, `${seed}:${day}:${round++}`);
    if (pool.length > 1 && pool[0].videoId === previous) pool.push(pool.shift());
    for (const item of pool) { const end = time + item.duration * 1000; entries.push({ ...item, start: time, end, key: `${time}:${item.videoId}` }); time = end; previous = item.videoId; if (time >= day + 2 * 86400000) break; }
  }
  return entries;
}
export async function buildGuide(addons, channel, now = Date.now()) {
  const key = fingerprint([addons.map(a => a.url), channel.id, Math.floor(now / 86400000)]);
  if (cache.get(key)?.until > now) return cache.get(key).data;
  const diagnostics = [], previews = new Map();
  const jobs = addons.flatMap(addon => (addon.manifest.catalogs || []).flatMap(catalog => catalogQueries(catalog, channel).map(extra => ({ addon, catalog, extra })))).slice(0, 28);
  for (let i = 0; i < jobs.length; i += 6) await Promise.all(jobs.slice(i, i + 6).map(async ({ addon, catalog, extra }) => {
    try {
      const data = await requestResource(addon, 'catalog', catalog.type, catalog.id, extra);
      for (const preview of (data.metas || []).slice(0, 60)) {
        const meta = { ...preview, type: preview.type || catalog.type };
        if (meta.id && meta.name && !previews.has(`${meta.type}:${meta.id}`)) previews.set(`${meta.type}:${meta.id}`, { meta, inherited: extra.genre, addon });
      }
    } catch (error) { diagnostics.push(`${addon.manifest.name}: ${error.message}`); }
  }));
  const candidates = shuffle([...previews.values()], key).slice(0, 32), programs = [];
  for (let i = 0; i < candidates.length; i += 5) await Promise.all(candidates.slice(i, i + 5).map(async ({ meta: preview, inherited, addon }) => {
    let meta = preview;
    const resolvers = [addon, ...addons.filter(a => a !== addon)].filter(a => supports(a, 'meta', preview.type, preview.id));
    for (const resolver of resolvers) {
      try { const data = await requestResource(resolver, 'meta', preview.type, preview.id); if (data.meta) { meta = { ...preview, ...data.meta, genres: data.meta.genres?.length ? data.meta.genres : preview.genres }; break; } } catch { /* A catalog preview can still be sufficient for movies. */ }
    }
    if (!matchesCategory(meta, channel, inherited)) return;
    const released = Date.parse(meta.released);
    if (released > now || Number(meta.year || meta.releaseInfo) > new Date(now).getFullYear()) return;
    const id = canonicalID(meta), type = meta.type === 'anime' ? 'anime' : preview.type;
    const base = { id, type, name: meta.name, originalLanguage: meta.language || meta.originalLanguage || '', description: meta.description || '', poster: meta.poster || '', background: meta.background || meta.poster || '', duration: duration(meta, type), year: meta.year || meta.releaseInfo || '', genres: meta.genres || (inherited ? [inherited] : []) };
    if (['series', 'anime'].includes(type)) {
      const videos = (meta.videos || []).filter(v => Number(v.season) > 0 && Number(v.episode ?? v.number) > 0 && (!v.released || Date.parse(v.released) <= now));
      for (const episode of shuffle(videos, `${key}:${id}`).slice(0, 4)) {
        const season = Number(episode.season), number = Number(episode.episode ?? episode.number);
        programs.push({ ...base, videoId: id.startsWith('tt') ? `${id}:${season}:${number}` : episode.id, season, episode: number, subtitle: `T${season} · E${number} — ${episode.title || episode.name || 'Episódio'}`, duration: duration({ runtime: episode.runtime || meta.runtime }, 'series') });
      }
    } else programs.push({ ...base, videoId: id, subtitle: meta.year || meta.releaseInfo || 'Filme' });
  }));
  const unique = [...new Map(programs.filter(p => p.videoId).map(p => [p.videoId, p])).values()];
  const data = { channel, entries: makeSchedule(unique, key, now), diagnostics, count: unique.length, generatedAt: now, estimatedTimes: true };
  if (!unique.length) diagnostics.push(jobs.length ? 'Os catálogos consultados não retornaram programas compatíveis. Tente um catálogo com filtro de gênero e metadados completos.' : 'Adicione um addon de catálogo que ofereça esta categoria. Addons de fontes sozinhos não fornecem a programação.');
  cache.set(key, { data, until: now + 300000 }); if (cache.size > 100) cache.delete(cache.keys().next().value);
  return data;
}
