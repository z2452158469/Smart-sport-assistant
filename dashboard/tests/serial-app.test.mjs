import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {decodePacket,SERVICE_UUID,DATA_UUID} from '../dist/protocol.js';
import {ACTIVITY_NAMES,Recorder,parseSerialSample,trainingCsv} from '../dist/training.js';

test('fragmented serial stream -> labeled SI CSV -> PC prediction -> ACT response',async()=>{
  const elements=new Map(),tickers=[],writes=[];let resolveRead,blob;
  const el=id=>{
    if(!elements.has(id))elements.set(id,{textContent:'',className:'',style:{},listeners:{},
      value:({transportSelect:'serial',unitSelect:'ms2',labelSelect:'SQUAT',personInput:'p01'})[id]||'60',
      classList:{toggle(){}},addEventListener(type,fn){this.listeners[type]=fn;},getBoundingClientRect(){return {width:0,height:0};}});
    return elements.get(id);
  };
  const reader={read:()=>new Promise(resolve=>{resolveRead=resolve;}),cancel:async()=>resolveRead({done:true}),releaseLock(){}};
  const port={open:async()=>{},close:async()=>{},readable:{getReader:()=>reader},writable:{getWriter:()=>({write:async bytes=>writes.push(new TextDecoder().decode(bytes)),releaseLock(){}})}};
  const context=vm.createContext({decodePacket,SERVICE_UUID,DATA_UUID,ACTIVITY_NAMES,Recorder,parseSerialSample,trainingCsv,DataView,Blob,TextDecoder,TextEncoder,
    Date:{now:()=>10000},crypto:{randomUUID:()=> 'test-session'},URL:{createObjectURL:value=>{blob=value;return 'blob:test';},revokeObjectURL(){}},
    document:{getElementById:el,createElement:()=>({click(){},remove(){}}),body:{appendChild(){}}},
    navigator:{serial:{requestPort:async()=>port}},window:{isSecureContext:true,addEventListener(){}},
    fetch:async(path)=>({ok:true,json:async()=>path==='/api/model'?{loaded:true,window_seconds:2}:{prediction:'RUNNING',confidence:.91,sample_timestamp_ms:2980}}),
    setInterval:fn=>tickers.push(fn),setTimeout:fn=>fn(),requestAnimationFrame:fn=>fn()});
  vm.runInContext(readFileSync(new URL('../dist/app.js',import.meta.url),'utf8').replace(/^import .+;\r?\n/gm,''),context);
  const flush=()=>new Promise(resolve=>setImmediate(resolve));
  const feed=async text=>{resolveRead({value:new TextEncoder().encode(text),done:false});await flush();};
  await el('connectButton').listeners.click();await flush();
  await feed('Boot log\nIMU,0,0,0,0,9.81,0,0,0,26,72,100000,47,2\n');
  tickers.find(fn=>!fn.name)();
  assert.equal(el('recordButton').disabled,false);
  el('recordButton').listeners.click();
  el('unitSelect').value='g';el('unitSelect').listeners.change();
  let text='';for(let i=1;i<150;i++)text+=`IMU,${i},${i*20},0,0,9.81,0,0,0,26,72,100000,47,2\n`;
  await feed(text.slice(0,37));await feed(text.slice(37));
  await tickers.find(fn=>fn.name==='predictActivity')();
  assert.equal(el('activityValue').textContent,'跑步');
  assert.equal(writes.at(-1),'ACT,RUNNING,0.9100\n');
  el('recordButton').listeners.click();el('exportButton').listeners.click();
  const csv=await blob.text();assert.equal(csv.trim().split('\n').length,150);
  assert.match(csv,/20,9.81000,SQUAT,session_10000_test-session,p01,1/);
  assert.equal(el('accelValue').textContent,'1.00');
  await el('connectButton').listeners.click();assert.equal(el('connectionStatus').textContent,'已断开');
});
