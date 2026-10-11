from pathlib import Path
import argparse,datetime,hashlib,json,os,subprocess,sys,time

parser=argparse.ArgumentParser()
parser.add_argument('--phase',choices=['rehearsal','live'],required=True)
parser.add_argument('--case',choices=['source','installed'],required=True)
parser.add_argument('--image',required=True)
a=parser.parse_args();root=Path(__file__).parent;out=root/(a.case+'-'+a.phase)
assert a.image.startswith('sha256:') and len(a.image)==71
image=json.loads(subprocess.check_output(['docker','image','inspect',a.image]))[0]
assert image['Id']==a.image and image['Architecture']=='amd64'
w=Path('/Users/rynfar/repos/meridian-claude-sidecalls-stack-1292-20261008')
head='6d773781ac03359df22f1226807becd95b28005b'
checkoutHead='51cefe3c3a7874d168dd8c1e361f9cdedd982a05'
assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=w,text=True).strip()==checkoutHead
assert not subprocess.check_output(['git','status','--porcelain'],cwd=w,text=True).strip()
assert subprocess.check_output(['git','diff','--name-only',head,checkoutHead],cwd=w,text=True).splitlines()==['scripts/e2e-claude-code-subagent-session.mjs', 'scripts/lib/e2eMixedAuto.mjs', 'src/__tests__/e72-handback-encoding.test.ts', 'src/__tests__/e72-mixed-auto.test.ts', 'src/__tests__/e72-native-handback-frame.test.ts', 'src/__tests__/fixtures/e72-mixed-control/client.mjs', 'src/__tests__/fixtures/e72-native-handback-frame.txt']
for r in json.loads((root/'OBSERVER_IDENTITY.json').read_text())['inputs']:
 f=root/'observer'/r['path'];assert f.is_file() and not f.is_symlink() and f.stat().st_size==r['bytes'] and (f.stat().st_mode&0o777)==0o444 and hashlib.sha256(f.read_bytes()).hexdigest()==r['sha256']
if a.phase=='live':
 for case in ['source','installed']:
  r=json.loads((root/(case+'-rehearsal')/'TERMINAL.json').read_text());assert r['qualified'] and r['modelCalls']==0
 if a.case=='installed':
  r=json.loads((root/'source-live/TERMINAL.json').read_text());assert r['qualified'], 'Source failure cannot admit installed flow'
out.mkdir(mode=0o700,exist_ok=False);proof=out/'proof';proof.mkdir(mode=0o700)
private=out/'.private';private.mkdir(mode=0o700);grant=private/'owned-access.json'
source=None;sourceHash=None
def read_authorized_source():
 p=json.loads((root.parent/'pr1211-e41-sonnet-native-20261009-round1/PRIVATE_SOURCE_READ_QUALIFICATION.json').read_text())
 r=subprocess.run(['security','find-generic-password','-s',p['sourceService'],'-a',p['sourceAccount'],'-w'],capture_output=True,timeout=15)
 if r.returncode:raise RuntimeError('Authorized source read unavailable')
 return r.stdout.strip()
if a.phase=='live':
 source=read_authorized_source();sourceHash=hashlib.sha256(source).hexdigest();g=json.loads(source)['claudeAiOauth']
 assert 'user:inference' in g['scopes'] and int(g['expiresAt'])-time.time()*1000>660000
 access={k:g[k] for k in ['accessToken','expiresAt','scopes','subscriptionType','rateLimitTier','seatTier'] if k in g}
 del source,g
