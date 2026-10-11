from pathlib import Path
import subprocess,json,datetime,os,sys
p=Path(__file__).parent;w='/Users/rynfar/repos/meridian-claude-sidecalls-stack-1292-20261008';name=sys.argv[1]
assert name in ['build','typecheck','test','focused','compiled']
argv=['bun','test','src/__tests__/e72-public-sdk-diagnostics.test.ts','src/__tests__/e72-background-read.test.ts'] if name=='focused' else ['npm','test'] if name=='test' else ['npm','run',name]
if name=='compiled':
 argv=['bun','test','src/__tests__/claude-auto-mode-harness.test.ts','-t','binds existing certified compiled HTTP requests'];os.environ['E71_COMPILED_CONTEXT_CONTROL']='1'
head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=w,text=True).strip()
with (p/(name+'.log')).open('xb') as f:
 child=subprocess.Popen(argv,cwd=w,stdout=f,stderr=f)
 (p/(name+'-started.json')).write_text(json.dumps({'driverPid':os.getpid(),'childPid':child.pid,'argv':argv,'head':head},indent=2)+'\n')
 code=child.wait()
receipt={'atUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'head':head,'argv':argv,'driverPid':os.getpid(),'childPid':child.pid,'originalProcessJoined':True,'exitCode':code}
assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=w,text=True).strip()==head
(p/(name+'-terminal.json')).write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt),flush=True);sys.exit(code)
