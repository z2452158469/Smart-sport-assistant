import { SERVICE_UUID, DATA_UUID, decodePacket } from './protocol.js';
import { ACTIVITY_NAMES, Recorder, parseSerialSample, trainingCsv } from './training.js';

const $ = id => document.getElementById(id);
const colors = ['#2867eb', '#e99a30', '#13a99c', '#7866cd'];
let device = null, characteristic = null, connected = false, busy = false;
let latest = null, motion = null, lastPrimary = 0, lastMotion = 0, lastPacket = 0;
let heartHistory = [], accelHistory = [], packetTimes = [], windowSeconds = 60;
let generation = 0;
const recorder = new Recorder();
let serialPort = null, serialReader = null, serialTask = null;
let serialClosing = false, serialWriteTask = null;
let predictionSamples = [], predictionBusy = false, lastPrediction = 0;
let modelLoaded = false, modelWindow = 2, modelChecking = false, serialLast = null;
let lastHistoryTime = 0;
const format = (v, digits = 2) => Number.isFinite(v) ? v.toFixed(digits) : '—';
const isFresh = (time, now = Date.now()) => !!time && now - time < 2500;

function notice(text, error = false) { $('notice').textContent = text; $('notice').classList.toggle('error', error); }
function setStatus(text, mode = '') { $('connectionStatus').textContent = text; $('connectionStatus').className = `status ${mode}`; }
function showSensor(id, ok, ready) { $(id).textContent = !ready ? '—' : ok ? '正常' : '未检测到'; $(id).className = !ready ? '' : ok ? 'ok' : 'bad'; }

function renderValues() {
  $('transportSelect').disabled = connected || busy;
  const now = Date.now();
  const ready = connected && isFresh(lastPrimary, now);
  const gyroReady = connected && isFresh(lastMotion, now) && motion?.mpuOK;
  const aReady = ready && latest?.mpuOK;
  const heartReady = ready && latest?.pulseOK && latest?.pulseFresh && latest?.heartValid;
  const factor = $('unitSelect').value === 'g' ? 9.80665 : 1;
  const unit = factor === 1 ? 'm/s²' : 'g';
  $('accelUnit').textContent = $('axisUnit').textContent = unit;
  $('heartValue').textContent = heartReady ? format(latest.bpm, 0) : '—';
  $('heartState').textContent = !connected ? '等待设备连接' : !ready ? '等待实时数据' : !latest.pulseOK ? 'MAX30102 未检测到' : !latest.pulseFresh ? '传感器无新样本' : !latest.finger ? '请将手指轻贴传感器' : !latest.heartValid ? '测量中，请保持稳定' : '最近最多 4 次有效心跳平均';
  const magnitude = aReady ? Math.hypot(latest.ax, latest.ay, latest.az) : null;
  $('accelValue').textContent = $('magnitudeValue').textContent = format(aReady ? magnitude / factor : null);
  $('magnitudeUnit').textContent = unit;
  $('tempValue').textContent = aReady ? format(latest.temperature, 1) : '—';
  ['x', 'y', 'z'].forEach(axis => {
    const value = aReady ? latest[`a${axis}`] / factor : null;
    $(`${axis}Value`).textContent = format(value);
    $(`${axis}Bar`).style.width = aReady ? `${Math.min(100, Math.abs(latest[`a${axis}`]) / (8 * 9.80665) * 100)}%` : '0%';
    $(`g${axis}Value`).textContent = format(gyroReady ? motion[`g${axis}`] : null, 3);
  });
  $('uptimeValue').textContent = connected && isFresh(lastMotion, now) ? formatTime(motion.uptime) : '—';
  showSensor('mpuStatus', latest?.mpuOK, ready); showSensor('pulseStatus', latest?.pulseOK, ready);
  $('fingerStatus').textContent = !ready || !latest?.pulseFresh ? '—' : latest.finger ? '已接触' : '未接触';
  $('fingerStatus').className = ready && latest?.finger ? 'ok' : '';
  $('irValue').textContent = ready && latest?.pulseFresh ? latest.ir.toLocaleString() : '—';
  packetTimes = packetTimes.filter(t => now - t < 3000);
  $('receiveRate').textContent = connected && isFresh(lastPacket, now) ? `${(packetTimes.length / 3).toFixed(1)} 包/秒` : '—';
  $('dataAge').textContent = lastPacket ? `最近数据：${((now - lastPacket) / 1000).toFixed(1)} 秒前` : '尚未接收数据';
  if (!busy && connected) setStatus(ready ? '实时接收' : '数据中断', ready ? 'live' : 'stale');
  $('footerState').textContent = !connected ? '等待连接' : ready ? (serialPort ? '串口数据传输中' : '蓝牙数据传输中') : '等待设备数据';
  if (recorder.active && (!connected || !isFresh(lastPrimary))) recorder.stop('连接或数据中断，采集已停止；记录已保留。');
  $('recordButton').disabled = !recorder.active && !(serialPort && connected && ready && latest?.mpuOK);
  $('recordButton').textContent = recorder.active ? '停止采集' : '开始采集';
  $('labelSelect').disabled = $('personInput').disabled = recorder.active;
  $('exportButton').disabled = recorder.active || recorder.rows.length === 0;
  $('clearButton').disabled = recorder.active || recorder.rows.length === 0;
  const recent = recorder.rows.slice(-151).filter(r => r.session === recorder.session);
  const measured = recent.length > 1 ? 1000*(recent.length-1)/(recent.at(-1).timestamp-recent[0].timestamp) : 0;
  $('recordStatus').textContent = `${recorder.active ? '采集中 · '+ACTIVITY_NAMES[recorder.label] : '已停止'} · ${recorder.rows.length} 条记录 · ${measured.toFixed(1)} Hz · 丢失 ${recorder.missing} 条 · 长断点 ${recorder.gaps} 次${recorder.reason?' · '+recorder.reason:''}`;
  if (!serialPort || !ready || !modelLoaded || Date.now()-lastPrediction>3000) {
    $('activityValue').textContent = '尚未识别'; $('activityConfidence').textContent = '—';
  }
}

