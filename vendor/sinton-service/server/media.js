import { randomBytes } from 'node:crypto';
import { Readable, pipeline } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServiceError } from './addons.js';
import { safeFetch, remoteURL, publicIP } from './network.js';
import { torrentsEnabled, TORRENT_UNAVAILABLE } from './playback-capabilities.js';

const tickets = new Map();
let engine, engineBudget;
const validRemote = value => { try { return remoteURL(value).href; } catch { throw new ServiceError('Destino de vídeo não permitido.'); } };
const token = () => randomBytes(24).toString('hex');
const localTorrentTests = () => process.env.NODE_ENV !== 'production' && Boolean(process.env.NODE_TEST_CONTEXT);
function pipeMedia(read,res,budget){pipeline(...[read,budget?.stream(),res].filter(Boolean),error=>{if(error&&!res.destroyed)res.destroy();});}
function headersFor(stream) {
  const result = {};
  for (const [key, value] of Object.entries(stream.behaviorHints?.proxyHeaders?.request || {})) if (/^(user-agent|referer|origin|authorization|cookie|accept|accept-language)$/i.test(key) && typeof value === 'string' && !/[\r\n]/.test(value)) result[key] = value;
  return result;
}
async function torrentEngine(budget) {
  if (budget) engineBudget = budget;
  if (engine && !engine.destroyed) return engine;
  const { default: WebTorrent } = await import('webtorrent');
  engine = new WebTorrent({ natUpnp: false, natPmp: false, lsd: false, utp: false, tracker: { ws: false }, maxConns: 20, uploadLimit: 32 * 1024, downloadLimit: 4 * 1024 * 1024, seedOutgoingConnections: false });
  // Addons cannot supply tracker URLs or private peer destinations to the server.
  engine.blocked = { contains: host => !localTorrentTests() && !publicIP(host) };
  engine.on('upload', bytes => { engineBudget?.consume(bytes).catch(() => { if (engine && !engine.destroyed) engine.destroy(); }); });
  engine.on('error', () => { engine = undefined; });
  return engine;
}
async function torrentFile(stream, budget, timeoutMs = 35000) {
  if(!torrentsEnabled())throw new ServiceError(TORRENT_UNAVAILABLE);
  const hash = stream.infoHash || String(stream.url).match(/btih:([a-z0-9]+)/i)?.[1];
  if (!/^(?:[a-f\d]{40}|[a-z2-7]{32})$/i.test(hash || '')) throw new ServiceError('Hash de torrent inválido.');
  const client = await torrentEngine(budget);
  if (client.torrents.length >= 3) throw new ServiceError('Feche outra reprodução para liberar o motor de torrents.');
  const announce = localTorrentTests()
    ? (stream.sources || []).filter(value => /^tracker:http:\/\/127\.0\.0\.1:\d+\/announce$/.test(value)).map(value => value.slice(8))
    : ['udp://tracker.opentrackr.org:1337/announce', 'udp://explodie.org:6969/announce'];
  const torrent = await client.get(hash) || client.add(hash, { path: join(tmpdir(), 'sinton-tv'), addUID: true, destroyStoreOnDestroy: true, deselect: true, announce, storeCacheSlots: 2 });
  try {
    await new Promise((resolve, reject) => {
      if (torrent.ready) return resolve();
      const timer = setTimeout(() => finish(new ServiceError('O torrent não encontrou metadados a tempo. Tentando outra fonte.')), timeoutMs);
      const finish = error => { clearTimeout(timer); torrent.off('ready', ready); torrent.off('error', failed); error ? reject(error) : resolve(); };
      const ready = () => finish(); const failed = () => finish(new ServiceError('O motor não conseguiu abrir este torrent.'));
      torrent.once('ready', ready); torrent.on('error', failed);
    });
    torrent.on('error', () => {});
    const candidate = stream.fileIdx != null ? torrent.files[Number(stream.fileIdx)] : [...torrent.files].filter(f => /\.(mp4|m4v|webm|mkv|mov)$/i.test(f.name) && !/sample/i.test(f.name)).sort((a, b) => b.length - a.length)[0];
    if (!candidate) throw new ServiceError('O torrent não contém o arquivo de vídeo indicado.');
    // File read streams select their current pieces; do not download the whole
    // movie in the background while the viewer is watching another position.
    return { file: candidate, torrent };
  } catch (error) { if (!torrent.destroyed) torrent.destroy({ destroyStore: true }, () => {}); throw error; }
}
export async function prepare(stream, budget, { timeoutMs = 15000 } = {}) {
  if (!stream || typeof stream !== 'object') throw new ServiceError('Fonte inválida.');
  const ticket = { until: Date.now() + 180000, assets: new Map(), tracks: new Map(), headers: headersFor(stream) };
  if (stream.infoHash || /^magnet:/i.test(stream.url || '')) Object.assign(ticket, await torrentFile(stream, budget, timeoutMs));
  else {
    ticket.url = validRemote(stream.url);
    let response, reader;
    try {
      response = await safeFetch(ticket.url, { headers: { ...ticket.headers, Range: 'bytes=0-32767' }, signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new ServiceError(`Fonte indisponível (HTTP ${response.status}).`);
      const type = response.headers.get('content-type') || '';
      if (/text\/html|application\/json/i.test(type)) throw new ServiceError('A fonte retornou uma página ou mensagem em vez de vídeo.');
      reader = response.body.getReader();
      const first = await reader.read();
      if (first.done || !first.value.length) throw new ServiceError('A fonte não retornou dados de vídeo.');
      ticket.hls = /mpegurl/i.test(type) || /\.m3u8(?:\?|$)/i.test(response.url) || Buffer.from(first.value).toString('utf8', 0, 10).startsWith('#EXTM3U');
      ticket.url = response.url;
    } catch (error) { throw error instanceof ServiceError ? error : new ServiceError('A fonte não respondeu à verificação de vídeo.'); }
    finally { try { if (reader) await reader.cancel(); else await response?.body?.cancel(); } catch { /* A timed-out probe may already be closed. */ } }
  }
  const id = token(); tickets.set(id, ticket);
  const subtitles = (stream.subtitles || []).filter(s => s.url).slice(0, 40).flatMap((s, index) => {
    try { const key = token(); ticket.tracks.set(key, validRemote(s.url)); return [{ url: `/media/${id}?subtitle=${key}`, lang: String(s.lang || s.language || 'und').slice(0, 20), label: String(s.name || s.lang || `Legenda ${index + 1}`).slice(0, 80) }]; } catch { return []; }
  });
  return { ticket: id, url: `/media/${id}`, kind: ticket.file ? 'torrent' : ticket.hls ? 'hls' : 'direct', addon: stream.addonName, subtitles, dubbed: /dublad|dubbed|pt[ -]?br|portugu[eê]s|🇧🇷/i.test(`${stream.name} ${stream.title} ${stream.description}`) };
}
export function keepAlive(id) { if (tickets.has(id)) tickets.get(id).until = Date.now() + 180000; }
export async function probeTorrent(id, timeoutMs = 15000) {
  const ticket = tickets.get(id);
  if (!ticket?.file) throw new ServiceError('Sessão torrent não encontrada.');
  await new Promise((resolve, reject) => {
    const read = ticket.file.createReadStream({ start: 0, end: Math.min(16383, ticket.file.length - 1) });
    const timer = setTimeout(() => { read.destroy(); reject(new ServiceError('O torrent não entregou dados de nenhum peer a tempo.')); }, timeoutMs);
    const finish = error => { clearTimeout(timer); read.destroy(); error ? reject(new ServiceError('Não foi possível receber dados deste torrent.')) : resolve(); };
    read.once('data', () => finish()); read.once('error', finish);
  });
}
export function release(id) {
  const ticket = tickets.get(id); tickets.delete(id);
  if (ticket?.torrent && !ticket.torrent.destroyed && ![...tickets.values()].some(t => t.torrent === ticket.torrent)) ticket.torrent.destroy({ destroyStore: true }, () => {});
}
setInterval(() => { for (const [id, ticket] of tickets) if (ticket.until < Date.now()) release(id); }, 30000).unref();
export function rewritePlaylist(text, base, id, ticket) {
  const link = value => {
    const target = validRemote(new URL(value, base).href);
    let key = [...ticket.assets].find(([, url]) => url === target)?.[0];
    if (!key) { key = token(); ticket.assets.set(key, target); }
    return `/media/${id}?asset=${key}`;
  };
  return text.split(/\r?\n/).map(line => line.startsWith('#') ? line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${link(uri)}"`) : line.trim() ? link(line.trim()) : line).join('\n');
}
export function toVTT(text) {
  const clean = text.replace(/^\uFEFF/, '').replace(/\r/g, '');
  if (clean.trimStart().startsWith('WEBVTT')) return clean;
  if (!/\d{2}:\d{2}:\d{2},\d{3}\s+-->/.test(clean)) throw new ServiceError('Formato de legenda não compatível. Use SRT ou WebVTT.');
  return 'WEBVTT\n\n' + clean.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
}
export async function serveMedia(req, res, id, asset, subtitle,budget) {
  const ticket = tickets.get(id);
  if (!ticket || ticket.until < Date.now()) throw new ServiceError('Sessão de vídeo expirada. Sintonize novamente.', 410);
  keepAlive(id);
  if (subtitle) {
    const target = ticket.tracks.get(subtitle); if (!target) throw new ServiceError('Legenda não encontrada.', 404);
    let response;
    try {
      response = await safeFetch(target, { headers:ticket.url&&new URL(target).origin===new URL(ticket.url).origin?ticket.headers:{}, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new ServiceError('O addon não entregou esta legenda.', 502);
      const reader = response.body.getReader(), chunks = []; let size = 0;
      while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new ServiceError('Legenda grande demais.'); } chunks.push(Buffer.from(value)); }
      const text = toVTT(Buffer.concat(chunks).toString('utf8'));await budget?.consume(Buffer.byteLength(text));res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8' }); return res.end(text);
    } catch (error) { throw error instanceof ServiceError ? error : new ServiceError('Não foi possível carregar esta legenda.', 502); }
  }
  if (ticket.file) {
    const file = ticket.file, match = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
    let start = match?.[1] ? Number(match[1]) : 0, end = match?.[2] ? Math.min(Number(match[2]), file.length - 1) : file.length - 1;
    if (match && !match[1] && match[2]) { start = Math.max(0, file.length - Number(match[2])); end = file.length - 1; }
    if (start > end || start >= file.length) { res.writeHead(416, { 'Content-Range': `bytes */${file.length}` }); return res.end(); }
    res.writeHead(match ? 206 : 200, { 'Content-Type': file.type, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', ...(match ? { 'Content-Range': `bytes ${start}-${end}/${file.length}` } : {}) });
    if (req.method === 'HEAD') return res.end();
    const read = file.createReadStream({ start, end });
    const deadline = setTimeout(() => { if (!res.writableEnded) read.destroy(new Error('Torrent timeout')); }, 45000);
    read.on('data', () => deadline.refresh()); read.on('close', () => clearTimeout(deadline)); res.on('close', () => { clearTimeout(deadline); read.destroy(); }); pipeMedia(read,res,budget); return;
  }
  const target = asset ? ticket.assets.get(asset) : ticket.url;
  if (!target) throw new ServiceError('Segmento de vídeo desconhecido.', 404);
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 45000);
  res.on('close', () => { clearTimeout(timer); controller.abort(); });
  try {
    const response = await safeFetch(target, { headers: { ...ticket.headers, ...(req.headers.range ? { Range: req.headers.range } : {}) }, signal: controller.signal, method: req.method === 'HEAD' ? 'HEAD' : 'GET' });
    if (!response.ok && response.status !== 416) throw new ServiceError(`Fonte indisponível (HTTP ${response.status}).`, 502);
    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const hls = /mpegurl/i.test(contentType) || /\.m3u8(?:\?|$)/i.test(target) || (!asset && ticket.hls);
    if (hls && req.method !== 'HEAD') {
      const text = await response.text();
      if (!text.trim().startsWith('#EXTM3U')) throw new ServiceError('Playlist HLS inválida.', 502);
      const playlist=rewritePlaylist(text,response.url,id,ticket);await budget?.consume(Buffer.byteLength(playlist));
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
      res.end(playlist); return;
    }
    const headers = { 'Content-Type': contentType };
    for (const name of ['content-length', 'content-range', 'accept-ranges']) if (response.headers.has(name)) headers[name] = response.headers.get(name);
    res.writeHead(response.status, headers);
    if (req.method === 'HEAD') return res.end();
    const read = Readable.fromWeb(response.body); read.on('data', () => timer.refresh()); pipeMedia(read,res,budget);
  } catch (error) { if (!res.headersSent) throw error instanceof ServiceError ? error : new ServiceError('A conexão com o vídeo foi interrompida.', 502); res.destroy(); }
}
export async function shutdown() { for (const id of tickets.keys()) release(id); if (engine) await new Promise(resolve => engine.destroy(resolve)); }
