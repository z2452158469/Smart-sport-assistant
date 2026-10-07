import test from 'node:test';
import assert from 'node:assert/strict';
import {parseSerialSample, Recorder, trainingCsv} from '../dist/training.js';

const sample = (seq,time) => parseSerialSample(`IMU,${seq},${time},3,4,12,-0.1,0.2,0.3,26,72,123456,47,2`);
test('decode full-rate serial samples and reject debug or malformed data',()=>{
  const p=sample(1,20);assert.equal(p.gx,-0.1);assert.equal(p.heartValid,true);assert.equal(p.timestamp,20);
  assert.equal(parseSerialSample('BLE ready: SmartSport-ESP32'),null);
  assert.equal(parseSerialSample('IMU,1,NaN,3,4,12,0,0,0,26,72,123456,47,2'),null);
});
test('record every sample in SI units with fixed labels, independent sessions and escaped CSV',()=>{
  const r=new Recorder();r.start('RUNNING','person,"A"','session1');
  for(let i=0;i<150;i++)r.add(sample(i,i*20));
  assert.equal(r.rows.length,150);assert.equal(r.rows[0].magnitude,13);
  r.stop();r.start('SQUAT','p01','session2');r.add(sample(200,4000));r.stop();
  const csv=trainingCsv(r.rows);
  assert.match(csv,/timestamp_ms,accel_magnitude,label,session_id,person_id/);
  assert.match(csv,/0,13.00000,RUNNING,session1,"person,""A"""/);
  assert.equal(r.rows.at(-1).session,'session2');assert.equal(r.rows.at(-1).label,'SQUAT');
});
test('detect missing packets and stop on reset rather than inventing samples',()=>{
  const r=new Recorder();r.start('IDLE','p01','session');r.add(sample(0,0));r.add(sample(3,140));
  assert.equal(r.missing,2);assert.equal(r.gaps,1);assert.equal(r.rows.length,2);
  r.add(sample(0,0));assert.equal(r.active,false);assert.equal(r.rows.length,2);
});