function formatTime(ms) {
  const seconds = Math.floor(ms / 1000);
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(v => String(v).padStart(2, '0')).join(':');
}

function receive(event) {
  const p = decodePacket(event.target.value);
  if (!p) { notice('收到不兼容的数据，请上传配套的 SmartSportBLE 程序。', true); return; }
  const time = Date.now(); lastPacket = time; packetTimes.push(time);
  if (p.type === 1) {
    latest = p; lastPrimary = time;
    heartHistory.push({time, values: [p.pulseOK && p.pulseFresh && p.heartValid ? p.bpm : null]});
    accelHistory.push({time, values: p.mpuOK ? [p.ax, p.ay, p.az, Math.hypot(p.ax, p.ay, p.az)] : [null, null, null, null]});
    if (isFresh(lastPrimary)) notice('已连接，数据正在实时更新。心率测量时请保持手指稳定。');
  } else { motion = p; lastMotion = time; }
  heartHistory = heartHistory.filter(p => time - p.time < 120000);
  accelHistory = accelHistory.filter(p => time - p.time < 120000);
  renderValues();
}

function clearSession() {
  latest = motion = null; lastPrimary = lastMotion = lastPacket = 0;
  heartHistory = []; accelHistory = []; packetTimes = [];
  predictionSamples = []; serialLast = null; lastPrediction = 0;
}

function disconnected() {
  recorder.stop('连接已断开，采集记录已保留。');
  connected = false; busy = false; generation++;
  characteristic?.removeEventListener('characteristicvaluechanged', receive);
  characteristic = null;
  $('connectButton').disabled = false; $('connectButton').textContent = '重新连接';
  setStatus('已断开'); $('deviceName').textContent = '未连接';
  notice('设备连接已断开。采集记录已保留，可导出 CSV。');
  renderValues();
}

