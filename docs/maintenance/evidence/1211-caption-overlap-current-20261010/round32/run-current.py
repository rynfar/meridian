from pathlib import Path
import datetime,hashlib,json,os,subprocess,time,sys

root=Path(__file__).parent
w=Path('/Users/rynfar/repos/meridian-claude-sidecalls-stack-1292-20261008')
head='537c4c8740c23d58d3835884d00b1143e5ac7366'
def git(*args):return subprocess.check_output(['git',*args],cwd=w)
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
assert git('rev-parse','--show-object-format').decode().strip()=='sha1'
assert git('rev-parse','HEAD').decode().strip()==head
assert not git('status','--porcelain').strip()
assert not git('diff','--name-only','34b49d82','HEAD','--','src/proxy','package.json','bun.lock','plugin').strip()
gates=json.loads((root.parent/'pr1211-caption-overlap-lineage-correction-20261010-round30/final-local-gates/TERMINAL.json').read_text())
assert gates['qualified'] and gates['head']==head
old=json.loads((root.parent/'pr1292-current-native-live-20261008/fixed-sequential-hints1-owned-observers-r3/report.json').read_text())['provenance']
roles={r['role']:r for r in old['inputs'] if r['role']!='product-source-input'}
for key in ['sdk','native','node','bun','hono-entry']:
 assert Path(roles[key]['path']).is_file() and sha(Path(roles[key]['path']))==roles[key]['sha256']
inputs=[]
for role,r in roles.items():
 p=Path(r['path']);assert p.is_file() and not p.is_symlink() and p.resolve()==p
 inputs.append({'role':role,'path':str(p),'sha256':sha(p)})
tracked=[]
for line in git('ls-tree','-rz','HEAD').split(b'\0'):
 if not line:continue
 meta,name=line.split(b'\t',1);mode,kind,oid=meta.decode().split();name=name.decode();p=w/name
 assert kind=='blob' and p.is_file() and not p.is_symlink()
 data=p.read_bytes();assert hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()==oid
 assert bool(p.stat().st_mode&0o111)==(mode=='100755')
 tracked.append({'path':name,'gitBlob':oid,'gitMode':mode,'bytes':len(data),'sha256':sha(p)})
 if name.startswith(('src/','scripts/')) or name in ['package.json','bun.lock','tsconfig.json']:
  inputs.append({'role':'product-source-input','path':str(p),'sha256':sha(p)})
assert len(inputs)<2000
provenance={'schema':1,'kind':'source','codeCommit':head,'codeTree':git('rev-parse','HEAD^{tree}').decode().strip(),'tuple':old['tuple'],'inputs':inputs}
prov=root/'source-provenance.json';prov.write_text(json.dumps(provenance,indent=2)+'\n')
(root/'TRACKED_SOURCE_IDENTITY.json').write_text(json.dumps({'head':head,'rows':tracked,'scope':'all tracked Git blobs and executable modes; SDK/Hono/native/Bun/Node separately pinned, not full dependency or OS closure'},indent=2)+'\n')
task=root/'task';task.mkdir(mode=0o700);grants=task/'grants';grants.mkdir(mode=0o700);grant=grants/'access-token'
sourcePlan=json.loads((root.parent/'pr1211-e41-sonnet-native-20261009-round1/PRIVATE_SOURCE_READ_QUALIFICATION.json').read_text())
def source_read():
 r=subprocess.run(['security','find-generic-password','-s',sourcePlan['sourceService'],'-a',sourcePlan['sourceAccount'],'-w'],capture_output=True,timeout=15)
 if r.returncode:raise RuntimeError('Authorized source read unavailable')
 return r.stdout.strip()
