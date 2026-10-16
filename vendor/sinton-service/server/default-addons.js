import { randomUUID } from 'node:crypto';
import { loadAddon, ServiceError } from './addons.js';

export const DEFAULT_ADDONS=[
 {name:'FenixFlix',id:'com.fenixflix',url:'https://fenixflix.fenixhub.online/manifest.json'},
 {name:'FrostStream',id:'com.froststream',url:'https://froststream.cloutteam.com/manifest.json'},
 {name:'Torrentio',id:'com.stremio.torrentio.addon',url:'https://torrentio.strem.fun/manifest.json'},
 {name:'Cinemeta',id:'com.linvo.cinemeta',url:'https://v3-cinemeta.strem.io/manifest.json'},
 {name:'OpenSubtitles v3',id:'org.stremio.opensubtitlesv3',url:'https://opensubtitles-v3.strem.io/manifest.json'},
];
export async function installDefaultAddons(current,defaults=DEFAULT_ADDONS){
 const state=structuredClone(current),installed=[],skipped=[],errors=[];
 for(const spec of defaults){
  if(state.addons.some(a=>a.manifest.id===spec.id)){skipped.push(spec.name);continue;}
  if(state.addons.length>=20){errors.push({name:spec.name,message:'Limite de 20 fontes.'});continue;}
  try{const addon=await loadAddon(spec.url);if(addon.manifest.id!==spec.id)throw new Error('Identidade inesperada.');state.addons.push({...addon,id:randomUUID()});installed.push(spec.name);}
  catch(error){errors.push({name:spec.name,message:error instanceof ServiceError ? error.message : 'Não foi possível conectar. Tente novamente ou adicione seu manifest manualmente.'});}
 }
 return {state,installed,skipped,errors};
}
