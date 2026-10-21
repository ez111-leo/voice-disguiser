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
function blankBuffer(ch,len,sr){const b=buffer(ch,len,sr);for(let c=0;c<ch;c++)b.getChannelData(c).fill(0);return b}
function setup() {
  const elements=new Map(), renders=[], sources=[], blobs=[];
  const element=id=>{if(!elements.has(id))elements.set(id,{disabled:false,textContent:'',className:'',setAttribute(){},classList:{toggle(){},add(){},remove(){}},click(){}});return elements.get(id)};
  class Offline {
    constructor(ch,len,sr){this.buffer=buffer(ch,len,sr);this.destination={};this.filters=[];this.sources=[];}
    createBuffer(ch,len,sr){return blankBuffer(ch,len,sr)}
    createBufferSource(){const s={playbackRate:{value:1},connect(n){this.target=n},start(){}};this.sources.push(s);return s}
    createBiquadFilter(){const f={frequency:{},Q:{},connect(n){this.target=n}};this.filters.push(f);return f}
    startRendering(){return new Promise((resolve,reject)=>renders.push({context:this,resolve:()=>resolve(this.buffer),reject}))}
  }
  const audioCtx={sampleRate:8000,state:'running',destination:{},createBuffer:blankBuffer,createBufferSource(){const s={playbackRate:{},connect(n){this.target=n},start(){},stop(){}};sources.push(s);return s},resume:async()=>{audioCtx.state='running'}};
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
test('stopped sources cannot overwrite the current recording status',async()=>{
  const s=setup();s.ctx.input=buffer();await s.run('playBuffer(input)');const old=s.sources[0];
  s.run("stopAll();STATE.isRecording=true;setStatus('recording','recording now')");old.onended();
  assert.equal(s.element('statusText').textContent,'recording now');
});
test('stop cancels playback while audio context is resuming',async()=>{
  const s=setup();s.audioCtx.state='suspended';let resume;
  s.audioCtx.resume=()=>new Promise(resolve=>{resume=resolve});s.ctx.input=buffer();
  const p=s.run('playBuffer(input)');s.run('stopAll()');resume();await p;
  assert.equal(s.sources.length,0);
});
test('failed conversion leaves original playback available with the requested filter',async()=>{
  const s=setup();s.ctx.input=buffer();s.run('STATE.originalBuffer=input;STATE.filterEnabled=true');
  const p=s.run('processAudio()');s.renders.shift().resolve();await new Promise(setImmediate);
  s.renders.shift().reject(Error('render failed'));await p;
  assert.equal(s.element('btnPlayChanged').disabled,true);
  await s.run('playOriginal()');assert.equal(s.sources.length,1);
});
function realPitch(s){vm.runInContext(script.slice(script.indexOf('function estimatePitch(){'),script.indexOf('// ============================================================\n// PLAYBACK')),s.ctx)}
test('constant DC signal has no invented pitch',()=>{
  const s=setup();s.ctx.input=buffer(1,4000);s.ctx.input.getChannelData(0).fill(.25);s.run('STATE.originalBuffer=input');realPitch(s);s.run('estimatePitch()');
  assert.match(s.element('pitchDisplay').textContent,/--/);
});
test('uncorrelated noise has no confident pitch',()=>{
  const s=setup();s.ctx.input=buffer(1,4000);let seed=37;
  const d=s.ctx.input.getChannelData(0);for(let i=0;i<d.length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;d[i]=seed/4294967296-.5}
  s.run('STATE.originalBuffer=input');realPitch(s);s.run('estimatePitch()');assert.match(s.element('pitchDisplay').textContent,/--/);
});
test('pitch estimator ignores DC offset on a voiced tone',()=>{
  const s=setup();s.ctx.input=buffer(1,4000);const d=s.ctx.input.getChannelData(0);for(let i=0;i<d.length;i++)d[i]=.25+.3*Math.sin(2*Math.PI*220*i/8000);
  s.run('STATE.originalBuffer=input');realPitch(s);s.run('estimatePitch()');assert.ok(Math.abs(parseFloat(s.element('pitchDisplay').textContent.split(':')[1])-220)<3);
});
for(const hz of [50,500])test(`pitch estimator includes the ${hz} Hz boundary`,()=>{
  const s=setup();s.ctx.input=buffer(1,9600,48000);const d=s.ctx.input.getChannelData(0);for(let i=0;i<d.length;i++)d[i]=.3*Math.sin(2*Math.PI*hz*i/48000);
  s.run('STATE.originalBuffer=input');realPitch(s);s.run('estimatePitch()');assert.ok(Math.abs(parseFloat(s.element('pitchDisplay').textContent.split(':')[1])-hz)<3,s.element('pitchDisplay').textContent);
});
test('SOLA shares frame offsets across stereo channels',()=>{
  const s=setup();s.ctx.input=buffer(2,4000);const l=s.ctx.input.getChannelData(0),r=s.ctx.input.getChannelData(1);
  for(let i=0;i<l.length;i++){l[i]=.3*Math.sin(i*.11+i*i*.00002);r[i]=l[i]*.5+.15}
  const out=s.run('solaTimeStretch(input,6400,8000)');const a=out.getChannelData(0),b=out.getChannelData(1);
  let max=0;for(let i=0;i<a.length;i++)max=Math.max(max,Math.abs(b[i]-.5*a[i]-.15));assert.ok(max<1e-5,`channel relationship error: ${max}`);
});
test('recording runtime errors release the microphone and unlock input',async()=>{
  const s=setup();let stopped=false,disconnected=false;
  const stream={getTracks:()=>[{stop(){stopped=true}}]};
  s.ctx.navigator={mediaDevices:{getUserMedia:async()=>stream}};
  s.ctx.MediaRecorder=class{constructor(){this.stream=stream;this.mimeType='audio/test';this.state='recording'}start(){}stop(){this.state='inactive'}};
  s.audioCtx.createAnalyser=()=>({});s.audioCtx.createMediaStreamSource=()=>({connect(){},disconnect(){disconnected=true}});
  await s.run('startRecord()');assert.equal(typeof s.run('STATE.mediaRecorder.onerror'),'function');
  s.run("STATE.mediaRecorder.onerror({error:{message:'device lost'}})");
  assert.ok(stopped&&disconnected);assert.equal(s.run('STATE.isRecording'),false);assert.equal(s.element('btnRecord').disabled,false);assert.equal(s.element('btnDownload').disabled,true);
});
test('leaving the page stops recording and releases microphone tracks',async()=>{
  const s=setup();let stopped=false;
  const stream={getTracks:()=>[{stop(){stopped=true}}]};
  s.ctx.navigator={mediaDevices:{getUserMedia:async()=>stream}};
  s.ctx.MediaRecorder=class{constructor(){this.stream=stream;this.state='recording'}start(){}stop(){this.state='inactive'}};
  s.audioCtx.createAnalyser=()=>({});s.audioCtx.createMediaStreamSource=()=>({connect(){},disconnect(){}});
  await s.run('startRecord()');assert.equal(s.run('typeof cleanupAudio'),'function');s.run('cleanupAudio()');
  assert.ok(stopped);assert.equal(s.run('STATE.isRecording'),false);assert.equal(s.run('STATE.microphoneSource'),null);
});
test('microphone permission completing after page exit cannot restart capture',async()=>{
  const s=setup();let grant,stopped=false;const stream={getTracks:()=>[{stop(){stopped=true}}]};
  s.ctx.navigator={mediaDevices:{getUserMedia:()=>new Promise(resolve=>{grant=resolve})}};
  s.ctx.MediaRecorder=class{};
  const pending=s.run('startRecord()');s.run('cleanupAudio()');grant(stream);await pending;
  assert.ok(stopped);assert.equal(s.run('STATE.isRecording'),false);assert.equal(s.run('STATE.isRequestingMic'),false);
});
test('asynchronous SOLA yields and abandons a superseded conversion',async()=>{
  const s=setup();s.ctx.input=buffer(1,160000);let timerRan=false;
  const cancel=new Promise(resolve=>setTimeout(()=>{timerRan=true;s.run('++STATE.processingVersion');resolve()},0));
  const p=s.run('solaTimeStretchAsync(input,256000,8000,STATE.processingVersion)');
  await cancel;
  const result=await p;assert.ok(timerRan);assert.equal(result,null);
});
function canvasFixture(s,id){
  let changes=0,fills=0,width=0,height=0;
  const ctx=new Proxy({fillRect(){fills++},setTransform(){}},{get:(o,k)=>k in o?o[k]:()=>{}});
  const canvas=s.element(id);canvas.parentElement={getBoundingClientRect:()=>({width:300,height:150})};canvas.style={};canvas.getContext=()=>ctx;
  Object.defineProperties(canvas,{width:{get:()=>width,set:v=>{width=v;changes++}},height:{get:()=>height,set:v=>{height=v;changes++}}});
  return {changes:()=>changes,fills:()=>fills};
}
test('unchanged canvas dimensions do not reallocate backing buffers every frame',()=>{
  const s=setup(),canvas=canvasFixture(s,'canvasWave');s.run('STATE.analyserNode=null;drawWaveform();drawWaveform()');assert.equal(canvas.changes(),2);
});
test('spectrogram history remains visible when playback becomes silent',()=>{
  const s=setup(),canvas=canvasFixture(s,'canvasSpectrogram');
  s.ctx.testAnalyser={frequencyBinCount:8,getByteFrequencyData:data=>data.fill(0)};
  s.run('STATE.analyserNode=testAnalyser;STATE.spectrogramData=[new Uint8Array(8).fill(200),new Uint8Array(8).fill(100)];drawSpectrogram()');
  assert.ok(canvas.fills()>2);
});
