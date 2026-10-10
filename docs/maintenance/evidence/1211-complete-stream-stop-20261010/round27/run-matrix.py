from pathlib import Path
import subprocess,sys,json,datetime
root=Path(__file__).parent;target=sys.argv[1];assert target in ['source','installed'];rows=[]
for mode,stream,phase in [('chain','0','prepare')]+[(mode,stream,'live') for mode in ['chain','parallel'] for stream in ['0','1']]:
 p=subprocess.Popen(['python3',str(root/'run-e41-current.py'),'--phase',phase,'--mode',mode,'--stream',stream,'--target',target]);code=p.wait();rows.append({'originalPid':p.pid,'joined':True,'exit':code,'target':target,'mode':mode,'stream':stream,'phase':phase});print(json.dumps(rows[-1]),flush=True)
 if code:break
r={'target':target,'rows':rows,'qualified':len(rows)==5 and all(x['exit']==0 for x in rows),'finishedUTC':datetime.datetime.now(datetime.timezone.utc).isoformat()};(root/(target+'-MATRIX_TERMINAL.json')).write_text(json.dumps(r,indent=2)+'\n');sys.exit(0 if r['qualified'] else 2)