async function connect() {
  if ($('transportSelect').value === 'serial') return connectSerial();
  if (connected) { device?.gatt.disconnect(); return; }
  if (busy) return;
  if (!window.isSecureContext) { notice('请通过 HTTPS 或 localhost 打开网页，浏览器才能使用蓝牙。', true); return; }
  if (!navigator.bluetooth) { notice('此浏览器不支持网页蓝牙，请在电脑 Chrome 或 Edge 中打开，并开启系统蓝牙。', true); return; }
  busy = true; $('connectButton').disabled = true; setStatus('连接中…');
  let selected;
  const attempt = ++generation;
  try {
    selected = await navigator.bluetooth.requestDevice({filters: [{services: [SERVICE_UUID]}]});
    device?.removeEventListener('gattserverdisconnected', disconnected);
    device = selected;
    device.addEventListener('gattserverdisconnected', disconnected);
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    characteristic = await service.getCharacteristic(DATA_UUID);
    characteristic.addEventListener('characteristicvaluechanged', receive);
    clearSession(); connected = true;
    await characteristic.startNotifications();
    if (attempt !== generation || !device.gatt.connected) throw new Error('连接已中断');
    $('deviceName').textContent = device.name || 'SmartSport-ESP32';
    $('connectButton').textContent = '断开连接';
    notice('蓝牙已连接，等待传感器数据…');
    setStatus('等待数据', 'stale');
  } catch (error) {
    characteristic?.removeEventListener('characteristicvaluechanged', receive);
    device?.removeEventListener('gattserverdisconnected', disconnected);
    selected?.gatt?.disconnect(); connected = false; characteristic = null;
    $('connectButton').textContent = '连接设备'; $('deviceName').textContent = '未连接'; setStatus('未连接');
    if (error.name === 'NotFoundError') notice('未选择设备。请上传 SmartSportBLE 程序并开启蓝牙，然后重试。');
    else notice(`连接未成功：${error.message}。请检查设备供电与电脑蓝牙，设备一次连接一个网页。`, true);
  } finally { busy = false; $('connectButton').disabled = false; renderValues(); }
}

function acceptSerialSample(p) {
  const now = Date.now();
  if (serialLast && (p.timestamp <= serialLast.timestamp || p.seq <= serialLast.seq || p.timestamp-serialLast.timestamp>100 || p.seq-serialLast.seq>1)) {
    predictionSamples = []; lastPrediction = 0; generation++;
  }
  serialLast = p; latest = motion = p;
  lastPrimary = lastMotion = lastPacket = now; packetTimes.push(now);
  recorder.add(p);
  if (p.mpuOK) predictionSamples.push([p.timestamp, Math.hypot(p.ax,p.ay,p.az)]);
  else predictionSamples = [];
  predictionSamples = predictionSamples.filter(row => p.timestamp-row[0] <= (modelWindow+1)*1000);
  // Keep chart rendering at 5Hz while recording every received 50Hz sample.
  if (now-lastHistoryTime >= 200) {
    lastHistoryTime = now;
    heartHistory.push({time:now,values:[p.heartValid&&p.pulseFresh?p.bpm:null]});
    accelHistory.push({time:now,values:p.mpuOK?[p.ax,p.ay,p.az,Math.hypot(p.ax,p.ay,p.az)]:[null,null,null,null]});
    heartHistory = heartHistory.filter(r=>now-r.time<120000);
    accelHistory = accelHistory.filter(r=>now-r.time<120000);
  }
}

async function readSerial(port) {
  const decoder = new TextDecoder(); let pending = '';
  try {
    serialReader = port.readable.getReader();
    while (connected && !serialClosing) {
      const {value,done} = await serialReader.read(); if(done)break;
      pending += decoder.decode(value,{stream:true});
      const lines = pending.split('\n'); pending = lines.pop();
      if (pending.length>4096) pending='';
      for (const line of lines) { const p=parseSerialSample(line); if(p)acceptSerialSample(p); }
    }
  } catch(error) { if(!serialClosing)notice(`串口读取中断：${error.message}`,true); }
  finally {
    serialReader?.releaseLock(); serialReader=null;
    if(!serialClosing) {
      if(serialWriteTask)await serialWriteTask.catch(()=>{});
      await port.close().catch(()=>{});serialPort=null;disconnected();
    }
  }
}

