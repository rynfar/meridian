from pathlib import Path
import argparse,subprocess,json,hashlib,datetime,os
parser=argparse.ArgumentParser();parser.add_argument('--control',choices=['client-handback-control-auto','client-handback-control-bash','client-handback-control-actor','client-handback-control-foreground'],required=True);a=parser.parse_args()
p=Path(__file__).parent/a.control;out=p/'run';out.mkdir(exist_ok=False);proof=out/'proof';proof.mkdir();image='sha256:98bcf4655603115bf8808376120003aeb385c2dc144bcadd60958c898fa740f0';f=p/'probe.mjs';before=hashlib.sha256(f.read_bytes()).hexdigest();assert before==json.loads((p/'PROBE_IDENTITY.json').read_text())['sha256']
argv=['docker','create','--init','--network','none','--platform','linux/amd64','--read-only','--tmpfs','/tmp:rw,nosuid,nodev,size=512m,mode=1777','--name','meridian1211-r9-direct-'+a.control,'--pids-limit','128','--memory','2g','--mount','type=bind,source='+str(p)+',target=/probe,readonly','--mount','type=bind,source='+str(proof)+',target=/proof',image,'node','/probe/probe.mjs']
cid=subprocess.check_output(argv,text=True).strip();(out/'INVOCATION.json').write_text(json.dumps({'argv':argv,'containerId':cid,'image':image,'pid':os.getpid(),'realGrants':0,'actualModelCalls':0},indent=2)+'\n')
joined=False;overdue=False;actor=None;code=None
try:
 with (out/'public.output.log').open('wb') as log:
  actor=subprocess.Popen(['docker','start','--attach',cid],stdout=log,stderr=log);(out/'STARTED.json').write_text(json.dumps({'originalAttachPid':actor.pid,'startUTC':datetime.datetime.now(datetime.timezone.utc).isoformat()},indent=2)+'\n')
  try:code=actor.wait(timeout=120)
  except subprocess.TimeoutExpired:
   overdue=True;subprocess.run(['docker','kill','--signal','SIGKILL',cid],capture_output=True,check=True);code=actor.wait()
  joined=True
finally:
 state=json.loads(subprocess.check_output(['docker','inspect',cid]))[0]['State'];removed=False
 if not state['Running'] and state['Pid']==0:subprocess.run(['docker','rm',cid],capture_output=True,check=True);removed=True
 r={'originalAttachJoined':joined,'exit':code,'hostDeadlineExceeded':overdue,'containerState':state,'ownedContainerRemoved':removed,'probeUnchanged':hashlib.sha256(f.read_bytes()).hexdigest()==before,'wholeChangeAcceptance':'HELD','finishedUTC':datetime.datetime.now(datetime.timezone.utc).isoformat()};(out/'TERMINAL.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r),flush=True)
