import subprocess,pathlib,json,datetime,hashlib,os
w=pathlib.Path('/Users/rynfar/repos/meridian-claude-sidecalls-stack-1292-20261008');root=pathlib.Path(__file__).parent;g=root/'final-local-gates';g.mkdir(exist_ok=False)
head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=w,text=True).strip();assert head=='34b49d82d9f69b1044ccca2d12a082eca05969ca';assert not subprocess.check_output(['git','status','--porcelain'],cwd=w,text=True).strip()
(g/'STARTED.json').write_text(json.dumps({'head':head,'pid':os.getpid(),'startUTC':datetime.datetime.now(datetime.timezone.utc).isoformat()},indent=2)+'\n')
rows=[]
for name,argv in [('npm-test',['npm','test']),('typecheck',['npm','run','typecheck']),('build',['npm','run','build'])]:
 start=datetime.datetime.now(datetime.timezone.utc).isoformat()
 with (g/(name+'.log')).open('wb') as f:
  p=subprocess.Popen(argv,cwd=w,stdout=f,stderr=f);code=p.wait()
 row={'name':name,'argv':argv,'originalPid':p.pid,'joined':True,'exit':code,'startUTC':start,'endUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'logSHA256':hashlib.sha256((g/(name+'.log')).read_bytes()).hexdigest()};rows.append(row);(g/(name+'-TERMINAL.json')).write_text(json.dumps(row,indent=2)+'\n');print(json.dumps(row),flush=True)
 if code:break
clean=not subprocess.check_output(['git','status','--porcelain'],cwd=w,text=True).strip();same=subprocess.check_output(['git','rev-parse','HEAD'],cwd=w,text=True).strip()==head
r={'head':head,'headUnchanged':same,'cleanBeforeAfter':clean,'checks':rows,'qualified':same and clean and len(rows)==3 and all(x['exit']==0 for x in rows)};(g/'TERMINAL.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps({'qualified':r['qualified']}),flush=True)
