import { deflateSync } from 'node:zlib';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Code-native counterpart of the application rail's connected-path mark.
export const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><rect width="256" height="256" rx="54" fill="#0d1117"/><g transform="translate(24 24) scale(6.5)" stroke="#58a6ff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M7 23V8h8M7 15h16v9M15 8h9v7"/><g fill="#58a6ff" stroke="none"><circle cx="7" cy="24" r="3"/><circle cx="24" cy="8" r="3"/><circle cx="24" cy="24" r="3"/></g></g></svg>\n`;
const crcTable = Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
function crc(data){let c=0xffffffff;for(const b of data)c=crcTable[(c^b)&255]^(c>>>8);return (c^0xffffffff)>>>0;}
function chunk(type,data){const tag=Buffer.from(type),length=Buffer.alloc(4),checksum=Buffer.alloc(4);length.writeUInt32BE(data.length);checksum.writeUInt32BE(crc(Buffer.concat([tag,data])));return Buffer.concat([length,tag,data,checksum]);}
function distance(x,y,x1,y1,x2,y2){const dx=x2-x1,dy=y2-y1,t=Math.max(0,Math.min(1,((x-x1)*dx+(y-y1)*dy)/(dx*dx+dy*dy)));return Math.hypot(x-x1-dx*t,y-y1-dy*t);}
function png(size){
  const raw=Buffer.alloc((size*4+1)*size),background=[13,17,23],blue=[88,166,255];
  const segments=[[7,23,7,8],[7,8,15,8],[7,15,23,15],[23,15,23,24],[15,8,24,8],[24,8,24,15]],circles=[[7,24],[24,8],[24,24]];
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    let alpha=0,ink=0;
    for(let sy=0;sy<4;sy++)for(let sx=0;sx<4;sx++){
      const px=(x+(sx+.5)/4)*256/size,py=(y+(sy+.5)/4)*256/size;
      const cornerX=Math.max(54,Math.min(202,px)),cornerY=Math.max(54,Math.min(202,py));
      if(Math.hypot(px-cornerX,py-cornerY)>54)continue;
      alpha++;
      const gx=(px-24)/6.5,gy=(py-24)/6.5;
      if(segments.some(s=>distance(gx,gy,...s)<=1.1)||circles.some(([cx,cy])=>Math.hypot(gx-cx,gy-cy)<=3))ink++;
    }
    const offset=y*(size*4+1)+1+x*4;
    for(let c=0;c<3;c++)raw[offset+c]=alpha?Math.round((background[c]*(alpha-ink)+blue[c]*ink)/alpha):0;
    raw[offset+3]=Math.round(alpha/16*255);
  }
  const header=Buffer.alloc(13);header.writeUInt32BE(size,0);header.writeUInt32BE(size,4);header[8]=8;header[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw,{level:9})),chunk('IEND',Buffer.alloc(0))]);
}
function icon(){const sizes=[16,32,48,64,128,256],images=sizes.map(png),head=Buffer.alloc(6+16*sizes.length);head.writeUInt16LE(1,2);head.writeUInt16LE(sizes.length,4);let offset=head.length;images.forEach((data,i)=>{const p=6+i*16;head[p]=head[p+1]=sizes[i]===256?0:sizes[i];head.writeUInt16LE(1,p+4);head.writeUInt16LE(32,p+6);head.writeUInt32LE(data.length,p+8);head.writeUInt32LE(offset,p+12);offset+=data.length;});return Buffer.concat([head,...images]);}
const utf16=s=>Buffer.from(s+'\0','utf16le');
const pad=buffer=>buffer.length%4?Buffer.concat([buffer,Buffer.alloc(4-buffer.length%4)]):buffer;
function block(key,value=Buffer.alloc(0),children=[],type=1){const initial=pad(Buffer.concat([Buffer.alloc(6),utf16(key)]));
  // Every version-info child starts on a DWORD boundary.
  const parts=[initial,value];let length=initial.length+value.length;
  for(const child of children){const gap=(4-length%4)%4;if(gap){parts.push(Buffer.alloc(gap));length+=gap;}parts.push(child);length+=child.length;}
  const result=Buffer.concat(parts);result.writeUInt16LE(result.length,0);result.writeUInt16LE(type===1?value.length/2:value.length,2);result.writeUInt16LE(type,4);return result;
}
export function versionResource(version){
  const [major=0,minor=0,patch=0]=version.split('.').map(Number),fixed=Buffer.alloc(52),values=[0xfeef04bd,0x00010000,(major<<16)|minor,patch<<16,(major<<16)|minor,patch<<16,0x3f,0x2,0x00040004,1,0,0,0];
  values.forEach((value,i)=>fixed.writeUInt32LE(value>>>0,i*4));
  const strings={FileDescription:'Orivo — Element flow explorer',FileVersion:version+'.0',InternalName:'Orivo',OriginalFilename:'Orivo.exe',ProductName:'Orivo',ProductVersion:version+' beta',Comments:'Desktop beta. Unsigned distribution.'};
  const table=block('040904b0',undefined,Object.entries(strings).map(([key,value])=>block(key,utf16(value))));
  const translation=Buffer.from([9,4,176,4]);
  return block('VS_VERSION_INFO',fixed,[block('StringFileInfo',undefined,[table]),block('VarFileInfo',undefined,[block('Translation',translation,[],0)])],0);
}
export async function writeAssets(root,version,scratch){
  // Preserve approved artwork rather than overwriting it with the old generated mark.
  const data=await readFile(path.join(root,'resources','orivo.ico'));
  if(data.readUInt16LE(0)!==0||data.readUInt16LE(2)!==1||data.readUInt16LE(4)!==6)throw Error('Expected the approved six-size application icon.');
  await readFile(path.join(root,'resources','logo.png'));
  await mkdir(scratch,{recursive:true});
  await writeFile(path.join(scratch,'version-info.bin'),versionResource(version));
}
