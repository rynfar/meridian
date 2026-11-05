import fsPromises from 'node:fs/promises';
import {readFileSync,realpathSync} from 'node:fs';
import {basename,dirname,join,resolve,sep} from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
function envSettings(text){
 const marker='exec /usr/bin/env -i ';
 const offset=text.startsWith(marker)?0:text.indexOf('\n'+marker)+1;
 if(offset<0 || !text.startsWith(marker,offset))throw Error('Missing native env command');
 const command=text.slice(offset+marker.length);let index=0;
 const settings={};
 while(index<command.length){
  while(/\s/.test(command[index]??'') && index<command.length)index++;
  if(index===command.length)break;
  let value='',segments=0;
  while(command[index]==="'" || command.startsWith('"\'"',index)){
   if(command[index]==="'"){
    const end=command.indexOf("'",index+1);if(end<0)throw Error('Unclosed shell quote');
    value+=command.slice(index+1,end);index=end+1;
   }else{value+="'";index+=3;}
   segments++;
  }
  if(!segments || (index<command.length && !/\s/.test(command[index])))throw Error('Unexpected shell token');
  const equals=value.indexOf('=');if(equals<1)break;
  const key=value.slice(0,equals),setting=value.slice(equals+1);
  if(key==='ANTHROPIC_DEFAULT_OPUS_MODEL' || key==='CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK'){
   if(Object.hasOwn(settings,key))throw Error('Duplicate setting');settings[key]=setting;
  }
 }
 if(!/^claude-opus-[0-9.-]+$/.test(settings.ANTHROPIC_DEFAULT_OPUS_MODEL??'') || settings.CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK!=='1')throw Error('Missing or wrong settings');
 return {explicitOpusPin:settings.ANTHROPIC_DEFAULT_OPUS_MODEL,refusalFallbackDisabled:settings.CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK};
}
export function observePublishedGate(root){
 const owned=realpathSync(root),original=fsPromises.rename,rows=[],errors=[];
 const wrapper=async function(...args){
  const result=await Reflect.apply(original,this,args);
  if(typeof args[0]!=='string' || typeof args[1]!=='string')return result;
  const destination=resolve(args[1]),name=basename(destination);
  if(!/^\d+-[0-9a-f-]{36}\.gate$/.test(name) || !new RegExp('^'+name.replaceAll('.','\\.')+'\\.tmp-\\d+-[0-9a-f-]{36}$').test(basename(args[0])) || dirname(resolve(args[0]))!==dirname(destination))return result;
  try{
   const parent=realpathSync(dirname(destination));
   if(parent!==owned)return result;
   const canonical=realpathSync(join(parent,name));
   if(!canonical.startsWith(owned+sep))throw Error('Gate escaped owned root');
   rows.push(envSettings(readFileSync(canonical,'utf8')));
  }catch(error){errors.push({reason:'invalid-published-gate-witness'});}
  return result;
 };
 fsPromises.rename=wrapper;syncBuiltinESMExports();
 return {rows,errors,restore(){if(fsPromises.rename!==wrapper)throw Error('Gate observer ownership changed');fsPromises.rename=original;syncBuiltinESMExports();}};
}
