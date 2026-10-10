from pathlib import Path
import subprocess,json,os,sys,time,datetime
root=Path(__file__).parent;base=root.parent;gate=root/'final-local-gates';head='ee3671ee8ee8f5b92321b5f559e7aa02fdc9accf'
started=json.loads((gate/'STARTED.json').read_text());assert started['head']==head;pid=started['pid'];deadline=time.monotonic()+1800
record={'originalPid':os.getpid(),'head':head,'gateDriverPid':pid,'startUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'status':'WAITING_FOR_CONFIRMED_LOCAL_GATE','stages':[],'realModelCallsBeforeGate':0,'wholeChangeAcceptance':'HELD'}
(root/'LIVE_SEQUENCE_STARTED.json').write_text(json.dumps(record,indent=2)+'\n');print(json.dumps({'status':record['status'],'pid':os.getpid(),'gatePid':pid}),flush=True)
try:
 while not (gate/'TERMINAL.json').exists():
  assert time.monotonic()<deadline,'Original gate observation deadline expired'
  command=subprocess.run(['ps','-p',str(pid),'-o','command='],capture_output=True,text=True).stdout
  assert str(root/'run-local-gates.py') in command,'Original gate driver no longer live without terminal receipt'
  time.sleep(2)
 gates=json.loads((gate/'TERMINAL.json').read_text());assert gates['qualified'] and gates['head']==head
 assert json.loads((root/'CHANGED_SEQUENCE_TERMINAL.json').read_text())['status']=='PASS_ALL_FOUR_CHANGED_MATRICES'
 image=json.loads((root/'build/CHANGED_BUILD_IDENTITY.json').read_text())['imageId']
 actual=base/'pr1211-json-identity-actual-client-20261010-round37';e41=base/'pr1211-json-identity-e41-20261010-round38'
 stages=[('actual-'+kind,[sys.executable,str(actual/'run-current.py'),'--phase','live','--case',kind,'--image',image],actual/(kind+'-live/TERMINAL.json')) for kind in ['source','installed']]
 stages += [('e41-'+kind,[sys.executable,str(e41/'run-matrix.py'),kind],e41/(kind+'-MATRIX_TERMINAL.json')) for kind in ['source','installed']]
 for num,case in [(39,'work-first'),(40,'caption-first'),(41,'sequential'),(42,'disabled')]:
  p=base/f'pr1211-json-identity-caption-{case}-20261010-round{num}'
  stages.append(('caption-'+case,[sys.executable,str(p/'run-current.py')],p/'TERMINAL.json'))
 record['status']='RUNNING_SELECTED_ACTUAL_FLOWS'
 for name,argv,terminal in stages:
  row={'name':name,'startUTC':datetime.datetime.now(datetime.timezone.utc).isoformat()};record['stages'].append(row)
  with (root/('live-controller-'+name+'.private.log')).open('xb') as log:
   os.chmod(log.name,0o600);child=subprocess.Popen(argv,stdout=log,stderr=log);row['originalPid']=child.pid
   (root/'LIVE_SEQUENCE_PROGRESS.json').write_text(json.dumps(record,indent=2)+'\n');print(json.dumps(row),flush=True)
   row['exit']=child.wait();row['originalJoined']=True
  result=json.loads(terminal.read_text()) if terminal.exists() else {};row['qualified']=result.get('qualified') is True;row['finishUTC']=datetime.datetime.now(datetime.timezone.utc).isoformat()
  (root/'LIVE_SEQUENCE_PROGRESS.json').write_text(json.dumps(record,indent=2)+'\n');print(json.dumps(row),flush=True)
  assert row['exit']==0 and row['qualified'],'Selected actual flow failed; subsequent admission stopped for original evidence inspection'
 record['status']='PASS_ALL_SELECTED_CURRENT_ACTUAL_FLOWS'
except Exception as error:record['status']='HELD';record['failureClass']=type(error).__name__;record['failure']=str(error)
finally:
 record['finishUTC']=datetime.datetime.now(datetime.timezone.utc).isoformat();(root/'LIVE_SEQUENCE_TERMINAL.json').write_text(json.dumps(record,indent=2)+'\n');print(json.dumps(record),flush=True)
sys.exit(0 if record['status']=='PASS_ALL_SELECTED_CURRENT_ACTUAL_FLOWS' else 2)