else:access={'accessToken':'synthetic-zero-query-rehearsal','expiresAt':int((time.time()+3600)*1000),'scopes':['user:inference']}
grant.write_text(json.dumps({'claudeAiOauth':access}));grant.chmod(0o400);del access
s=grant.stat();assert s.st_uid==os.getuid() and s.st_nlink==1 and (s.st_mode&0o777)==0o400
grantHash=hashlib.sha256(grant.read_bytes()).hexdigest();grantInode=s.st_ino
machine=out/'machine-id';machine.write_text(hashlib.sha256((head+a.case+a.phase).encode()).hexdigest()[:32]+'\n');machine.chmod(0o444)
installed=a.case=='installed';target='/opt/e71/current-installed/node_modules/@rynfar/meridian' if installed else '/opt/e71/current'
native='/opt/e71/current-installed/node_modules/@anthropic-ai/claude-code/bin/claude.exe' if installed else '/opt/e71/current/node_modules/@anthropic-ai/claude-code/bin/claude.exe'
argv=['docker','create','--init','--platform','linux/amd64','--read-only','--tmpfs','/tmp:rw,nosuid,nodev,size=1g,mode=1777','--env','TMPDIR=/tmp','--name','meridian1211-r10-'+a.case+'-'+a.phase,'--pids-limit','256','--memory','4g','--mount','type=bind,source='+str(proof)+',target=/proof','--mount','type=bind,source='+str(grant)+',target=/owned-access.json,readonly','--mount','type=bind,source='+str(root/'observer')+',target=/probe,readonly','--mount','type=bind,source='+str(machine)+',target=/etc/machine-id,readonly']
if a.phase=='rehearsal':argv+=['--network','none']
argv += [a.image,'bun','/probe/scripts/e2e-claude-code-subagent-session.mjs','--target-root',target,'--entry','dist/server.js','--client','/opt/e71/client287/node_modules/@anthropic-ai/claude-code/bin/claude.exe','--client-version','2.1.287','--native-cli',native,'--native-cli-version','2.1.296' if installed else '2.1.284','--sdk-version','0.2.141','--model','claude-sonnet-5-5','--served-model','claude-sonnet-5-5','--grant-file','/owned-access.json','--proof-dir','/proof/results','--max-queries','24','--max-cost-usd','12','--timeout-ms','600000','--require-mcp-readiness','--scenario','mixed-auto-handback-v3','--classifier-model','claude-sonnet-5','--classifier-served-model','claude-sonnet-5','--checkpoint-protocol','owned-interrupt-v1']
if not installed:argv+=['--source-head',head]
if a.phase=='rehearsal':argv+=['--rehearsal']
cid=None;actor=None;joined=False;removed=False;overdue=False;code=None;sourceUnchanged=None;grantUnchanged=False;qualified=False;failure=None
try:
 cid=subprocess.check_output(argv,text=True).strip();(out/'INVOCATION.json').write_text(json.dumps({'argv':argv,'containerId':cid,'imageId':a.image,'originalDriverPid':os.getpid(),'phase':a.phase,'runtimeSourceHead':head,'observerContentHead':checkoutHead,'realCredentialSnapshot':a.phase=='live','refreshAuthority':False,'sourceWrites':0},indent=2)+'\n')
 with (out/'native.output.log').open('wb') as log:
  actor=subprocess.Popen(['docker','start','--attach',cid],stdout=log,stderr=log);(out/'STARTED.json').write_text(json.dumps({'originalAttachPid':actor.pid,'containerId':cid,'startUTC':datetime.datetime.now(datetime.timezone.utc).isoformat()},indent=2)+'\n')
  try:code=actor.wait(timeout=700)
  except subprocess.TimeoutExpired:
   overdue=True;state=json.loads(subprocess.check_output(['docker','inspect',cid]))[0]['State']
   if state['Running']:subprocess.run(['docker','kill','--signal','SIGKILL',cid],check=True,capture_output=True)
   code=actor.wait()
  joined=True
 r=json.loads((proof/'results/claude-subagent-results.json').read_text())
 custody=r['ownerGrantUnchanged'] and r['runtimeGrantUnchanged'] and r['targetIdentityUnchanged'] and r['privateRuntimeRemoved'] and r['relayOperationsJoined'] and r['loggerContextDescriptorRestored'] and r['ownedResidualProcesses']==0 and not r['cleanupFailures'] and all(x['join']=='JOINED' and not x['signalFailures'] for x in r['clientProcesses'])
 expected=r['result']==('REHEARSAL' if a.phase=='rehearsal' else 'PASS')
 if a.phase=='rehearsal':qualified=custody and expected and not r['queries'] and not r['acceptance']
 else:
  stops=[q for q in r['queries'] if q['ownedCheckpoint']['requested']]
  qualified=custody and expected and r['acceptance'] and r['readinessStatus']==200 and all(r['checks'].values()) and r['checkpointProtocol']=='owned-interrupt-v1' and all(q['ownedCheckpoint']['qualified'] for q in stops) and len(r['turns'])==2 and len(r['queries'])<=24 and sum(q.get('estimatedCostUsd') or 0 for q in r['queries'])<=12
 (out/'AUDIT.json').write_text(json.dumps({'phase':a.phase,'result':r['result'],'qualifiedBeforeOuterCustody':qualified,'harnessCustody':custody,'queries':len(r['queries']),'actualClients':len(r['turns']),'checks':r['checks'],'failure':r.get('failure'),'identity':r['identity'],'reportSHA256':hashlib.sha256((proof/'results/claude-subagent-results.json').read_bytes()).hexdigest()},indent=2)+'\n')
except Exception as error:
 failure=type(error).__name__;qualified=False
finally:
 if cid:
  info=json.loads(subprocess.check_output(['docker','inspect',cid]))[0];state=info['State'];(out/'CONTAINER_TERMINAL.json').write_text(json.dumps({'state':state,'image':info['Image'],'readOnlyRoot':info['HostConfig']['ReadonlyRootfs'],'network':info['HostConfig']['NetworkMode']},indent=2)+'\n')
  if not state['Running'] and state['Pid']==0:subprocess.run(['docker','rm',cid],check=True,capture_output=True);removed=True
 if a.phase=='live':sourceUnchanged=hashlib.sha256(read_authorized_source()).hexdigest()==sourceHash
 stat=grant.stat();grantUnchanged=stat.st_ino==grantInode and stat.st_nlink==1 and stat.st_uid==os.getuid() and (stat.st_mode&0o777)==0o400 and hashlib.sha256(grant.read_bytes()).hexdigest()==grantHash
 if (cid is None or removed) and (actor is None or joined):grant.unlink();private.rmdir()
 qualified=bool(qualified and joined and removed and code==0 and not overdue and grantUnchanged and (a.phase=='rehearsal' or sourceUnchanged))
 receipt={'phase':a.phase,'case':a.case,'qualified':qualified,'originalDriverPid':os.getpid(),'originalAttachPid':actor.pid if actor else None,'originalAttachJoined':joined,'exit':code,'hostDeadlineExceeded':overdue,'ownedContainerStoppedAndRemoved':removed,'sourceGrantUnchanged':sourceUnchanged,'taskGrantUnchanged':grantUnchanged,'taskAccessOnlyGrantRemoved':not private.exists(),'modelCalls':0 if a.phase=='rehearsal' else 'see exact SDK receipts','sourceWrites':0,'failureClass':failure,'finishedUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'wholeChangeAcceptance':'HELD'}
 (out/'TERMINAL.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt),flush=True)
sys.exit(0 if qualified else 2)
