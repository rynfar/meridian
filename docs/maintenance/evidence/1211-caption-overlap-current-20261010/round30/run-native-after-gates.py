from pathlib import Path
import datetime,json,os,subprocess,time,sys

root=Path(__file__).parent
head='537c4c8740c23d58d3835884d00b1143e5ac7366'
gateRoot=root/'final-local-gates'
started=json.loads((gateRoot/'STARTED.json').read_text())
assert started['head']==head
driver=started['pid']
gateCommand=str(root/'run-local-gates.py')
deadline=time.monotonic()+1500
receipt={'originalPid':os.getpid(),'sourceHead':head,'gateDriverPid':driver,'status':'WAITING_FOR_CONFIRMED_LOCAL_DRIVER','modelCallsBeforeGate':0,'cases':[],'startUTC':datetime.datetime.now(datetime.timezone.utc).isoformat()}
(root/'NATIVE_SEQUENCE_STARTED.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps({'status':receipt['status'],'pid':os.getpid(),'gateDriverPid':driver}),flush=True)
failure=None
try:
 while not (gateRoot/'TERMINAL.json').exists():
  assert time.monotonic()<deadline,'Bounded local gate observation expired'
  command=subprocess.run(['ps','-p',str(driver),'-o','command='],capture_output=True,text=True).stdout
  assert gateCommand in command,'Original local driver no longer live without terminal receipt'
  time.sleep(2)
 gates=json.loads((gateRoot/'TERMINAL.json').read_text())
 assert gates['qualified'] and gates['head']==head and all(r['joined'] and r['exit']==0 for r in gates['checks'])
 for num,case in [(31,'work-first'),(32,'caption-first'),(33,'sequential'),(34,'disabled')]:
  caseRoot=root.parent/f'pr1211-caption-{case}-qualified-20261010-round{num}'
  with (caseRoot/'controller.output.log').open('xb') as log:
   child=subprocess.Popen([sys.executable,str(caseRoot/'run-current.py')],stdout=log,stderr=log)
   row={'case':case,'originalDriverPid':child.pid,'startUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'joined':False}
   receipt['cases'].append(row)
   (root/'NATIVE_SEQUENCE_PROGRESS.json').write_text(json.dumps(receipt,indent=2)+'\n')
   print(json.dumps({'status':'LIVE_CASE_STARTED','case':case,'originalDriverPid':child.pid}),flush=True)
   row['exit']=child.wait();row['joined']=True;log.flush();os.fsync(log.fileno())
  terminal=json.loads((caseRoot/'TERMINAL.json').read_text());row['qualified']=terminal['qualified'];row['finishUTC']=datetime.datetime.now(datetime.timezone.utc).isoformat()
  (root/'NATIVE_SEQUENCE_PROGRESS.json').write_text(json.dumps(receipt,indent=2)+'\n')
  print(json.dumps(row),flush=True)
  assert row['exit']==0 and row['qualified'],'A failed selected arm stops subsequent admission; inspect original evidence'
 receipt['status']='PASS_SELECTED_SOURCE_ARMS'
except Exception as error:
 failure=type(error).__name__;receipt['status']='HELD'
finally:
 receipt['failureClass']=failure;receipt['finishUTC']=datetime.datetime.now(datetime.timezone.utc).isoformat();receipt['wholeChangeAcceptance']='HELD'
 (root/'NATIVE_SEQUENCE_TERMINAL.json').write_text(json.dumps(receipt,indent=2)+'\n')
 print(json.dumps({'status':receipt['status'],'failureClass':failure,'cases':receipt['cases']}),flush=True)
sys.exit(0 if receipt['status']=='PASS_SELECTED_SOURCE_ARMS' else 2)
