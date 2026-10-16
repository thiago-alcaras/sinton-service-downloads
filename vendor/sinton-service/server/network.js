import { lookup } from 'node:dns';
import { isIP, BlockList } from 'node:net';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Agent, fetch } from 'undici';

export const networkContext = new AsyncLocalStorage();
const blocked = new BlockList();
for (const [ip,prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3]]) blocked.addSubnet(ip,prefix,'ipv4');
// IPv6 is restricted to global unicast, excluding transition/documentation ranges.
for (const [ip,prefix] of [['2001::',23],['2001:db8::',32],['2002::',16]]) blocked.addSubnet(ip,prefix,'ipv6');
export function publicIP(ip) {
  const family = isIP(ip);
  if (family===4) return !blocked.check(ip,'ipv4');
  return family===6 && /^[23]/i.test(ip) && !blocked.check(ip,'ipv6');
}
const localTests = () => process.env.NODE_ENV!=='production' && (networkContext.getStore()?.testMode || !!process.env.NODE_TEST_CONTEXT);
const dispatcher = new Agent({connect:{lookup(host,options,callback){
  lookup(host,{all:true,verbatim:true},(error,addresses)=>{
    if(error) return callback(error);
    if(!addresses.length || addresses.some(a=>!publicIP(a.address))) return callback(new Error('Destino de rede privado bloqueado.'));
    const matches=options.family?addresses.filter(a=>a.family===Number(options.family)):addresses;
    if(!matches.length)return callback(new Error('Endereço indisponível.'));
    if(options.all) callback(null,matches); else callback(null,matches[0].address,matches[0].family);
  });
}}});
export function remoteURL(value) {
  const url=new URL(value);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('URL não permitida.');
  const hostname=url.hostname.replace(/^\[|\]$/g,'');
  if(!localTests() && ((isIP(hostname)&&!publicIP(hostname)) || ['localhost','metadata.google.internal'].includes(hostname) || (url.port && !['80','443'].includes(url.port))))throw new Error('Destino de rede privado ou porta não permitida.');
  return url;
}
// Validate every redirect; DNS is checked again by the actual socket lookup.
export async function safeFetch(value,options={}) {
  let url=remoteURL(value), headers=new Headers(options.headers);
  for(let redirects=0;redirects<=5;redirects++){
    const response=await fetch(url,{...options,headers,redirect:'manual',...(localTests()?{}:{dispatcher})});
    if(![301,302,303,307,308].includes(response.status))return response;
    await response.body?.cancel();
    if(redirects===5 || !response.headers.get('location'))throw new Error('Redirecionamento inválido.');
    const next=remoteURL(new URL(response.headers.get('location'),url));
    if(url.protocol==='https:' && next.protocol!=='https:')throw new Error('Redirecionamento inseguro.');
    // Origin describes the page that initiated the request and remains the
    // same when fetch follows a redirect. Keep the real Sinton origin for
    // addons that authorize stream endpoints after redirecting to a provider.
    if(next.origin!==url.origin) for(const name of ['authorization','cookie','referer'])headers.delete(name);
    url=next;
  }
}
