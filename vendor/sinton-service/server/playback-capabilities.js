export const torrentsEnabled = (env = process.env) => env.ENABLE_TORRENTS === 'true' || (env.NODE_ENV !== 'production' && env.ENABLE_TORRENTS !== 'false');
export const isTorrentSource = stream => Boolean(stream?.infoHash || /^magnet:/i.test(stream?.url || ''));
export const TORRENT_UNAVAILABLE = 'Este servidor reproduz apenas fontes HTTP/HLS. As fontes encontradas são torrents e não podem ser reproduzidas nesta hospedagem. Configure um addon que forneça vídeo HTTP/HLS.';
export function playableSources(streams, env = process.env) {
  if (torrentsEnabled(env)) return { streams, diagnostics: [] };
  const compatible = streams.filter(stream => !isTorrentSource(stream));
  const diagnostics = [...new Set(streams.filter(isTorrentSource).map(stream => stream.addonName || 'Addon'))].map(name => `${name}: retornou fontes torrent incompatíveis com esta hospedagem; é necessária uma fonte HTTP/HLS.`);
  return { streams: compatible, diagnostics, ...(streams.length && !compatible.length ? { unavailableReason: TORRENT_UNAVAILABLE } : {}) };
}
