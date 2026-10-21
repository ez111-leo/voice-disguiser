const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
function buffer(ch=1, len=200, sr=8000) {
  const data=Array.from({length:ch},(_,c)=>Float32Array.from({length:len},(_,i)=>Math.sin(i*.2)*(c?-.5:.5)));
  return {numberOfChannels:ch,length:len,sampleRate:sr,duration:len/sr,getChannelData:c=>data[c],copyToChannel:(d,c)=>data[c].set(d)};
}
function setup() {
  const elements=new Map(), renders=[], sources=[], blobs=[];
  const element=id=>{if(!elements.has(id))elements.set(id,{disabled:false,textContent:'',className:'',classList:{toggle(){},add(){},remove(){}},click(){}});return elements.get(id)};
  class Offline {
    constructor(ch,len,sr){this.buffer=buffer(ch,len,sr);this.destination={};this.filters=[];this.sources=[];}
    createBuffer(ch,len,sr){return buffer(ch,len,sr)}
    createBufferSource(){const s={playbackRate:{value:1},connect(n){this.target=n},start(){}};this.sources.push(s);return s}
    createBiquadFilter(){const f={frequency:{},Q:{},connect(n){this.target=n}};this.filters.push(f);return f}
    startRendering(){return new Promise(resolve=>renders.push({context:this,resolve:()=>resolve(this.buffer)}))}
  }
  const audioCtx={sampleRate:8000,state:'running',destination:{},createBuffer:buffer,createBufferSource(){const s={playbackRate:{},connect(n){this.target=n},start(){},stop(){}};sources.push(s);return s},resume:async()=>{audioCtx.state='running'}};
  const ctx=vm.createContext({console,Float32Array,Uint8Array,ArrayBuffer,DataView,Math,Number,isFinite,Blob,OfflineAudioContext:Offline,window:{addEventListener(){}},document:{getElementById:element,querySelectorAll:()=>[],createElement:()=>({click(){}})},URL:{createObjectURL(b){blobs.push(b);return 'blob:test'},revokeObjectURL(){}},setTimeout,clearTimeout,alert(){}});
  vm.runInContext(script,ctx);
  vm.runInContext('STATE.audioCtx = testCtx; STATE.analyserNode = {}; STATE.lowShelf = {};',Object.assign(ctx,{testCtx:audioCtx}));
  const run=s=>vm.runInContext(s,ctx);
  run('estimatePitch=()=>{};precomputeSpectrum=()=>{};startVisualization=()=>{}');
  return {ctx,run,renders,sources,blobs,audioCtx,element,buffer};
}
async function drain(s){await new Promise(setImmediate);while(s.renders.length){s.renders.shift().resolve();await new Promise(setImmediate)}}
test('bypass skips offline filtering before pitch conversion',async()=>{
  const s=setup();s.ctx.input=buffer();s.run('STATE.originalBuffer=input;STATE.filterEnabled=false');
  const p=s.run('processAudio()');assert.equal(s.renders[0].context.filters.length,0);await drain(s);await p;
});
test('filtered original playback is not filtered twice',async()=>{
  const s=setup();s.ctx.input=buffer();s.run('STATE.originalBuffer=input;STATE.filteredBuffer=input;STATE.filterEnabled=true');
  await s.run('playOriginal()');assert.equal(s.sources[0].target,s.run('STATE.analyserNode'));
});
test('processed audio is not filtered again during playback',async()=>{
  const s=setup();s.ctx.input=buffer();s.run('STATE.processedBuffer=input;STATE.filterEnabled=true');
  await s.run('playChanged()');assert.equal(s.sources[0].target,s.run('STATE.analyserNode'));
});
test('stereo WAV export preserves both channels and header sizes',async()=>{
  const s=setup(),b=buffer(2,10);s.ctx.input=b;s.run('STATE.originalBuffer=input;STATE.processedBuffer=input;downloadWAV()');
  const bytes=await s.blobs[0].arrayBuffer(),v=new DataView(bytes);
  assert.equal(v.getUint16(22,true),2);assert.equal(v.getUint16(32,true),4);assert.equal(v.getUint32(40,true),40);
  assert.equal(bytes.byteLength,84);assert.equal(v.getInt16(52,true),Math.trunc(b.getChannelData(0)[2]*32767));assert.equal(v.getInt16(54,true),Math.trunc(b.getChannelData(1)[2]*32768));
});
test('new processing invalidates old result and blocks export until ready',async()=>{
  const s=setup();s.ctx.input=buffer();s.run('STATE.originalBuffer=input;STATE.processedBuffer=input');
  const p=s.run('processAudio()');assert.equal(s.run('STATE.processedBuffer'),null);assert.equal(s.element('btnDownload').disabled,true);await drain(s);await p;
});
test('older asynchronous conversion cannot overwrite newest conversion',async()=>{
  const s=setup();s.ctx.first=buffer(1,200);s.ctx.second=buffer(1,400);
  s.run('STATE.originalBuffer=first;STATE.modeAlpha=1.6');const first=s.run('processAudio()');const old=s.renders.shift();
  s.run('STATE.originalBuffer=second;STATE.modeAlpha=1.5');const second=s.run('processAudio()');await drain(s);await second;
  old.resolve();await Promise.resolve();await drain(s);await first;assert.equal(s.run('STATE.processedBuffer.length'),400);
});
test('short clips retain nonzero signal through time stretching',()=>{
  const s=setup();s.ctx.input=buffer(1,200);const out=s.run('solaTimeStretch(input,320,8000)');assert.ok(out.getChannelData(0).some(v=>Math.abs(v)>.01));assert.equal(out.length,320);
});
test('sub-100-sample clips still have the requested output duration',()=>{
  const s=setup();s.ctx.input=buffer(1,91);const out=s.run('solaTimeStretch(input,200,8000)');
  assert.equal(out.length,200);assert.ok(out.getChannelData(0).every(Number.isFinite));
});
test('failed recording decoding cannot expose the previous export',async()=>{
  const s=setup();s.ctx.input=buffer();s.run('STATE.originalBuffer=input;STATE.processedBuffer=input');
  const track={stop(){}};const stream={getTracks:()=>[track]};
  s.ctx.navigator={mediaDevices:{getUserMedia:async()=>stream}};
  s.ctx.MediaRecorder=class{constructor(){this.stream=stream;this.mimeType='audio/test'}start(){}stop(){}};
  s.audioCtx.createAnalyser=()=>({});s.audioCtx.createMediaStreamSource=()=>({connect(){},disconnect(){}});
  s.audioCtx.decodeAudioData=async()=>{throw Error('empty recording')};
  await s.run('startRecord()');await s.run('STATE.mediaRecorder.onstop()');
  assert.equal(s.run('STATE.processedBuffer'),null);assert.equal(s.element('btnDownload').disabled,true);
});
test('silence has no invented pitch',()=>{
  const s=setup();s.ctx.input=buffer(1,1000);s.ctx.input.getChannelData(0).fill(0);s.run('STATE.originalBuffer=input');
  // Use the real pitch estimator rather than the lightweight processing stub.
  vm.runInContext(script.slice(script.indexOf('function estimatePitch(){'),script.indexOf('// ============================================================\n// PLAYBACK')),s.ctx);
  s.run('estimatePitch()');assert.match(s.element('pitchDisplay').textContent,/--/);
});
test('superseded recording errors do not replace the latest input status',async()=>{
  const s=setup();const stream={getTracks:()=>[{stop(){}}]};
  s.ctx.navigator={mediaDevices:{getUserMedia:async()=>stream}};
  s.ctx.MediaRecorder=class{constructor(){this.stream=stream;this.mimeType='audio/test'}start(){}};
  s.audioCtx.createAnalyser=()=>({});s.audioCtx.createMediaStreamSource=()=>({connect(){},disconnect(){}});
  let rejectDecode;s.audioCtx.decodeAudioData=()=>new Promise((_,reject)=>{rejectDecode=reject});
  await s.run('startRecord()');const stopped=s.run('STATE.mediaRecorder.onstop()');await new Promise(setImmediate);
  s.run("++STATE.inputVersion;setStatus('ready','new input')");rejectDecode(Error('old error'));await stopped;
  assert.equal(s.element('statusText').textContent,'new input');
});
test('playback resumes a suspended audio context',async()=>{
  const s=setup();s.audioCtx.state='suspended';s.ctx.input=buffer();await s.run('playBuffer(input)');assert.equal(s.audioCtx.state,'running');
});