async function connectSerial() {
  if(connected) {
    serialClosing=true; connected=false;
    await serialReader?.cancel().catch(()=>{});await serialTask;
    if(serialWriteTask)await serialWriteTask.catch(()=>{});
    await serialPort?.close().catch(()=>{});serialPort=null;serialClosing=false;
    disconnected();return;
  }
  if(busy)return;
  if(!navigator.serial||!window.isSecureContext){notice('请用电脑 Chrome/Edge 通过 localhost 打开网页，以使用 USB 串口。',true);return;}
  busy=true;$('connectButton').disabled=true;setStatus('选择串口…');
  try {
    const selected=await navigator.serial.requestPort();
    await selected.open({baudRate:115200});serialPort=selected;clearSession();connected=true;
    $('deviceName').textContent='ESP32 · USB';$('connectButton').textContent='断开连接';
    notice('串口已连接，等待 50Hz 数据。请关闭 Arduino 串口监视器，避免端口占用。');
    serialTask=readSerial(selected);
  } catch(error){notice(`串口连接未成功：${error.message}。请上传最新固件并关闭其他串口软件。`,true);}
  finally{busy=false;$('connectButton').disabled=false;$('transportSelect').disabled=connected;renderValues();}
}

async function checkModel() {
  if(modelChecking)return;modelChecking=true;
  try {
    const response=await fetch('/api/model');const data=await response.json();
    modelLoaded=response.ok&&data.loaded;modelWindow=data.window_seconds||2;
    $('modelStatus').textContent=modelLoaded?'电脑模型已加载 · 每 0.5 秒识别一次':data.error||'尚无模型，请先采集并训练。';
  } catch {modelLoaded=false;$('modelStatus').textContent='识别服务未启动，请用 start-dashboard.cmd 启动本地服务。';}
  finally{modelChecking=false;}
}

async function predictActivity() {
  if(predictionBusy||!modelLoaded||!serialPort||!connected||!isFresh(lastPrimary))return;
  const rows=predictionSamples.slice();
  if(rows.length<modelWindow*50||rows.at(-1)[0]-rows[0][0]<(modelWindow*50-1)*20)return;
  predictionBusy=true;const port=serialPort,epoch=generation;
  try {
    const response=await fetch('/api/predict',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({samples:rows})});
    const result=await response.json();
    if(port!==serialPort||!connected||epoch!==generation||!isFresh(lastPrimary)||!serialLast||serialLast.timestamp-result.sample_timestamp_ms>1500)return;
    if(!response.ok){$('modelStatus').textContent=result.error;return;}
    lastPrediction=Date.now();
    $('activityValue').textContent=ACTIVITY_NAMES[result.prediction]||result.prediction;
    $('activityConfidence').textContent=`置信度 ${(result.confidence*100).toFixed(0)}%`;
    const wireLabel=ACTIVITY_NAMES[result.prediction]?result.prediction:'UNKNOWN';
    const writer=port.writable.getWriter();
    serialWriteTask=(async()=>{try{await writer.write(new TextEncoder().encode(`ACT,${wireLabel},${result.confidence.toFixed(4)}\n`));}finally{writer.releaseLock();}})();
    await serialWriteTask;serialWriteTask=null;
  } catch(error){$('modelStatus').textContent=`识别暂不可用：${error.message}`;}
  finally{predictionBusy=false;}
}

function toggleRecording() {
  if(recorder.active){recorder.stop();renderValues();return;}
  if(!serialPort||!connected||!latest?.mpuOK||!isFresh(lastPrimary)){notice('训练采集需要连接 USB 串口，并接收到最新 MPU6050 数据。',true);return;}
  const session=`session_${Date.now()}_${crypto.randomUUID()}`;
  recorder.start($('labelSelect').value,$('personInput').value.trim(),session);renderValues();
}

function exportRecording() {
  if(recorder.active||!recorder.rows.length)return;
  const url=URL.createObjectURL(new Blob([trainingCsv(recorder.rows)],{type:'text/csv;charset=utf-8'}));
  const link=document.createElement('a');link.href=url;link.download=`motion_${Date.now()}.csv`;
  document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  notice('CSV 已导出，时间戳来自设备，单位固定为 m/s²。每类请采集至少两个独立场次。');
}

