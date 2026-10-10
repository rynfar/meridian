import pathlib,json,hashlib,subprocess,datetime
w=pathlib.Path('/Users/rynfar/repos/meridian-claude-sidecalls-stack-1292-20261008');o=pathlib.Path('/Users/rynfar/repos/meridian');p=pathlib.Path(__file__).parent
baseline=json.load(open('/Users/rynfar/repos/meridian-review-evidence-20261006/pr1292-current-source-reconciliation-20261008-round1/OWNER_BEFORE.json'))
def git(root,*args):return subprocess.run(['git',*args],cwd=root,capture_output=True,check=True).stdout
assert git(o,'rev-parse','HEAD').decode().strip()==baseline['head'] and git(o,'status','--short').decode().rstrip('\n')==baseline['status'].rstrip('\n')
ip=pathlib.Path(git(o,'rev-parse','--git-path','index').decode().strip());ip=ip if ip.is_absolute() else o/ip
assert hashlib.sha256(ip.read_bytes()).hexdigest()==baseline['indexSHA256']
for x in baseline['files']:
 f=o/x['path'];assert f.stat().st_size==x['bytes'] and oct(f.stat().st_mode&0o777)==x['mode'] and hashlib.sha256(f.read_bytes()).hexdigest()==x['sha256']
a=json.load(open(w/'docs/maintenance/evidence/1292-current-main-20261008/CURRENT_AUTHOR_LEDGER.json'))['contributors']+[json.load(open(w/'docs/maintenance/evidence/1211-mcp-transport-20261009/DEPENDENCY_AUTHOR_LEDGER.json'))]
assert len(a)==18
for row in a:
 records=[]
 for sha in [row['source'],row['incorporated']]:
  headers,message=git(w,'cat-file','commit',sha).split(b'\n\n',1);author=next(x for x in headers.splitlines() if x.startswith(b'author '));records.append((author,message))
 assert records[0]==records[1] and hashlib.sha256(records[0][0]).hexdigest()==row['rawAuthorHeaderSha256'] and hashlib.sha256(records[0][1]).hexdigest()==row['fullMessageSha256']
 assert subprocess.run(['git','merge-base','--is-ancestor',row['incorporated'],'HEAD'],cwd=w).returncode==0
assert subprocess.run(['git','merge-base','--is-ancestor','5afedf10450f4d0f4d31faf0b7d5d9a72b74884e','HEAD'],cwd=w).returncode==1
r={'atUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'ownerHeadIndexStatusAndAll12DirtyFileIdentitiesExact':True,'rawAuthorDateFullMessageAndAncestryRecordsExact':18,'expanded1231Excluded':True,'sourceHead':git(w,'rev-parse','HEAD').decode().strip(),'productionDeltaPaths':git(w,'diff','--name-only','46ff481f9945c09582cd14c0d9f85c609c47e007','HEAD','--','src/proxy').decode().splitlines()}
(p/'OWNER_AUTHOR_REQUALIFICATION.json').write_text(json.dumps(r,indent=2)+'\n');print(r)
