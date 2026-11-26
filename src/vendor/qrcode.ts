// A compact QR Code encoder (ISO/IEC 18004), written for Loom's Settings › Devices
// pane. Byte mode, error correction level M, versions 1-10 (up to 213 bytes), which is
// plenty for a pairing URL. The algorithm is the standard one (Reed-Solomon over
// GF(256) with 0x11D, the eight mask patterns, the four-rule penalty score); the table
// values are from the specification.
//
// MIT License. Copyright (c) Loom contributors.
// Permission is hereby granted, free of charge, to any person obtaining a copy of this
// software and associated documentation files (the "Software"), to deal in the Software
// without restriction, including without limitation the rights to use, copy, modify,
// merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
// permit persons to whom the Software is furnished to do so, subject to the following
// conditions: the above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS",
// WITHOUT WARRANTY OF ANY KIND.
//
// QR_JS is plain ES5 page script, spliced into Loom's page by devicesview.ts. It must
// never contain a backslash, a backtick or a dollar-brace (the page script is spliced
// into a template string). It defines one global, loomQr(text) -> { size, rows } where
// rows[y][x] is true for a dark module, plus loomQrSvg(text) for the drawn result.

export const QR_JS = String.raw`
(function(){
var ECC_PER_BLOCK=[0,10,16,26,18,24,16,18,22,22,26];
var NUM_BLOCKS=[0,1,1,1,2,2,4,4,4,5,5];
var EXP=[],LOG=[];
(function(){var x=1;for(var i=0;i<255;i++){EXP[i]=x;LOG[x]=i;x<<=1;if(x&256)x^=285;}for(var j=255;j<512;j++)EXP[j]=EXP[j-255];})();
function gmul(a,b){if(a===0||b===0)return 0;return EXP[LOG[a]+LOG[b]];}
function rsDivisor(deg){var r=[];for(var i=0;i<deg-1;i++)r.push(0);r.push(1);var root=1;
  for(var k=0;k<deg;k++){for(var j=0;j<r.length;j++){r[j]=gmul(r[j],root);if(j+1<r.length)r[j]^=r[j+1];}root=gmul(root,2);}
  return r;}
function rsRemainder(data,div){var res=[];for(var i=0;i<div.length;i++)res.push(0);
  for(var d=0;d<data.length;d++){var f=data[d]^res.shift();res.push(0);for(var j=0;j<div.length;j++)res[j]^=gmul(div[j],f);}
  return res;}
function rawModules(v){var r=(16*v+128)*v+64;if(v>=2){var na=Math.floor(v/7)+2;r-=(25*na-10)*na-55;if(v>=7)r-=36;}return r;}
function dataCodewords(v){return Math.floor(rawModules(v)/8)-ECC_PER_BLOCK[v]*NUM_BLOCKS[v];}
function utf8(s){var out=[];for(var i=0;i<s.length;i++){var c=s.charCodeAt(i);
  if(c>=55296&&c<56320&&i+1<s.length){var d=s.charCodeAt(i+1);if(d>=56320&&d<57344){c=65536+((c-55296)<<10)+(d-56320);i++;}}
  if(c<128)out.push(c);else if(c<2048){out.push(192|(c>>6),128|(c&63));}
  else if(c<65536){out.push(224|(c>>12),128|((c>>6)&63),128|(c&63));}
  else out.push(240|(c>>18),128|((c>>12)&63),128|((c>>6)&63),128|(c&63));}
  return out;}
function encodeData(bytes){var v=0;
  for(var t=1;t<=10;t++){var lenBits=t<=9?8:16;if(4+lenBits+bytes.length*8<=dataCodewords(t)*8){v=t;break;}}
  if(!v)throw new Error('QR text too long');
  var bits=[];function put(val,n){for(var i=n-1;i>=0;i--)bits.push((val>>>i)&1);}
  put(4,4);put(bytes.length,v<=9?8:16);for(var i=0;i<bytes.length;i++)put(bytes[i],8);
  var cap=dataCodewords(v)*8;put(0,Math.min(4,cap-bits.length));
  while(bits.length%8)bits.push(0);
  var cw=[];for(var k=0;k<bits.length;k+=8){var b=0;for(var m=0;m<8;m++)b=(b<<1)|bits[k+m];cw.push(b);}
  for(var pad=236;cw.length<dataCodewords(v);pad^=236^17)cw.push(pad);
  return {version:v,codewords:cw};}
function addEcc(data,v){var nb=NUM_BLOCKS[v],el=ECC_PER_BLOCK[v],raw=Math.floor(rawModules(v)/8);
  var nShort=nb-raw%nb,shortLen=Math.floor(raw/nb),div=rsDivisor(el),blocks=[],k=0;
  for(var i=0;i<nb;i++){var dat=data.slice(k,k+shortLen-el+(i<nShort?0:1));k+=dat.length;var ecc=rsRemainder(dat,div);if(i<nShort)dat.push(0);blocks.push(dat.concat(ecc));}
  var out=[];for(var x=0;x<blocks[0].length;x++)for(var j=0;j<nb;j++)if(x!==shortLen-el||j>=nShort)out.push(blocks[j][x]);
  return out;}
function bit(x,i){return ((x>>>i)&1)!==0;}
function alignPositions(v){if(v===1)return [];var na=Math.floor(v/7)+2,size=v*4+17,step=Math.ceil((v*4+4)/(na*2-2))*2,r=[6];
  for(var pos=size-7;r.length<na;pos-=step)r.splice(1,0,pos);return r;}
function formatBits(mask){var data=mask,rem=data;for(var i=0;i<10;i++)rem=(rem<<1)^((rem>>>9)*1335);return ((data<<10)|rem)^21522;}
function versionBits(v){var rem=v;for(var i=0;i<12;i++)rem=(rem<<1)^((rem>>>11)*7973);return (v<<12)|rem;}
function build(version,codewords,mask){
  var size=version*4+17,mod=[],fn=[];
  for(var y=0;y<size;y++){mod.push([]);fn.push([]);for(var x=0;x<size;x++){mod[y].push(false);fn[y].push(false);}}
  function setFn(x,y,d){if(x>=0&&x<size&&y>=0&&y<size){mod[y][x]=d;fn[y][x]=true;}}
  for(var i=0;i<size;i++){setFn(6,i,i%2===0);setFn(i,6,i%2===0);}
  function finder(cx,cy){for(var dy=-4;dy<=4;dy++)for(var dx=-4;dx<=4;dx++){var dist=Math.max(Math.abs(dx),Math.abs(dy));setFn(cx+dx,cy+dy,dist!==2&&dist!==4);}}
  finder(3,3);finder(size-4,3);finder(3,size-4);
  var ap=alignPositions(version),na=ap.length;
  for(var a=0;a<na;a++)for(var b=0;b<na;b++){if((a===0&&b===0)||(a===0&&b===na-1)||(a===na-1&&b===0))continue;
    for(var dy2=-2;dy2<=2;dy2++)for(var dx2=-2;dx2<=2;dx2++)setFn(ap[a]+dx2,ap[b]+dy2,Math.max(Math.abs(dx2),Math.abs(dy2))!==1);}
  function drawFormat(m){var bits=formatBits(m);
    for(var i=0;i<=5;i++)setFn(8,i,bit(bits,i));setFn(8,7,bit(bits,6));setFn(8,8,bit(bits,7));setFn(7,8,bit(bits,8));
    for(var j=9;j<15;j++)setFn(14-j,8,bit(bits,j));
    for(var k=0;k<8;k++)setFn(size-1-k,8,bit(bits,k));
    for(var l=8;l<15;l++)setFn(8,size-15+l,bit(bits,l));
    setFn(8,size-8,true);}
  drawFormat(0);
  if(version>=7){var vb=versionBits(version);for(var q=0;q<18;q++){var col=bit(vb,q),p=size-11+q%3,r=Math.floor(q/3);setFn(p,r,col);setFn(r,p,col);}}
  var idx=0;
  for(var right=size-1;right>=1;right-=2){if(right===6)right=5;
    for(var vert=0;vert<size;vert++)for(var j2=0;j2<2;j2++){var x2=right-j2,up=((right+1)&2)===0,y2=up?size-1-vert:vert;
      if(!fn[y2][x2]&&idx<codewords.length*8){mod[y2][x2]=bit(codewords[idx>>>3],7-(idx&7));idx++;}}}
  function applyMask(m){for(var y=0;y<size;y++)for(var x=0;x<size;x++){var inv;
    switch(m){case 0:inv=(x+y)%2===0;break;case 1:inv=y%2===0;break;case 2:inv=x%3===0;break;case 3:inv=(x+y)%3===0;break;
      case 4:inv=(Math.floor(x/3)+Math.floor(y/2))%2===0;break;case 5:inv=x*y%2+x*y%3===0;break;
      case 6:inv=(x*y%2+x*y%3)%2===0;break;default:inv=((x+y)%2+x*y%3)%2===0;}
    if(!fn[y][x]&&inv)mod[y][x]=!mod[y][x];}}
  function penalty(){var s=0,dark=0,x,y,run,i;
    function lineScore(get){var sc=0,r=1,prev=get(0),w=[];for(var n=0;n<size;n++){var c=get(n);w.push(c?1:0);if(n>0){if(c===prev)r++;else{if(r>=5)sc+=3+r-5;r=1;prev=c;}}}
      if(r>=5)sc+=3+r-5;
      var p1=[1,0,1,1,1,0,1,0,0,0,0],p2=[0,0,0,0,1,0,1,1,1,0,1];
      for(var o=0;o+11<=size;o++){var m1=true,m2=true;for(var t=0;t<11;t++){if(w[o+t]!==p1[t])m1=false;if(w[o+t]!==p2[t])m2=false;}if(m1)sc+=40;if(m2)sc+=40;}
      return sc;}
    for(y=0;y<size;y++){s+=lineScore(function(n){return mod[y][n];});}
    for(x=0;x<size;x++){s+=lineScore(function(n){return mod[n][x];});}
    for(y=0;y<size-1;y++)for(x=0;x<size-1;x++){var c=mod[y][x];if(c===mod[y][x+1]&&c===mod[y+1][x]&&c===mod[y+1][x+1])s+=3;}
    for(y=0;y<size;y++)for(x=0;x<size;x++)if(mod[y][x])dark++;
    var total=size*size;s+=(Math.ceil(Math.abs(dark*20-total*10)/total)-1)*10;
    return s;}
  var best=-1,bestPen=1e9;
  if(mask===undefined||mask<0){for(var m=0;m<8;m++){applyMask(m);drawFormat(m);var pn=penalty();if(pn<bestPen){bestPen=pn;best=m;}applyMask(m);}}
  else best=mask;
  applyMask(best);drawFormat(best);
  return {size:size,rows:mod,mask:best,version:version};}
function loomQr(text,mask){var bytes=utf8(String(text));var e=encodeData(bytes);return build(e.version,addEcc(e.codewords,e.version),mask);}
function loomQrSvg(text,px){var q=loomQr(text),n=q.size+8,d='';
  for(var y=0;y<q.size;y++)for(var x=0;x<q.size;x++)if(q.rows[y][x])d+='M'+(x+4)+' '+(y+4)+'h1v1h-1z';
  var w=px||200;
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 '+n+' '+n+'" width="'+w+'" height="'+w+'" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="'+n+'" height="'+n+'" fill="#ffffff"/><path d="'+d+'" fill="#000000"/></svg>';}
var g=(typeof window!=='undefined')?window:(typeof globalThis!=='undefined'?globalThis:this);
g.loomQr=loomQr;g.loomQrSvg=loomQrSvg;g.loomQrInternals={rsDivisor:rsDivisor,rsRemainder:rsRemainder,formatBits:formatBits,versionBits:versionBits,addEcc:addEcc,encodeData:encodeData,rawModules:rawModules};
})();
`;
