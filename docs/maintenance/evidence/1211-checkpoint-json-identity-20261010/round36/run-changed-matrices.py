from pathlib import Path
import subprocess,json,datetime,os,sys
root=Path(__file__).parent
receipt={'pid':os.getpid(),'startUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'cases':[],'status':'RUNNING','realCredentialReads':0,'wholeChangeAcceptance':'HELD'}
(root/'CHANGED_SEQUENCE_STARTED.json').write_text(json.dumps(receipt,indent=2)+'\n')
try:
 for kind,matrix in [('source','inputs'),('installed','inputs'),('source','eof'),('installed','eof')]:
  row={'target':kind,'matrix':matrix,'startUTC':datetime.datetime.now(datetime.timezone.utc).isoformat()};receipt['cases'].append(row)
  with (root/('controller-'+kind+'-'+matrix+'.log')).open('xb') as log:
   child=subprocess.Popen([sys.executable,str(root/'run-native-matrix.py'),'changed',kind,matrix],stdout=log,stderr=log);row['originalPid']=child.pid
   (root/'CHANGED_SEQUENCE_PROGRESS.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(row),flush=True)
   row['exit']=child.wait();row['originalJoined']=True
  result=json.loads((root/('native-changed-'+kind+'-'+matrix)/'TERMINAL.json').read_text());row['qualified']=result['qualified'];row['finishUTC']=datetime.datetime.now(datetime.timezone.utc).isoformat()
  (root/'CHANGED_SEQUENCE_PROGRESS.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(row),flush=True)
  assert row['exit']==0 and row['qualified'],'Selected matrix failed; subsequent admission stopped for original evidence inspection'
 receipt['status']='PASS_ALL_FOUR_CHANGED_MATRICES'
except Exception as error:receipt['status']='HELD';receipt['failureClass']=type(error).__name__;receipt['failure']=str(error)
finally:
 receipt['finishUTC']=datetime.datetime.now(datetime.timezone.utc).isoformat();(root/'CHANGED_SEQUENCE_TERMINAL.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt),flush=True)
sys.exit(0 if receipt['status']=='PASS_ALL_FOUR_CHANGED_MATRICES' else 2)
