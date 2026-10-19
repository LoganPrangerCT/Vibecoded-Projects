import http from 'node:http';

// Recovered from the shipped generated protobuf and grpc-web client; no vendor code executed.
export const CheckSumType = Object.freeze({ BIT7: 0, BIT8: 1, NONE: 2 });
export const DangleDevType = Object.freeze({ NONE: 0, KEYBOARD: 1, MOUSE: 2 });
export function varint(value) {
  let n = BigInt(value), bytes = [];
  if (n < 0n) n = BigInt.asUintN(64, n);
  do { let b = Number(n & 127n); n >>= 7n; bytes.push(b | (n ? 128 : 0)); } while(n);
  return Buffer.from(bytes);
}
export function field(number, value) {
  if (typeof value === 'string' || Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const b = Buffer.from(value); return Buffer.concat([varint(number*8+2),varint(b.length),b]);
  }
  return Buffer.concat([varint(number*8), varint(value)]);
}
export function decodeFields(data) {
  const b=Buffer.from(data), out={}; let p=0;
  const read=()=>{let n=0n,shift=0n; for(let i=0;i<10;i++){if(p>=b.length)throw Error('Truncated protobuf');const v=b[p++];n|=BigInt(v&127)<<shift;if(!(v&128))return n;shift+=7n;}throw Error('Invalid protobuf varint');};
  while(p<b.length){const tag=Number(read()), no=tag>>>3, wire=tag&7;let v;
    if(!no)throw Error('Invalid protobuf field');
    if(wire===0){const n=read();v=Number(n>BigInt(Number.MAX_SAFE_INTEGER)?BigInt.asIntN(32,n):n);}
    else if(wire===2){const n=Number(read());if(p+n>b.length)throw Error('Truncated protobuf bytes');v=b.subarray(p,p+n);p+=n;}
    else if(wire===1||wire===5){const n=wire===1?8:4;if(p+n>b.length)throw Error('Truncated protobuf fixed field');v=b.subarray(p,p+n);p+=n;}
    else throw Error(`Unsupported protobuf wire type ${wire}`);
    (out[no]??=[]).push(v);
  } return out;
}
const first=(f,n,d=0)=>f[n]?.[0]??d;
const str=(f,n)=>first(f,n,Buffer.alloc(0)).toString('utf8');
export function decodeDeviceList(data) {
  const f=decodeFields(data);
  const status=b=>{const d=decodeFields(b);if(!d[2])return null;const s=decodeFields(d[2][0]);return {battery:first(s,1),isOnline:!!first(s,2)};};
  return {type:first(f,2),devices:(f[1]??[]).map(b=>{
    const dj=decodeFields(b);if(dj[1]){const d=decodeFields(dj[1][0]);return {kind:'device',devtype:first(d,1),is24:!!first(d,2),path:str(d,3),id:first(d,4)|0,battery:first(d,5),isOnline:!!first(d,6),vid:first(d,7),pid:first(d,8)};}
    const d=decodeFields(first(dj,2,Buffer.alloc(0)));return {kind:'receiver',path:str(d,3),keyboardId:first(d,5),mouseId:first(d,6),vid:first(d,7),pid:first(d,8),keyboard:d[1]?status(d[1][0]):null,mouse:d[2]?status(d[2][0]):null};
  })};
}
export function frame(data){const b=Buffer.from(data),h=Buffer.alloc(5);h.writeUInt32BE(b.length,1);return Buffer.concat([h,b]);}
export class GrpcWebDecoder {
  constructor(onMessage){this.onMessage=onMessage;this.text='';this.bytes=Buffer.alloc(0);this.trailers={};}
  pushText(text){this.text+=text.replace(/\s/g,'');while(this.text.length>=4){const pad=this.text.indexOf('=');const n=pad<0?Math.floor(this.text.length/4)*4:Math.ceil((pad+1)/4)*4;if(n>this.text.length)return;const segment=this.text.slice(0,n);this.text=this.text.slice(n);this.pushBytes(Buffer.from(segment,'base64'));}}
  pushBytes(b){this.bytes=Buffer.concat([this.bytes,b]);while(this.bytes.length>=5){const flags=this.bytes[0],n=this.bytes.readUInt32BE(1);if(n>16*1024*1024)throw Error('Oversized gRPC frame');if(this.bytes.length<5+n)return;const p=this.bytes.subarray(5,5+n);this.bytes=this.bytes.subarray(5+n);if(flags&128){for(const line of p.toString().split('\r\n')){const i=line.indexOf(':');if(i>0)this.trailers[line.slice(0,i).trim()]=line.slice(i+1).trim();}}else{if(flags&1)throw Error('Compressed gRPC frames unsupported');this.onMessage(p);}}}
  finish(){if(this.text.length||this.bytes.length)throw Error('Truncated gRPC-web response');if(this.trailers['grpc-status']&&this.trailers['grpc-status']!=='0')throw Error(this.trailers['grpc-message']||`gRPC status ${this.trailers['grpc-status']}`);}
}
export class DriverClient {
  constructor(endpoint='http://127.0.0.1:3814'){this.endpoint=endpoint;this.queue=Promise.resolve();}
  call(method,payload=Buffer.alloc(0),{onMessage=()=>{},signal,timeoutMs=5000,collect=true}={}){
    return new Promise((resolve,reject)=>{
      const body=Buffer.from(frame(payload).toString('base64')),url=new URL(`/driver.DriverGrpc/${method}`,this.endpoint),messages=[];
      const decoder=new GrpcWebDecoder(m=>{if(collect)messages.push(m);onMessage(m);});
      const req=http.request(url,{method:'POST',headers:{'content-type':'application/grpc-web-text','accept':'application/grpc-web-text','x-grpc-web':'1','content-length':body.length},signal},res=>{
        if(res.statusCode!==200){res.resume();reject(Error(`Driver HTTP ${res.statusCode}`));return;}
        const binary=!(res.headers['content-type']??'').includes('text');
        res.on('data',c=>{try{binary?decoder.pushBytes(c):decoder.pushText(c.toString('ascii'));}catch(e){req.destroy(e);}});
        res.on('end',()=>{try{decoder.finish();resolve(messages);}catch(e){reject(e);}});res.on('error',reject);
      });req.on('error',reject);if(timeoutMs)req.setTimeout(timeoutMs,()=>req.destroy(Error('Driver request timed out')));req.end(body);
    });
  }
  async getVersion(){const [b]=await this.call('getVersion');const f=decodeFields(b??Buffer.alloc(0));return {version:str(f,1),timestamp:str(f,2)};}
  watchDevices({signal,onDevices}={}){return this.call('watchDevList',Buffer.alloc(0),{signal,timeoutMs:0,collect:false,onMessage:b=>onDevices?.(decodeDeviceList(b))});}
  async discover({timeoutMs=2000}={}) {const ac=new AbortController();return new Promise((resolve,reject)=>{let done=false;const timer=setTimeout(()=>{if(!done){done=true;ac.abort();reject(Error('No device list received from driver'));}},timeoutMs);this.watchDevices({signal:ac.signal,onDevices:list=>{if(!done){done=true;clearTimeout(timer);resolve(list);ac.abort();}}}).catch(e=>{if(!done){done=true;clearTimeout(timer);reject(e);}});});}
  async send(path,msg,{checksumtype=0,dangledevtype=0}={}){const payload=Buffer.concat([field(1,path),field(2,msg),field(3,checksumtype),field(4,dangledevtype)]);const [b]=await this.call('sendMsg',payload);const err=str(decodeFields(b??Buffer.alloc(0)),1);if(err)throw Error(err);return true;}
  async read(path){const [b]=await this.call('readMsg',field(1,path));const f=decodeFields(b??Buffer.alloc(0)),err=str(f,1);if(err)throw Error(err);return first(f,2,Buffer.alloc(0));}
  exchange(path,msg,options={}){const run=async()=>{await this.send(path,msg,options);await new Promise(r=>setTimeout(r,5));return this.read(path);};const p=this.queue.then(run);this.queue=p.catch(()=>{});return p;}
}
export const R2_IDS = Object.freeze([1821,1822,1893]);
export function isR2(device){return device.vid===0x3151 && (device.kind==='receiver'?(R2_IDS.includes(device.mouseId)||R2_IDS.includes(device.mouseId-0x80000000)):R2_IDS.includes(Math.abs(device.id))||R2_IDS.includes(-device.id-0x80000000));}
