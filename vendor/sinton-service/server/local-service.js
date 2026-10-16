import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';
import { CHANNELS, buildGuide } from './guide.js';
import { loadAddon, loadAddons, findStreams, ServiceError } from './addons.js';
import { prepare, serveMedia, release, keepAlive, shutdown } from './media.js';
import { searchCatalog, checkSelection, customGuide } from './custom.js';
import { installDefaultAddons } from './default-addons.js';
import { networkContext } from './network.js';

const host = '127.0.0.1';
const port = Number(process.env.SINTON_SERVICE_PORT || 11472);
process.env.NODE_ENV ||= 'development';
process.env.ENABLE_TORRENTS ||= 'true';
const serviceKey = randomBytes(32).toString('base64url');
const baseOrigins = [
  'https://sinton-tv.onrender.com',
  'http://localhost:8081',
  'http://127.0.0.1:8081',
  'http://localhost:8090',
  'http://127.0.0.1:8090',
  'http://localhost:5173',
  'http://127.0.0.1:5173'
];
const allowedOrigins = new Set([...baseOrigins, ...(process.env.SINTON_ALLOWED_ORIGINS || '').split(',')].map(value => value.trim()).filter(Boolean));
const json = (res, value, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
};
async function readBody(req) {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) throw new ServiceError('Envie JSON.', 415);
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256000) throw new ServiceError('Requisição muito grande.', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ServiceError('JSON inválido.', 400); }
}
function validOrigin(origin) { return typeof origin === 'string' && allowedOrigins.has(origin); }
function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && !validOrigin(origin)) throw new ServiceError('Origem não autorizada para o serviço local.', 403);
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Sinton-Service-Key, Range');
    res.setHeader('Access-Control-Expose-Headers', 'Accept-Ranges, Content-Length, Content-Range');
    if (req.headers['access-control-request-private-network'] === 'true') res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
  return origin;
}
function checkKey(req) {
  const supplied = req.headers['x-sinton-service-key'];
  if (typeof supplied !== 'string') throw new ServiceError('Chave local inválida.', 403);
  const a = Buffer.from(supplied), b = Buffer.from(serviceKey);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new ServiceError('Chave local inválida.', 403);
}
async function route(path, data, req, res) {
  if (path === '/channels' && req.method === 'GET') return json(res, CHANNELS);
  if (path === '/manifest') return json(res, await loadAddon(data.url));
  if (path === '/addons/defaults') {
    const current = await loadAddons(data.addons);
    current.addons = current.addons.map(addon => ({ ...addon, id: data.addons.find(value => typeof value === 'object' && value.url === addon.url)?.id || randomUUID() }));
    const result = await installDefaultAddons({ addons: current.addons });
    return json(res, { ...result, errors: [...current.diagnostics.map(message => ({ name: 'Addon configurado', message })), ...result.errors] });
  }
  if (path === '/prepare') {
    const result = await prepare(data.stream);
    const origin = `http://${host}:${port}`;
    result.url = new URL(result.url, origin).href;
    result.subtitles = result.subtitles.map(track => ({ ...track, url: new URL(track.url, origin).href }));
    return json(res, result);
  }
  if (path === '/release' || path === '/alive') {
    if (path === '/release') release(data.ticket);
    else keepAlive(data.ticket);
    return json(res, { ok: true });
  }
  const { addons, diagnostics } = await loadAddons(data.addons);
  if (path === '/search') {
    const result = await searchCatalog(addons, data.query, data.type);
    return json(res, { ...result, diagnostics: [...diagnostics, ...result.diagnostics] });
  }
  if (path === '/custom/check') return json(res, await checkSelection(addons, data.item, data.preference, data.language));
  if (path === '/custom/guide') {
    const result = await customGuide(addons, data.channel);
    return json(res, { ...result, diagnostics: [...diagnostics, ...result.diagnostics] });
  }
  if (path === '/guide') {
    const channel = CHANNELS.find(item => item.id === data.channel);
    if (!channel) throw new ServiceError('Canal não encontrado.', 404);
    const result = await buildGuide(addons, channel);
    return json(res, { ...result, diagnostics: [...diagnostics, ...result.diagnostics] });
  }
  if (path === '/streams') {
    if (!data.item?.id || !data.item?.type) throw new ServiceError('Programa inválido.');
    const result = await findStreams(addons, data.item, data.preference, data.language);
    return json(res, { ...result, diagnostics: [...diagnostics, ...result.diagnostics] });
  }
  throw new ServiceError('Não encontrado.', 404);
}

const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    if (req.headers.host !== `${host}:${port}` && req.headers.host !== `localhost:${port}`) throw new ServiceError('Host não autorizado.', 403);
    const origin = cors(req, res);
    const url = new URL(req.url, `http://${host}:${port}`);
    if (req.method === 'OPTIONS') {
      if (!origin) throw new ServiceError('Origem obrigatória.', 403);
      res.writeHead(204); return res.end();
    }
    if (url.pathname === '/health' && req.method === 'GET') {
      if (!origin) throw new ServiceError('Origem obrigatória.', 403);
      return json(res, { ok: true, service: 'sinton-local', version: 1, serviceKey });
    }
    const media = url.pathname.match(/^\/media\/([a-f0-9]{48})$/);
    if (media && ['GET', 'HEAD'].includes(req.method)) {
      if (origin && !validOrigin(origin)) throw new ServiceError('Origem não autorizada.', 403);
      res.setHeader('Access-Control-Allow-Origin', origin || '*');
      res.setHeader('Access-Control-Expose-Headers', 'Accept-Ranges, Content-Length, Content-Range');
      res.setHeader('Cache-Control', 'no-store');
      return await serveMedia(req, res, media[1], url.searchParams.get('asset'), url.searchParams.get('subtitle'));
    }
    if (!url.pathname.startsWith('/api/')) throw new ServiceError('Não encontrado.', 404);
    if (!origin) throw new ServiceError('Origem obrigatória.', 403);
    checkKey(req);
    const path = url.pathname.slice('/api'.length);
    if (path === '/channels' && req.method === 'GET') return await route(path, {}, req, res);
    if (req.method !== 'POST') throw new ServiceError('Método não permitido.', 405);
    const data = await readBody(req);
    return await networkContext.run({ addonOrigin: origin }, () => route(path, data, req, res));
  } catch (error) {
    if (res.headersSent) return res.destroy();
    return json(res, { error: error instanceof Error ? error.message : 'Não foi possível concluir a operação.' }, error instanceof ServiceError ? error.status : 500);
  }
});
server.requestTimeout = 120000;
server.listen(port, host, () => console.log(`Serviço local Sinton em http://${host}:${port} · torrents ativados · origens: ${[...allowedOrigins].join(', ')}`));
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? `A porta ${port} já está em uso. Feche outra instância do Sinton local.` : 'Não foi possível iniciar o serviço Sinton local.');
  process.exitCode = 1;
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  server.close();
  await shutdown();
  process.exit(0);
});
