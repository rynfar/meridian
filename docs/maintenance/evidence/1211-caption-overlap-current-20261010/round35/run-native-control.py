import pathlib,subprocess,json,hashlib,datetime,os,sys,uuid
root=pathlib.Path(__file__).parent
kind='source'; mode=sys.argv[1];assert mode in ['owned','legacy']
case=root/mode;case.mkdir(exist_ok=False);out=case/'proof';out.mkdir();probe=root/'probe'
build=json.loads((root.parent/'pr1211-complete-stream-stop-build-20261010-round23/CHANGED_BUILD_IDENTITY.json').read_text())
assert build['head']=='34b49d82d9f69b1044ccca2d12a082eca05969ca' and build['clean'] and build['originalDockerBuildJoined']
image=build['imageId'];targetIdentity=build['targets'][kind]
actual=subprocess.check_output(['docker','image','inspect',image,'--format','{{.Id}}'],text=True).strip();assert actual==image
manifest=json.loads((root/'INPUTS.json').read_text())
def identities():
 return [{'path':r['path'],'bytes':(probe/r['path']).stat().st_size,'sha256':hashlib.sha256((probe/r['path']).read_bytes()).hexdigest()} for r in manifest['inputs']]
assert identities()==manifest['inputs']
target=targetIdentity['root']
cli=targetIdentity['native']
version='2.1.284' if kind=='source' else '2.1.296'
name='meridian1211-eof-control-'+uuid.uuid4().hex[:12]
argv=['docker','create','--init','--platform','linux/amd64','--network=none','--read-only','--pids-limit','128','--memory','4g','--name',name,'--user',str(os.getuid())+':'+str(os.getgid()),'--tmpfs','/tmp:rw,mode=1777,size=256m','--mount','type=bind,src='+str(probe/'machine-id')+',dst=/etc/machine-id,readonly','--mount','type=bind,src='+str(probe)+',dst=/probe,readonly','--mount','type=bind,src='+str(out)+',dst=/proof',image,'bun','/probe/scripts/e2e-native-stop-eof.mjs','--source-root='+target,'--target-kind='+kind,'--evidence-dir=/proof','--claude-executable='+cli,'--expected-cli-version='+version,'--expected-head='+build['head'],'--expected-core-sha256='+targetIdentity['coreSha256'],'--expected-sdk-sha256='+targetIdentity['sdkEntrySha256'],'--guard-mode='+mode]
container=None;attach=None;code=None;deadline=False;stopped=False;removed=False;failure=None
(case/'STARTED.json').write_text(json.dumps({'driverPid':os.getpid(),'atUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'target':kind,'deadlineSeconds':300},indent=2)+'\n')
try:
 container=subprocess.check_output(argv,text=True).strip();assert len(container)==64
 with (case/'native.output.log').open('wb') as log:
  attach=subprocess.Popen(['docker','start','--attach',container],stdout=log,stderr=log)
  (case/'INVOCATION.json').write_text(json.dumps({'argv':argv,'containerId':container,'originalDriverPid':os.getpid(),'originalAttachPid':attach.pid,'imageId':actual,'realCredentialsModels':False},indent=2)+'\n')
  try:code=attach.wait(timeout=300)
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
 unchanged=identities()==manifest['inputs'];report=out/'INTEGRATED_HTTP.json';result=json.loads(report.read_text()) if report.is_file() else {}
 custody= not deadline and not failure and stopped and removed and unchanged  and all(result.get('cleanup',{}).get(x) is True for x in ['admissionClosed','providerBodiesJoined','requestsSettled','backendClosed','listenerClosed','nativeActorCensusEmpty','privateRuntimeRemoved'])
 expected=(mode=='legacy' and code==0 and result.get('outcome')=='PASS' and len(result.get('cases',[]))==1) or (mode=='owned' and code==1 and result.get('outcome')=='FAIL' and len(result.get('cases',[]))==2 and result.get('failure')=='proxy HTTP request failed')
 qualified=bool(custody and expected)
 row={'controlMode':mode,'controlQualified':qualified,'productAcceptance':'HELD','originalDriverPid':os.getpid(),'originalAttachPid':attach.pid if attach else None,'originalAttachJoined':attach is not None and attach.poll() is not None,'exit':code,'hostDeadlineExceeded':deadline,'ownedContainerStoppedPidZero':stopped,'ownedContainerRemoved':removed,'inputsUnchanged':unchanged,'probeOutcome':result.get('outcome'),'qualified':qualified,'failureClass':failure,'realCredentialReads':0,'actualModelClientAcceptance':False,'priorLiveFailureCauseEstablished':False,'finishedUTC':datetime.datetime.now(datetime.timezone.utc).isoformat()}
 (case/'TERMINAL.json').write_text(json.dumps(row,indent=2)+'\n');print(json.dumps(row),flush=True)
sys.exit(0 if qualified else 2)
