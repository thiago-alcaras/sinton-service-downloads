import { createHash } from 'node:crypto';
import { isPortuguese, subtitlePriority } from '../src/languages.js';
import { safeFetch, networkContext } from './network.js';
import { playableSources } from './playback-capabilities.js';

export class ServiceError extends Error {
  constructor(message, status = 422) { super(message); this.status = status; }
}
export const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const manifests = new Map();
export function manifestURL(value) {
  let url;
  try { url = new URL(String(value).replace(/^stremio:\/\//i, 'https://')); } catch { throw new ServiceError('Informe uma URL de manifest válida.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new ServiceError('Use uma URL HTTP ou HTTPS, sem usuário e senha na autoridade.');
  url.hash = '';
  if (!url.pathname.endsWith('/manifest.json')) url.pathname = url.pathname.replace(/\/$/, '') + '/manifest.json';
  return url;
}
export function resourceURL(base, resource, type, id, extra = {}) {
  const url = manifestURL(base);
  url.pathname = url.pathname.slice(0, -'manifest.json'.length) + [resource, type, id].map(encodeURIComponent).join('/') +
    (Object.keys(extra).length ? '/' + Object.entries(extra).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&') : '') + '.json';
  return url;
}
export async function fetchJSON(url, timeout = 12000, { retryWithoutOriginOnForbidden = false } = {}) {
  let res;
  const headers = { Accept: 'application/json' };
  const addonOrigin = networkContext.getStore()?.addonOrigin;
  if (addonOrigin) headers.Origin = addonOrigin;
  try {
    res = await safeFetch(url, { signal: AbortSignal.timeout(timeout), headers });
    // Manifest endpoints are public metadata. Some addons reject the hosted
    // Sinton page's Origin even though the same public manifest works locally.
    // Retry that one read without the browser-origin header; keep the normal
    // origin behavior for catalog, stream, subtitle, and media requests.
    if (retryWithoutOriginOnForbidden && res.status === 403 && addonOrigin) {
      await res.body?.cancel();
      const manifestHeaders = { ...headers };
      delete manifestHeaders.Origin;
      res = await safeFetch(url, { signal: AbortSignal.timeout(timeout), headers: manifestHeaders });
    }
  }
  catch { throw new ServiceError('Sem resposta do addon. Verifique a conexão e tente novamente.', 502); }
  if (!res.ok) {
    await res.body?.cancel();
    const source = networkContext.getStore()?.requestSource;
    const forbidden = source === 'local'
      ? 'O addon recusou a conexão do Serviço Sinton local (HTTP 403). O próprio addon está limitando esse acesso.'
      : 'O addon recusou a conexão (HTTP 403). Pode ser configuração ou restrição de acesso ao servidor.';
    const explanation = { 401: 'Configuração não autorizada. Gere um novo manifest.', 403: forbidden, 404: 'Recurso não encontrado no addon.', 429: 'O addon limitou as consultas. Aguarde um pouco.' };
    throw new ServiceError(explanation[res.status] || `O addon respondeu HTTP ${res.status}.`, 502);
  }
  const reader = res.body.getReader(); let size = 0; const chunks = [];
  while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 8 * 1024 * 1024) { await reader.cancel(); throw new ServiceError('Resposta do addon grande demais.'); } chunks.push(Buffer.from(value)); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ServiceError('O addon não retornou JSON válido.', 502); }
}
export async function loadAddon(value) {
  const url = manifestURL(typeof value === 'string' ? value : value.url).href;
  let cached = manifests.get(url);
  if (!cached || cached.until < Date.now()) {
    const manifest = await fetchJSON(url, 12000, { retryWithoutOriginOnForbidden: true });
    if (!manifest.id || !manifest.name || !Array.isArray(manifest.resources)) throw new ServiceError('Este manifest não descreve um addon compatível.');
    cached = { manifest, until: Date.now() + 300000 }; manifests.set(url, cached);
    if (manifests.size > 200) manifests.delete(manifests.keys().next().value);
  }
  const id=typeof value==='object'&&typeof value.id==='string'&&value.id.length<=200?value.id:undefined;
  return { ...(id?{id}:{}), url, manifest: cached.manifest };
}
export async function loadAddons(values = []) {
  if (!Array.isArray(values) || values.length > 20) throw new ServiceError('Configure até 20 addons.');
  const results = await Promise.allSettled(values.map(loadAddon));
  return { addons: results.filter(x => x.status === 'fulfilled').map(x => x.value), diagnostics: results.flatMap((x, i) => {
    if (x.status !== 'rejected') return [];
    let label = `Addon ${i + 1}`;
    try { label = new URL(manifestURL(typeof values[i] === 'string' ? values[i] : values[i]?.url)).hostname; } catch { /* Keep the generic label for malformed manifests. */ }
    return [`${label}: ${x.reason.message}`];
  }) };
}
export function supports(addon, resource, type, id) {
  return addon.manifest.resources.some(entry => {
    const spec = typeof entry === 'string' ? { name: entry, types: addon.manifest.types, idPrefixes: addon.manifest.idPrefixes } : entry;
    return spec.name === resource && (!spec.types?.length || spec.types.includes(type)) && (!id || !spec.idPrefixes?.length || spec.idPrefixes.some(prefix => id.startsWith(prefix)));
  });
}
export const requestResource = (addon, kind, type, id, extra) => fetchJSON(resourceURL(addon.url, kind, type, id, extra));
export function provider(addon) {
  const name = `${addon.manifest.id} ${addon.manifest.name} ${new URL(addon.url).hostname}`.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
  return name.includes('frost') ? 'froststream' : name.includes('fenixflix') || name.includes('fenixhub') ? 'fenixflix' : name.includes('torrentio') ? 'torrentio' : 'other';
}
export function isDubbed(stream) {
  return /dublad|dubbed|pt[ -]?br|portugu[eê]s|brazil|brasil|🇧🇷/i.test(`${stream.name || ''} ${stream.title || ''} ${stream.description || ''}`);
}
export function isDubbedOnly(stream) {
  const label = `${stream.name || ''} ${stream.title || ''} ${stream.description || ''}`;
  return isDubbed(stream) && !/\bdual\b|\bmulti\b|original|english|japanese|ingl[eê]s|japon[eê]s|🇺🇸|🇬🇧|🇯🇵|🇰🇷/i.test(label);
}
export function is4KStream(stream) {
  const label = `${stream.name || ''} ${stream.title || ''} ${stream.description || ''} ${stream.quality || ''} ${stream.resolution || ''} ${stream.videoQuality || ''}`;
  const declaredHeight = Number(stream.height || stream.resolutionHeight || 0);
  return /\b4k\b|\b2160(?:p)?\b/i.test(label) || declaredHeight >= 2160;
}
function reportedSeeders(stream) {
  const textValue = String(stream.title || '').match(/👤\s*([\d.,]+)/)?.[1]?.replace(/[.,]/g, '');
  const value = Number(stream.seeders ?? stream.peers ?? textValue);
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}
export function rankStream(stream, preference = 'dubbed', sourceOrder = null) {
  const dubbed = isDubbed(stream);
  const label = `${stream.name || ''} ${stream.title || ''} ${stream.description || ''}`;
  const brazilian = /pt[ -]?br|brazil|brasil|🇧🇷|\bpob\b/i.test(label)
    || (/dublad|dubbed|portugu[eê]s/i.test(label) && !/pt[ -]?pt|portugal|europe[au]|🇵🇹/i.test(label));
  const foreignAudio = /pt[ -]?pt|portugal|europe[au]|🇵🇹|\boriginal\b|\benglish\b|ingl[eê]s|japon[eê]s|japanese|🇺🇸|🇬🇧|🇯🇵|🇰🇷/i.test(label);
  const base = preference === 'dubbed'
    // FrostStream and FenixFlix are configured for dubbed playback. Explicit
    // foreign or original-audio labels are left for the subtitled fallback.
    ? (stream.provider === 'fenixflix' && !foreignAudio ? (brazilian ? 950 : 900) : stream.provider === 'froststream' && !foreignAudio ? (brazilian ? 850 : 800) : stream.provider === 'torrentio' ? 600 : 300)
    : (stream.provider === 'torrentio' ? 800 : stream.provider === 'fenixflix' ? 600 : stream.provider === 'froststream' ? 500 : 300) + (dubbed ? -50 : 0);
  // Source order is decisive when configured. Otherwise provider defaults apply;
  // inside a source, reported seeders determine which stream is tried first.
  const configuredOrder=sourceOrder?.[preference];
  const sourceIndex=Array.isArray(configuredOrder)?configuredOrder.indexOf(stream.addonId):-1;
  const sourcePriority=sourceIndex>=0?(configuredOrder.length-sourceIndex)*10000:0;
  return sourcePriority + base + (stream.url ? 10 : 0) + Math.min(100, Math.log2(reportedSeeders(stream) + 1) * 12);
}
export function canonicalID(meta) {
  const values = [meta.imdb_id, meta.imdbId, meta.id, ...(meta.links || []).map(x => x.url)];
  return values.map(x => String(x || '').match(/tt\d+/)?.[0]).find(Boolean) || meta.id;
}
export async function findStreams(addons, item, preference, language='pt-BR', sourceOrder=null, allowAllQualities=false) {
  const diagnostics = []; let id = item.videoId || item.id;
  if (!id.startsWith('tt')) {
    for (const addon of addons.filter(a => supports(a, 'meta', item.type, item.id))) {
      try { const { meta } = await requestResource(addon, 'meta', item.type, item.id); const canonical = canonicalID(meta || item); if (canonical.startsWith('tt')) { id = item.type === 'series' && item.season != null ? `${canonical}:${item.season}:${item.episode}` : canonical; break; } } catch { /* Other metadata providers may resolve this identifier. */ }
    }
  }
  const types = item.type === 'anime' ? ['anime', item.season != null ? 'series' : 'movie'] : [item.type];
  const eligible = addons.flatMap(addon => { const type = types.find(t => supports(addon, 'stream', t, id)); return type ? [{ addon, type }] : []; });
  const result = await Promise.all(eligible.map(async ({ addon, type }) => {
    try {
      const data = await requestResource(addon, 'stream', type, id);
      if (!Array.isArray(data.streams) || !data.streams.length) diagnostics.push(`${addon.manifest.name}: nenhuma fonte para este programa.`);
      return (data.streams || []).filter(s => s.url || s.infoHash)
        .map(s => ({ ...s, addonId:addon.id||addon.manifest.id, provider: provider(addon), addonName: addon.manifest.name }));
    } catch (error) { diagnostics.push(`${addon.manifest.name}: ${error.message}`); return []; }
  }));
  const subtitleProviders = addons.flatMap(addon => { const type = types.find(t => supports(addon, 'subtitles', t, id)); return type ? [{addon,type}] : []; });
  const subtitles = (await Promise.all(subtitleProviders.map(async ({addon,type}) => {
    try { const data = await requestResource(addon, 'subtitles', type, id); return (data.subtitles || []).filter(s => s.url).map(s => ({ ...s, name:s.name || `${s.lang || s.language || 'Legenda'} · ${addon.manifest.name}`, addonName: addon.manifest.name })); }
    catch (error) { diagnostics.push(`${addon.manifest.name}: não foi possível consultar legendas. ${error.message}`); return []; }
  }))).flat();
  if (!eligible.length) diagnostics.push('Nenhum addon de fontes aceita o tipo e o identificador deste programa.');
  const discovered = result.flat();
  const fourKCount = allowAllQualities ? 0 : discovered.filter(is4KStream).length;
  if (fourKCount) diagnostics.push(`${fourKCount} fonte(s) 4K ignorada(s); priorizando até 1080p.`);
  const streams = discovered.filter(s => (allowAllQualities || !is4KStream(s)) && (preference !== 'subtitled' || isPortuguese(item.originalLanguage) || !isDubbedOnly(s))).map(s => ({ ...s, subtitles: [...(s.subtitles || []), ...subtitles].sort((a,b)=>subtitlePriority(b,language)-subtitlePriority(a,language)).slice(0, 40) }));
  if (preference === 'subtitled' && !streams.length && result.flat().length) diagnostics.push('As fontes retornadas indicam apenas áudio dublado. O modo legendado precisa de áudio original.');
  const playable = playableSources(streams.sort((a, b) => rankStream(b, preference,sourceOrder) - rankStream(a, preference,sourceOrder)));
  return { ...playable, diagnostics: [...diagnostics, ...playable.diagnostics] };
}
