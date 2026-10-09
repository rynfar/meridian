from pathlib import Path
import datetime,hashlib,json,os,subprocess,sys
p=Path(__file__).parent
image='sha256:f1db2086f5f9bec7a0ad7bc034288d18093d943ba444d7f8d47e12792b421eb5'
inputs=[]
for f in (p/'probe').iterdir():
 assert f.is_file() and not f.is_symlink()
 f.chmod(0o444)
 inputs.append({'path':f.name,'bytes':f.stat().st_size,'sha256':hashlib.sha256(f.read_bytes()).hexdigest(),'mode':'0444'})
(p/'probe').chmod(0o555)
argv=['docker','create','--init','--platform','linux/amd64','--network=none','--read-only','--pids-limit','128','--memory','4g','--name','meridian1211-empty-thinking-source-20261009-r3','--tmpfs','/tmp:rw,mode=1777,size=256m','--mount',f'type=bind,src={p}/output,dst=/proof','--mount',f'type=bind,src={p}/probe,dst=/probe,readonly',image,'bun','/probe/native-turn-counter.mjs','--source-root=/opt/e71/candidate','--options-root=/opt/e71/candidate','--evidence-dir=/proof','--claude-executable=/opt/e71/candidate/node_modules/@anthropic-ai/claude-code/bin/claude.exe','--expected-cli-version=2.1.284']
head=subprocess.check_output(['git','rev-parse','HEAD'],cwd='/Users/rynfar/repos/meridian-claude-sidecalls-stack-1292-20261008',text=True).strip()
(p/'INPUTS.json').write_text(json.dumps({'sourceHead':head,'image':image,'inputs':inputs,'realCredentialReads':0,'modelNetworkDisabled':True},indent=2)+'\n')
cid=subprocess.run(argv,capture_output=True,check=True,text=True).stdout.strip()
(p/'INVOCATION.json').write_text(json.dumps({'argv':argv,'containerId':cid,'originalDriverPid':os.getpid()},indent=2)+'\n')
code=1;overdue=False;joined=False;removed=False
try:
 with (p/'native.output.log').open('wb') as log:
  attach=subprocess.Popen(['docker','start','--attach',cid],stdout=log,stderr=log)
  (p/'STARTED.json').write_text(json.dumps({'originalDriverPid':os.getpid(),'originalAttachPid':attach.pid,'containerId':cid},indent=2)+'\n')
  try: code=attach.wait(timeout=400)
  except subprocess.TimeoutExpired:
   overdue=True
   state=json.loads(subprocess.run(['docker','inspect',cid],capture_output=True,check=True).stdout)[0]['State']
   if state['Running']: subprocess.run(['docker','kill','--signal','SIGKILL',cid],capture_output=True,check=True)
   code=attach.wait()
  joined=True
finally:
 info=json.loads(subprocess.run(['docker','inspect',cid],capture_output=True,check=True).stdout)[0]
 state=info['State']
 (p/'CONTAINER_TERMINAL.json').write_text(json.dumps({'state':state,'networkMode':info['HostConfig']['NetworkMode'],'readOnlyRoot':info['HostConfig']['ReadonlyRootfs'],'image':info['Image']},indent=2)+'\n')
 if not state['Running'] and state['Pid']==0:
  subprocess.run(['docker','rm',cid],capture_output=True,check=True);removed=True
 unchanged=True
 for row in inputs:
  f=p/'probe'/row['path'];unchanged=unchanged and f.stat().st_size==row['bytes'] and (f.stat().st_mode&0o777)==0o444 and hashlib.sha256(f.read_bytes()).hexdigest()==row['sha256']
 receipt={'atUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'originalDriverPid':os.getpid(),'originalAttachPid':attach.pid,'originalAttachJoined':joined,'attachExit':code,'hostDeadlineExceeded':overdue,'containerStoppedPidZero':not state['Running'] and state['Pid']==0,'ownedContainerRemoved':removed,'inputsUnchanged':unchanged,'realCredentialReads':0,'actualModelAcceptance':False}
 (p/'TERMINAL.json').write_text(json.dumps(receipt,indent=2)+'\n')
 print(json.dumps(receipt),flush=True)
sys.exit(0 if code==0 and joined and removed and unchanged and not overdue else 1)
