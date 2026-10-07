"""End-to-end exported CSV -> trainer -> local model API, using synthetic data."""
import csv
import io
import json
import subprocess
import sys
import tempfile
import threading
import urllib.error
import urllib.request
from functools import partial
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT));sys.path.insert(0,str(ROOT.parent/'motion_training'))
sys.path.insert(0,str(ROOT.parent/'motion_training'/'.deps'))
import serve
from features import load_windows

def main():
    with tempfile.TemporaryDirectory(prefix='capture-test-',dir=ROOT) as temporary:
        folder=Path(temporary);serve.model_path=folder/'models'/'motion_model.joblib'
        server=serve.ThreadingHTTPServer(('127.0.0.1',0),partial(serve.Handler,directory=str(ROOT/'dist')))
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        base=f'http://127.0.0.1:{server.server_port}'
        def request(path,data=None,origin=None):
            headers={'Content-Type':'application/json'}
            if origin:headers['Origin']=origin
            payload=json.dumps(data).encode() if data is not None else None
            try:
                with urllib.request.urlopen(urllib.request.Request(base+path,data=payload,headers=headers),timeout=30) as response:return response.status,json.load(response)
            except urllib.error.HTTPError as error:return error.code,json.load(error)
        try:
            assert request('/api/model')[1]['loaded'] is False
            assert request('/api/predict',{'samples':[]})[0]==409
            script="""
import {Recorder,trainingCsv} from './dist/training.js';
const r=new Recorder();
for(const label of ['IDLE','RUNNING'])for(let s=0;s<2;s++){
 r.start(label,'p01',label+'_'+s);
 for(let i=0;i<150;i++)r.add({seq:i,timestamp:i*20,mpuOK:true,ax:0,ay:0,az:label==='IDLE'?9.81:14+Math.sin(i*.3),gx:0,gy:0,gz:0});
 r.stop();
}
process.stdout.write(trainingCsv(r.rows));
"""
            raw=subprocess.check_output(['node','--input-type=module','-e',script],cwd=ROOT)
            exported=folder/'exported.csv';exported.write_bytes(raw)
            windows,_=load_windows([exported]);assert len(windows)==12
            env=__import__('os').environ.copy();env['PYTHONPATH']=str(ROOT.parent/'motion_training'/'.deps');env['PYTHONUTF8']='1'
            subprocess.run([sys.executable,str(ROOT.parent/'motion_training'/'train.py'),'--input',str(exported),'--output',str(folder/'models'),'--test-size','0.5'],env=env,check=True)
            assert request('/api/model')[1]['loaded'] is True
            samples=[[i*20,14] for i in range(150)]
            status,prediction=request('/api/predict',{'samples':samples});assert status==200,prediction
            assert prediction['prediction'] in ['RUNNING','UNKNOWN']
            samples[50][0]=samples[49][0]
            assert request('/api/predict',{'samples':samples})[0]==400
            assert request('/api/predict',{'samples':[]},'http://example.com')[0]==403
        finally:server.shutdown();server.server_close();thread.join()
    print('PASS: dashboard CSV -> training -> model loading -> live prediction API')

if __name__=='__main__':main()
