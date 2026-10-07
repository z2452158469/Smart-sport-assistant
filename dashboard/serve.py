"""Local dashboard and optional sklearn inference. Sensor data stays local."""
import argparse
import json
import sys
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
TRAINING = ROOT.parent / 'motion_training'
sys.path.insert(0, str(TRAINING))
if (TRAINING / '.deps').is_dir(): sys.path.insert(0, str(TRAINING / '.deps'))
model_path = TRAINING / 'models' / 'motion_model.joblib'
lock = threading.Lock()
bundle = None
loaded_mtime = None

def load_model():
    global bundle, loaded_mtime
    if not model_path.is_file():
        bundle = None; loaded_mtime = None; return None
    mtime = model_path.stat().st_mtime_ns
    if bundle is None or loaded_mtime != mtime:
        import joblib
        candidate = joblib.load(model_path)
        m = candidate['metadata']
        if m['sample_rate_hz'] != 50 or m['acceleration_unit'] != 'm/s^2':
            raise ValueError('实时识别需要使用 50Hz、m/s² 数据训练的模型。')
        bundle = candidate; loaded_mtime = mtime
    return bundle

class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control','no-store'); self.send_header('X-Content-Type-Options','nosniff'); super().end_headers()
    def reply(self,value,status=200):
        content=json.dumps(value,ensure_ascii=False,allow_nan=False).encode('utf-8')
        self.send_response(status); self.send_header('Content-Type','application/json; charset=utf-8'); self.send_header('Content-Length',str(len(content))); self.end_headers(); self.wfile.write(content)
    def do_GET(self):
        if self.path!='/api/model': return super().do_GET()
        try:
            with lock:
                current=load_model()
                self.reply({'loaded':current is not None,'window_seconds':current['metadata']['window_seconds'] if current else 2,'classes':current['metadata']['classes'] if current else []})
        except Exception as error: self.reply({'loaded':False,'error':str(error)},503)
    def do_POST(self):
        origin=self.headers.get('Origin');port=self.server.server_port
        if origin and origin not in {f'http://localhost:{port}',f'http://127.0.0.1:{port}'}:
            self.reply({'error':'不允许此来源访问本地模型。'},403);return
        if self.path!='/api/predict': self.reply({'error':'接口不存在'},404);return
        try:
            length=int(self.headers.get('Content-Length','0'))
            if not 0<length<=100000: raise ValueError('请求大小无效')
            request=json.loads(self.rfile.read(length))
            with lock:
                current=load_model()
                if current is None:
                    self.reply({'error':'未找到模型，请先训练 motion_training/models/motion_model.joblib。'},409);return
                import numpy as np
                from features import FEATURE_NAMES, extract_features
                m=current['metadata']
                if m['feature_names']!=FEATURE_NAMES: raise ValueError('模型特征版本不匹配，请重新训练。')
                s=np.asarray(request['samples'],dtype=float)
                if s.ndim!=2 or s.shape[1]!=2 or not np.isfinite(s).all() or np.any(s[:,1]<0): raise ValueError('输入必须为时间戳和非负合加速度')
                rate=m['sample_rate_hz'];size=round(rate*m['window_seconds'])
                if len(s)<size: raise ValueError('有效数据不足一个模型窗口')
                dt=np.diff(s[:,0])
                if np.any(dt<=0) or np.any(dt>100) or not 0.85*rate<=1000/np.median(dt)<=1.15*rate: raise ValueError('采样时间有断点或采样率不符，等待连续 50Hz 数据。')
                grid=s[-1,0]-np.arange(size-1,-1,-1)*(1000/rate)
                if grid[0]<s[0,0]: raise ValueError('窗口持续时间不足')
                scores=current['model'].predict_proba([extract_features(np.interp(grid,s[:,0],s[:,1]),rate)])[0]
                index=int(np.argmax(scores)); confidence=float(scores[index]); candidate=str(current['model'].classes_[index])
                self.reply({'prediction':candidate if confidence>=0.6 else 'UNKNOWN','candidate':candidate,'confidence':confidence,'sample_timestamp_ms':float(s[-1,0])})
        except (KeyError,ValueError,TypeError) as error: self.reply({'error':str(error)},400)
        except Exception as error: self.reply({'error':str(error)},503)

if __name__=='__main__':
    parser=argparse.ArgumentParser(description='本地仪表盘与电脑模型识别服务')
    parser.add_argument('--port',type=int,default=8082);parser.add_argument('--model',type=Path,default=model_path)
    args=parser.parse_args();model_path=args.model.resolve()
    try:
        server=ThreadingHTTPServer(('127.0.0.1',args.port),partial(Handler,directory=str(ROOT/'dist')))
    except OSError as error:
        parser.exit(1,f'Cannot open port {args.port}. Close the old server or use --port 8083. ({error})\n')
    print(f'Dashboard: http://localhost:{args.port}/',flush=True)
    try: server.serve_forever()
    except KeyboardInterrupt: pass
    finally: server.server_close()
