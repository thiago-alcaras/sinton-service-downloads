import { ServiceError, loadAddon, supports, requestResource, canonicalID, findStreams, fingerprint } from './addons.js';
import { duration, shuffle, random } from './guide.js';
import { prepare, release, probeTorrent } from './media.js';

const recentChecks = new Map();
export function makeCustomSchedule(programs, seed, now = Date.now()) {
  const stable = [...programs].sort((a, b) => `${a.type}:${a.id}:${a.videoId}`.localeCompare(`${b.type}:${b.id}:${b.videoId}`));
  const groups = [...Map.groupBy(stable, p => `${p.type}:${p.id}`).values()];
  if (!groups.length) return [];
  const day = Math.floor(now / 86400000) * 86400000, next = random(`${seed}:${day}`), entries = [];
  let start = day, round = 0, previous;
  while (start < day + 2 * 86400000) {
    const order = shuffle(groups, `${seed}:${day}:${round++}`);
    if (order.length > 1 && order[0][0].id === previous?.id) order.push(order.shift());
    for (const group of order) {
      const options = group.length > 1 ? group.filter(p => p.videoId !== previous?.videoId) : group;
      const program = options[Math.floor(next() * options.length)], end = start + program.duration * 1000;
      entries.push({ ...program, start, end, key: `${start}:${program.videoId}` }); start = end; previous = program;
      if (start >= day + 2 * 86400000) break;
    }
  }
  return entries;
}
async function catalogProviders(addons) {
  const configured = addons.filter(a => a.manifest.catalogs?.length);
  if (configured.length) return configured;
  return [await loadAddon('https://v3-cinemeta.strem.io/manifest.json')];
}
export async function searchCatalog(addons, query, type = 'all') {
  query = String(query || '').trim().slice(0, 100);
  if (query.length < 2) throw new ServiceError('Digite pelo menos dois caracteres para buscar.');
  const providers = await catalogProviders(addons), diagnostics = [];
  const jobsFor = values => values.flatMap(addon => (addon.manifest.catalogs || []).filter(catalog => {
    if (!['movie', 'series', 'anime'].includes(catalog.type) || (type !== 'all' && catalog.type !== type)) return false;
    const extra = catalog.extra || (catalog.extraSupported || []).map(name => ({ name, isRequired: (catalog.extraRequired || []).includes(name) }));
    return extra.some(x => x.name === 'search') && !extra.some(x => x.isRequired && x.name !== 'search');
  }).map(catalog => ({ addon, catalog }))).slice(0, 12);
  let jobs = jobsFor(providers);
  if (!jobs.length) jobs = jobsFor([await loadAddon('https://v3-cinemeta.strem.io/manifest.json')]);
  if (!jobs.length) throw new ServiceError('Seus catálogos não oferecem busca. Adicione o Cinemeta em Minhas fontes.');
  const results = await Promise.all(jobs.map(async ({ addon, catalog }) => {
    try { const data = await requestResource(addon, 'catalog', catalog.type, catalog.id, { search: query }); return (data.metas || []).filter(x => x.id && x.name).map(meta => ({ id: meta.id, type: meta.type || catalog.type, name: meta.name, poster: meta.poster || '', background: meta.background || '', year: meta.year || meta.releaseInfo || '', description: String(meta.description || '').slice(0, 500) })); }
    catch (error) { diagnostics.push(`${addon.manifest.name}: ${error.message}`); return []; }
  }));
  return { results: [...new Map(results.flat().map(item => [`${item.type}:${item.id}`, item])).values()].slice(0, 40), diagnostics };
}
async function expandSelection(addons, input) {
  if (!input || typeof input.id !== 'string' || input.id.length > 150 || !['movie', 'series', 'anime'].includes(input.type)) throw new ServiceError('Seleção de catálogo inválida.');
  const providers = await catalogProviders(addons);
  let meta;
  for (const addon of [...new Map([...providers, ...addons].map(a => [a.url, a])).values()].filter(a => supports(a, 'meta', input.type, input.id))) {
    try { const data = await requestResource(addon, 'meta', input.type, input.id); if (data.meta?.id && data.meta.name) { meta = data.meta; break; } } catch { /* Another metadata provider may resolve this title. */ }
  }
  if (!meta && /^tt\d+$/.test(input.id)) {
    try { const fallback = await loadAddon('https://v3-cinemeta.strem.io/manifest.json'); const data = await requestResource(fallback, 'meta', input.type, input.id); if (data.meta?.id && data.meta.name) meta = data.meta; } catch { /* The caller receives a metadata error if no provider responds. */ }
  }
  if (!meta) throw new ServiceError('Não foi possível carregar os metadados completos deste título.');
  const now = Date.now(), released = Date.parse(meta.released);
  if (released > now || Number(meta.year || meta.releaseInfo) > new Date(now).getFullYear()) throw new ServiceError('Este título ainda não foi lançado.');
  const id = canonicalID(meta), base = { id, type: input.type, name: meta.name, originalLanguage: meta.language || meta.originalLanguage || '', poster: meta.poster || '', background: meta.background || meta.poster || '', description: String(meta.description || '').slice(0, 1000), year: meta.year || meta.releaseInfo || '', duration: duration(meta, input.type) };
  let programs;
  if (input.type === 'movie') programs = [{ ...base, videoId: id, subtitle: base.year || 'Filme' }];
  else programs = (meta.videos || []).filter(v => Number(v.season) > 0 && Number(v.episode ?? v.number) > 0 && (!v.released || Date.parse(v.released) <= now)).map(v => {
    const season = Number(v.season), episode = Number(v.episode ?? v.number);
    return { ...base, videoId: id.startsWith('tt') ? `${id}:${season}:${episode}` : v.id, season, episode, subtitle: `T${season} · E${episode} — ${v.title || v.name || 'Episódio'}`, duration: duration({ runtime: v.runtime || meta.runtime }, 'series') };
  }).filter(v => v.videoId);
  if (!programs.length) throw new ServiceError('O catálogo não informou episódios lançados para este título.');
  return { item: { id: input.id, type: input.type, name: base.name, poster: base.poster, year: base.year }, programs };
}
export async function checkSelection(addons, input, preference = 'dubbed', language='pt-BR', budget) {
  if (!addons.some(a => a.manifest.resources.some(r => (typeof r === 'string' ? r : r.name) === 'stream'))) throw new ServiceError('Conecte um addon de fontes antes de verificar os títulos.');
  const key = fingerprint([addons.map(a => a.url), input?.id, input?.type, preference, language]);
  if (recentChecks.get(key)?.until > Date.now()) return recentChecks.get(key).result;
  const { item, programs } = await expandSelection(addons, input);
  // A channel builder only needs one representative episode to confirm that
  // the title has a source; playback checks the selected episode later.
  const diagnostics = [], deadline = Date.now() + 45000;
  for (const program of shuffle(programs, key).slice(0, 1)) {
    if (Date.now() > deadline) break;
    const result = await findStreams(addons, program, preference, language); diagnostics.push(...result.diagnostics);
    // Test one candidate from every addon before trying second choices from
    // the same addon. A source returning many streams must not hide the rest.
    const byAddon = new Map();
    for (const stream of result.streams) {
      const key = stream.addonName || stream.provider || 'Addon';
      if (!byAddon.has(key)) byAddon.set(key, []);
      byAddon.get(key).push(stream);
    }
    const providers = [...byAddon.values()];
    const candidates = [];
    for (let round = 0; providers.some(group => round < group.length); round++) {
      for (const group of providers) if (group[round]) candidates.push(group[round]);
    }
    for (const stream of candidates) {
      const remaining = deadline - Date.now();
      if (remaining <= 250) break;
      let prepared;
      try {
        prepared = await prepare(stream, budget, { timeoutMs: Math.min(5000, remaining) });
        if (prepared.kind === 'torrent') {
          const probeTime = deadline - Date.now();
          if (probeTime <= 250) throw new ServiceError('Tempo de verificação esgotado. Tente novamente.');
          await probeTorrent(prepared.ticket, Math.min(4000, probeTime));
        }
        const verifiedAt = Date.now();
        const value = { available: true, item: { ...item, verifiedAt, verifiedFor: preference }, sample: { videoId: program.videoId, subtitle: program.subtitle }, episodeCount: programs.length, source: { addon: stream.addonName, kind: prepared.kind }, verifiedAt, diagnostics };
        recentChecks.set(key, { until: verifiedAt + 60000, result: value });
        if (recentChecks.size > 100) recentChecks.delete(recentChecks.keys().next().value);
        return value;
      } catch (error) { diagnostics.push(`${stream.addonName}: ${error.message}`); }
      finally { if (prepared) release(prepared.ticket); }
    }
  }
  return { available: false, item, diagnostics: [...new Set(diagnostics)], message: 'Nenhuma fonte respondeu para os programas verificados. Este título não foi adicionado.' };
}
export async function customGuide(addons, input) {
  if (!input || !/^custom-[a-z0-9-]{1,60}$/i.test(input.id || '') || typeof input.name !== 'string' || !input.name.trim() || !Array.isArray(input.items) || input.items.length < 1 || input.items.length > 30) throw new ServiceError('Informe um nome e de 1 a 30 títulos para o canal.');
  const programs = [], diagnostics = [];
  for (let i = 0; i < input.items.length; i += 4) await Promise.all(input.items.slice(i, i + 4).map(async item => {
    try { const expanded = await expandSelection(addons, item); programs.push(...shuffle(expanded.programs, `${input.id}:${item.id}:${Math.floor(Date.now() / 86400000)}`).slice(0, 120)); }
    catch (error) { diagnostics.push(`${String(item.name || 'Título').slice(0, 100)}: ${error.message}`); }
  }));
  const unique = [...new Map(programs.map(p => [`${p.type}:${p.videoId}`, p])).values()];
  const channel = { id: input.id, name: input.name.trim().slice(0, 40), number: '★', tag: `${input.items.length} títulos · Feito por você`, color: '#b7edff', symbol: 'tv', custom: true };
  return { channel, entries: makeCustomSchedule(unique, fingerprint([input.id, input.items.map(x => [x.id, x.type])])), diagnostics, count: unique.length, estimatedTimes: true };
}