function drawChart(id, rows, seriesColors, defaults, unitFactor = 1) {
  const canvas = $(id), box = canvas.getBoundingClientRect(), ratio = window.devicePixelRatio || 1;
  if (!box.width || !box.height) return;
  const width = Math.round(box.width), height = Math.round(box.height);
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) { canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio); }
  const ctx = canvas.getContext('2d'); if (!ctx) return;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.clearRect(0, 0, width, height);
  const now = Date.now(), start = now - windowSeconds * 1000;
  const visible = rows.filter(r => r.time >= start);
  const data = visible.flatMap(r => r.values).filter(Number.isFinite).map(v => v / unitFactor);
  let min = defaults[0], max = defaults[1];
  if (data.length) { min = Math.min(min, ...data); max = Math.max(max, ...data); }
  const range = max - min || 1; min -= range * .08; max += range * .08;
  const pad = {left: 40, right: 10, top: 14, bottom: 26};
  const w = width - pad.left - pad.right, h = height - pad.top - pad.bottom;
  const x = t => pad.left + (t - start) / (windowSeconds * 1000) * w;
  const y = v => pad.top + (max - v / unitFactor) / (max - min) * h;
  ctx.font = '11px Segoe UI, sans-serif'; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const yy = pad.top + h * i / 4;
    ctx.strokeStyle = '#edf0f5'; ctx.beginPath(); ctx.moveTo(pad.left, yy); ctx.lineTo(width - pad.right, yy); ctx.stroke();
    ctx.fillStyle = '#8b96a8'; ctx.textAlign = 'right';
    ctx.fillText((max - (max - min) * i / 4).toFixed(unitFactor === 1 ? 0 : 1), pad.left - 8, yy + 4);
  }
  for (let i = 0; i <= 4; i++) {
    ctx.textAlign = i === 0 ? 'left' : i === 4 ? 'right' : 'center'; ctx.fillStyle = '#8b96a8';
    ctx.fillText(i === 4 ? '现在' : `−${Math.round(windowSeconds * (1 - i / 4))}s`, pad.left + w * i / 4, height - 6);
  }
  ctx.save(); ctx.beginPath(); ctx.rect(pad.left, pad.top, w, h); ctx.clip();
  seriesColors.forEach((color, index) => {
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.beginPath();
    let pen = false, previous = 0;
    visible.forEach(row => {
      const value = row.values[index];
      if (!Number.isFinite(value)) { pen = false; return; }
      if (!pen || row.time - previous > 1500) ctx.moveTo(x(row.time), y(value)); else ctx.lineTo(x(row.time), y(value));
      pen = true; previous = row.time;
    }); ctx.stroke();
    const last = visible.at(-1);
    if (last && Number.isFinite(last.values[index]) && now - last.time < 2500) { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x(last.time), y(last.values[index]), 3, 0, Math.PI * 2); ctx.fill(); }
  }); ctx.restore();
  return data.length > 0;
}

function drawCharts() {
  const hasHeart = drawChart('heartChart', heartHistory, ['#e54c70'], [40, 160]);
  const factor = $('unitSelect').value === 'g' ? 9.80665 : 1;
  const hasAccel = drawChart('accelChart', accelHistory, colors, [-12 / factor, 12 / factor], factor);
  $('heartEmpty').hidden = !!hasHeart; $('accelEmpty').hidden = !!hasAccel;
  $('heartEmpty').textContent = connected ? '等待有效心率，请轻贴手指并保持稳定' : '连接设备后，心率曲线将在这里出现';
}

$('connectButton').addEventListener('click', connect);
$('recordButton').addEventListener('click',toggleRecording);
$('exportButton').addEventListener('click',exportRecording);
$('clearButton').addEventListener('click',()=>{if(!recorder.active&&confirm('清空所有采集记录？请先导出需要保留的数据。')){recorder.rows=[];recorder.reason='';renderValues();}});
$('transportSelect').addEventListener('change',()=>notice($('transportSelect').value==='serial'?'通过 USB 连接 ESP32，选择 COM 端口。':'蓝牙模式用于查看数据。训练采集与电脑识别请使用 USB 串口。'));
setInterval(checkModel,5000);setInterval(predictActivity,500);checkModel();
$('unitSelect').addEventListener('change', () => {renderValues(); drawCharts();});
$('windowSelect').addEventListener('change', () => {windowSeconds = Number($('windowSelect').value); drawCharts();});
window.addEventListener('resize', drawCharts);
window.addEventListener('pagehide', () => {device?.gatt?.disconnect();serialReader?.cancel().catch(()=>{});});
window.addEventListener('beforeunload',event=>{if(recorder.rows.length){event.preventDefault();event.returnValue='';}});
setInterval(() => {renderValues(); drawCharts();}, 200);
if (!navigator.serial) notice('当前浏览器不支持串口。采集时请用电脑 Chrome 或 Edge 打开此页面。', true);
renderValues(); requestAnimationFrame(drawCharts);