source=source_read();sourceHash=hashlib.sha256(source).hexdigest();oauth=json.loads(source)['claudeAiOauth']
assert 'user:inference' in oauth['scopes'] and int(oauth['expiresAt'])-time.time()*1000>660000
with grant.open('x') as f:os.chmod(grant,0o600);f.write(oauth['accessToken'])
del source,oauth
grantHash=sha(grant);grantStat=grant.stat()
output=task/'caption-first-hints1'
argv=[roles['bun']['path'],str(w/'scripts/e2e-claude-code-progress-captions/caption-native-gate.mjs'),'--live-authorized','--case','caption-first','--expect','fixed','--hints','1','--model','claude-opus-5-5','--backend-sdk-model','opus[1m]','--backend-model','claude-opus-5-5[1m]']
for name in ['entry','adapter-entry','gate-entry','state-entry','tree-entry','sdk','native','node']:argv+=['--'+name,roles[name]['path']]
argv+=['--task-root',str(task),'--output',str(output),'--token-file',str(grant),'--provenance',str(prov),'--deadline-ms','300000','--join-ms','15000','--hold-ms','40000']
receipt={'sourceHead':head,'case':'caption-first','hints':1,'argv':argv,'sourceWrites':0,'sourceLoginRefreshWrites':False,'originalDriverPid':os.getpid(),'startUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'outerJoined':False,'acceptance':'INCOMPLETE'}
(root/'INVOCATION.json').write_text(json.dumps(receipt,indent=2)+'\n')
code=None;child=None;qualified=False;failure=None;joined=False;report=None;settlement=None
try:
 with (root/'parent.output.private.log').open('xb') as log:
  os.chmod(root/'parent.output.private.log',0o600)
  child=subprocess.Popen(argv,cwd=w,stdout=log,stderr=log);receipt['originalParentPid']=child.pid
  (root/'STARTED.json').write_text(json.dumps({'driverPid':os.getpid(),'parentPid':child.pid,'startUTC':receipt['startUTC']},indent=2)+'\n')
  print(json.dumps({'status':'RUNNING','driverPid':os.getpid(),'parentPid':child.pid,'case':'caption-first'}),flush=True)
  code=child.wait();joined=True;log.flush();os.fsync(log.fileno())
 report=json.loads((output/'report.json').read_text());settlement=json.loads((output/'parent-settlement.json').read_text())
 qualified=code==0 and report['status']=='PASS' and report['cases']['caption-first']['status']=='PASS' and report['cleanup']['scopedOwnedJoin']=='JOINED' and report['cleanup']['grantCleanupAllowed'] and settlement['parentJoin']=='JOINED' and settlement['grantCleanupAllowed'] and settlement['code']==0
except Exception as e:failure=type(e).__name__
finally:
 sourceUnchanged=hashlib.sha256(source_read()).hexdigest()==sourceHash
 s=grant.stat();grantUnchanged=sha(grant)==grantHash and s.st_ino==grantStat.st_ino and s.st_size==grantStat.st_size and s.st_mode==grantStat.st_mode
 inputUnchanged=all(sha(Path(r['path']))==r['sha256'] for r in inputs) and all(sha(w/r['path'])==r['sha256'] and bool((w/r['path']).stat().st_mode&0o111)==(r['gitMode']=='100755') for r in tracked)
 removed=False
 if joined and settlement and settlement.get('parentJoin')=='JOINED' and settlement.get('grantCleanupAllowed') and grantUnchanged:
  grant.unlink();grants.rmdir();removed=True
 qualified=bool(qualified and sourceUnchanged and grantUnchanged and inputUnchanged and removed and git('rev-parse','HEAD').decode().strip()==head and not git('status','--porcelain').strip())
 receipt.update({'outerJoined':joined,'exit':code,'failureClass':failure,'qualified':qualified,'acceptance':'PASS_SCOPED_CAPTION_FIRST' if qualified else 'HELD','reportStatus':report.get('status') if report else None,'firstFailure':report.get('firstFailure') if report else None,'sourceGrantUnchanged':sourceUnchanged,'taskGrantUnchanged':grantUnchanged,'taskAccessOnlyGrantRemoved':removed,'allInputsUnchanged':inputUnchanged,'globalDescendantAbsence':'UNKNOWN','wholeChangeAcceptance':'HELD','endUTC':datetime.datetime.now(datetime.timezone.utc).isoformat()})
 (root/'TERMINAL.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps({k:v for k,v in receipt.items() if k!='argv'}),flush=True)
sys.exit(0 if qualified else 2)
