import {COMMAND,packet,parseOptions,patchOptions,parseDpi,patchDpi,setKeyPacket,encodeMacro,decodeMacro,macroPackets,macroBinding} from './r2-protocol.mjs';
export function verifyRequested(actual,requested,prefix='settings'){for(const [key,value] of Object.entries(requested)){const got=actual?.[key],name=`${prefix}.${key}`;if(Array.isArray(value)){if(!Array.isArray(got)||value.some((v,i)=>v!==got[i]))throw Error(`Readback mismatch for ${name}`);}else if(value&&typeof value==='object')verifyRequested(got,value,name);else if(got!==value)throw Error(`Readback mismatch for ${name}: requested ${value}, received ${got}`);}}
export class R2Service {
  constructor(client,device){this.operationQueue=Promise.resolve();this.client=client;this.device=device;this.path=device.path;this.transportOptions={checksumtype:0,dangledevtype:device.kind==='receiver'?2:0};}
  operation(fn){const p=this.operationQueue.then(fn);this.operationQueue=p.catch(()=>{});return p;}
  readSettings(){return this.operation(()=>this._readSettings());}
  updateOptions(changes){return this.operation(()=>this._updateOptions(changes));}
  updateDpi(changes){return this.operation(()=>this._updateDpi(changes));}
  setProfile(profile){return this.operation(()=>this._setProfile(profile));}
  setKey(profile,index,mapping){return this.operation(()=>this._setKey(profile,index,mapping));}
  setMacro(index,macro){return this.operation(()=>this._setMacro(index,macro));}
  getMacro(index){return this.operation(()=>this._getMacro(index));}
  setRawMacro(index,raw){return this.operation(()=>this._setRawMacro(index,raw));}
  bindMacro(profile,keyIndex,mode,macroIndex){return this.setKey(profile,keyIndex,macroBinding(mode,macroIndex));}
  exchange(p){return this.client.exchange(this.path,p,this.transportOptions);}
  async query(command,fields={},validate=b=>b[0]===command){let last;for(let i=0;i<3;i++){try{const b=await this.exchange(packet(command,fields));if(b.length!==64||!validate(b))throw Error(`Unexpected response to command 0x${command.toString(16)}`);return b;}catch(e){last=e;if(/not online/i.test(e.message))throw e;await new Promise(r=>setTimeout(r,30));}}throw last;}
  async _readSettings(){const profile=await this.query(COMMAND.GET_PROFILE);const options=await this.query(COMMAND.GET_OPTIONS,{},b=>b[0]===COMMAND.GET_OPTIONS&&b[8]===profile[1]);const dpi=await this.query(COMMAND.GET_DPI,{1:profile[1]},b=>b[0]===COMMAND.GET_DPI&&b[1]===profile[1]);const keys=await this.query(COMMAND.GET_KEYS,{1:profile[1]},b=>![COMMAND.GET_KEYS,COMMAND.GET_OPTIONS,COMMAND.GET_DPI,COMMAND.GET_PROFILE].includes(b[0]));this.raw={options:Buffer.from(options),dpi:Buffer.from(dpi)};return {profile:profile[1],options:parseOptions(options),dpi:parseDpi(dpi),keyMappings:Array.from({length:Math.min(16,Math.floor(keys.length/4))},(_,i)=>Array.from(keys.subarray(4*i,4+4*i)))};}
  async _updateOptions(changes){await this._readSettings();await this.client.send(this.path,patchOptions(this.raw.options,changes),this.transportOptions);const result=await this._readSettings();verifyRequested(result.options,changes,'options');return result;}
  async _updateDpi(changes){await this._readSettings();await this.client.send(this.path,patchDpi(this.raw.dpi,changes),this.transportOptions);const result=await this._readSettings();verifyRequested(result.dpi,changes,'dpi');return result;}
  async _setProfile(profile){if(!Number.isInteger(profile)||profile<0||profile>7)throw Error('Profile must be 0–7');await this.client.send(this.path,packet(COMMAND.SET_PROFILE,{1:profile}),this.transportOptions);return this._readSettings();}
  async _setKey(profile,index,mapping){await this.client.send(this.path,setKeyPacket(profile,index,mapping),this.transportOptions);const keys=await this.query(COMMAND.GET_KEYS,{1:profile},b=>![COMMAND.GET_KEYS,COMMAND.GET_OPTIONS,COMMAND.GET_DPI,COMMAND.GET_PROFILE].includes(b[0]));if(mapping.some((v,i)=>v!==keys[index*4+i]))throw Error('Key mapping readback mismatch');return true;}
  async _getMacro(index){if(!Number.isInteger(index)||index<0||index>=20)throw Error('Macro index must be 0–19');const pages=[];for(let page=0;page<4;page++)pages.push(await this.query(COMMAND.GET_MACRO,{1:index,2:page},()=>true));const raw=Buffer.concat(pages);let decoded=null,decodeError=null;try{decoded=decodeMacro(raw);}catch(e){decodeError=e.message;}return {index,raw,decoded,decodeError};}
  async _setRawMacro(index,raw){if(!Number.isInteger(index)||index<0||index>=20)throw Error('Macro index must be 0–19');for(const p of macroPackets(index,raw))await this.client.send(this.path,p,this.transportOptions);await new Promise(r=>setTimeout(r,500));const result=await this._getMacro(index);if(!Buffer.from(raw).equals(result.raw))throw Error('Macro readback mismatch');return result;}
  async _setMacro(index,macro){if(!Number.isInteger(index)||index<0||index>=20)throw Error('Macro index must be 0–19');return this._setRawMacro(index,encodeMacro(macro));}
}
