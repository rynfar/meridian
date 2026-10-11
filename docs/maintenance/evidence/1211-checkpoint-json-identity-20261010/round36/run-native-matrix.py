from pathlib import Path
import subprocess,json,hashlib,datetime,os,sys,uuid
root=Path(__file__).parent
label,kind,matrix=sys.argv[1:];assert label in ['baseline','changed'] and kind in ['source','installed'] and matrix in ['inputs','eof']
assert label!='baseline' or (kind=='source' and matrix=='inputs')
case=root/('native-'+label+'-'+kind+'-'+matrix);case.mkdir(exist_ok=False);out=case/'proof';out.mkdir();probe=root/'native-probe'
buildPath=root/'build/CHANGED_BUILD_IDENTITY.json' if label=='changed' else root.parent/'pr1211-complete-stream-stop-build-20261010-round23/CHANGED_BUILD_IDENTITY.json'
build=json.loads(buildPath.read_text());assert build['clean'] and build['originalDockerBuildJoined']
if label=='changed':assert build['head']=='ee3671ee8ee8f5b92321b5f559e7aa02fdc9accf'
else:assert build['head']=='34b49d82d9f69b1044ccca2d12a082eca05969ca'
image=build['imageId'];target=build['targets'][kind]
assert subprocess.check_output(['docker','image','inspect',image,'--format','{{.Id}}'],text=True).strip()==image
manifest=json.loads((root/'NATIVE_INPUTS.json').read_text())['inputs']
def identities():return [{'path':r['path'],'bytes':(probe/r['path']).stat().st_size,'sha256':hashlib.sha256((probe/r['path']).read_bytes()).hexdigest()} for r in manifest]
assert identities()==manifest
name='meridian1211-json-'+uuid.uuid4().hex[:12]
argv=['docker','create','--init','--platform','linux/amd64','--network=none','--read-only','--pids-limit','128','--memory','4g','--name',name,'--user',str(os.getuid())+':'+str(os.getgid()),'--tmpfs','/tmp:rw,mode=1777,size=256m','--mount','type=bind,src='+str(probe/'machine-id')+',dst=/etc/machine-id,readonly','--mount','type=bind,src='+str(probe)+',dst=/probe,readonly','--mount','type=bind,src='+str(out)+',dst=/proof',image,'bun','/probe/scripts/e2e-native-stop-eof.mjs','--source-root='+target['root'],'--target-kind='+kind,'--evidence-dir=/proof','--claude-executable='+target['native'],'--expected-cli-version='+target['nativeVersion'],'--expected-head='+build['head'],'--expected-core-sha256='+target['coreSha256'],'--expected-sdk-sha256='+target['sdkEntrySha256'],'--matrix='+matrix]
container=None;attach=None;code=None;deadline=False;stopped=False;removed=False;failure=None
(case/'STARTED.json').write_text(json.dumps({'driverPid':os.getpid(),'atUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'label':label,'target':kind,'matrix':matrix,'deadlineSeconds':360},indent=2)+'\n')
try:
 container=subprocess.check_output(argv,text=True).strip();assert len(container)==64
 with (case/'native.output.log').open('wb') as log:
  attach=subprocess.Popen(['docker','start','--attach',container],stdout=log,stderr=log)
  (case/'INVOCATION.json').write_text(json.dumps({'argv':argv,'containerId':container,'originalDriverPid':os.getpid(),'originalAttachPid':attach.pid,'imageId':image,'realCredentialsModels':False},indent=2)+'\n')
  try:code=attach.wait(timeout=360)
  except subprocess.TimeoutExpired:
   deadline=True;subprocess.run(['docker','stop','--time','3',container],check=True,capture_output=True);code=attach.wait(timeout=20)
except BaseException as error:failure=type(error).__name__
finally:
 if container:
  state=json.loads(subprocess.check_output(['docker','inspect',container],text=True))[0]['State']
  if state['Running']:
   subprocess.run(['docker','stop','--time','3',container],check=True,capture_output=True);state=json.loads(subprocess.check_output(['docker','inspect',container],text=True))[0]['State']
  stopped=not state['Running'] and state['Pid']==0
  if attach and attach.poll() is None:code=attach.wait(timeout=20)
  (case/'CONTAINER_TERMINAL.json').write_text(json.dumps({'id':container,'state':state},indent=2)+'\n')
  if stopped and (not attach or attach.poll() is not None):subprocess.run(['docker','rm',container],check=True,capture_output=True);removed=True
 unchanged=identities()==manifest;report=out/'INTEGRATED_HTTP.json';result=json.loads(report.read_text()) if report.is_file() else {}
 custody=not deadline and not failure and stopped and removed and unchanged and all(result.get('cleanup',{}).get(x) is True for x in ['admissionClosed','providerBodiesJoined','requestsSettled','backendClosed','listenerClosed','nativeActorCensusEmpty','privateRuntimeRemoved'])
 if label=='baseline':
  expected=code==1 and result.get('outcome')=='FAIL' and len(result.get('cases',[]))==4 and len(result.get('queryDiagnostics',[]))==9 and result.get('queryDiagnostics',[{}])[-1].get('case')=='input-above-node-boundary-stream-false' and result.get('failure','').startswith('proxy HTTP request failed') and '500 !== 200' in result.get('failure','')
 else:expected=code==0 and result.get('outcome')=='PASS' and len(result.get('cases',[]))==12 and len(result.get('queryDiagnostics',[]))==24
 qualified=bool(custody and expected)
 row={'label':label,'matrix':matrix,'target':kind,'qualified':qualified,'originalDriverPid':os.getpid(),'originalAttachPid':attach.pid if attach else None,'originalAttachJoined':attach is not None and attach.poll() is not None,'exit':code,'hostDeadlineExceeded':deadline,'ownedContainerStoppedPidZero':stopped,'ownedContainerRemoved':removed,'inputsUnchanged':unchanged,'probeOutcome':result.get('outcome'),'caseCount':len(result.get('cases',[])),'queryCount':len(result.get('queryDiagnostics',[])),'failureClass':failure,'realCredentialReads':0,'actualModelClientAcceptance':False,'priorLiveFailureCauseEstablished':False,'finishedUTC':datetime.datetime.now(datetime.timezone.utc).isoformat()}
 (case/'TERMINAL.json').write_text(json.dumps(row,indent=2)+'\n');print(json.dumps(row),flush=True)
sys.exit(0 if qualified else 2)
