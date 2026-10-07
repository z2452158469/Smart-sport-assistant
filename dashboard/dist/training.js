export const ACTIVITY_NAMES = {JUMPING_JACK:'开合跳', SQUAT:'蹲起', RUNNING:'跑步', IDLE:'静止', OTHER:'其他动作', UNKNOWN:'无法确定'};
export function parseSerialSample(line) {
  const fields = line.trim().split(',');
  if (fields[0] !== 'IMU' || fields.length !== 14) return null;
  const n = fields.slice(1).map(Number);
  if (!n.every(Number.isFinite) || fields.slice(1).some(s => !s.trim())) return null;
  const [seq,timestamp,ax,ay,az,gx,gy,gz,temperature,bpm,ir,flags,version] = n;
  if (version !== 2 || !Number.isInteger(seq) || seq < 0 || !Number.isInteger(timestamp) || timestamp < 0) return null;
  return {seq,timestamp,ax,ay,az,gx,gy,gz,temperature,bpm:flags&8?bpm:null,ir,mpuOK:!!(flags&1),pulseOK:!!(flags&2),finger:!!(flags&4),heartValid:!!(flags&8),pulseFresh:!!(flags&32),uptime:timestamp};
}
const csvCell = v => /[",\r\n]/.test(String(v)) ? `"${String(v).replaceAll('"','""')}"` : String(v);
export function trainingCsv(rows) {
  const header = ['timestamp_ms','accel_magnitude','label','session_id','person_id','sequence','ax','ay','az','gx','gy','gz'];
  return '\uFEFF'+[header.join(','),...rows.map(r=>[r.timestamp,r.magnitude.toFixed(5),r.label,r.session,r.person,r.seq,r.ax.toFixed(3),r.ay.toFixed(3),r.az.toFixed(3),r.gx.toFixed(3),r.gy.toFixed(3),r.gz.toFixed(3)].map(csvCell).join(','))].join('\r\n')+'\r\n';
}
export class Recorder {
  constructor(){this.rows=[];this.active=false;this.last=null;this.gaps=0;this.missing=0;this.reason='';}
  start(label,person,session){
    if(!ACTIVITY_NAMES[label]||label==='UNKNOWN')throw Error('请选择有效采集标签。');
    if(this.active)throw Error('请先停止当前采集。');
    Object.assign(this,{active:true,label,person,session,last:null,gaps:0,missing:0,reason:''});
  }
  stop(reason=''){this.active=false;this.reason=reason;}
  add(p){
    if(!this.active)return;
    if(!p.mpuOK){this.stop('MPU6050 数据无效，采集已停止。');return;}
    if(this.last&&(p.timestamp<=this.last.timestamp||p.seq<=this.last.seq)){this.stop('设备时间或序号复位，采集已停止。重新开始将使用新场次。');return;}
    if(this.last){const delta=p.seq-this.last.seq;if(delta>1)this.missing+=delta-1;if(p.timestamp-this.last.timestamp>100)this.gaps++;}
    if(this.rows.length>=300000){this.stop('已达到采集容量，请导出并清空后继续。');return;}
    this.rows.push({...p,magnitude:Math.hypot(p.ax,p.ay,p.az),label:this.label,person:this.person,session:this.session});this.last=p;
  }
}
