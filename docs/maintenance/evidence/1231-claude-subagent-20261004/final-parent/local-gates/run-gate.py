import subprocess,pathlib,os,json,hashlib,datetime,time,sys,re
r=pathlib.Path('/Users/rynfar/repos/meridian-claude-subagent-1231-20261004')
out=pathlib.Path(__file__).resolve().parent; name=sys.argv[1]; command=sys.argv[2:]; assert command and re.fullmatch(r'[a-z0-9-]+',name)
freeze=json.loads((out/'freeze.json').read_text()); git=lambda *a:subprocess.check_output(['git',*a],cwd=r,text=True).strip()
def unchanged():
 assert git('rev-parse','HEAD')==freeze['head'] and not git('status','--porcelain=v1')
 for path,h in freeze['sourceSha256'].items(): assert hashlib.sha256((r/path).read_bytes()).hexdigest()==h,path
unchanged(); started=datetime.datetime.now(datetime.timezone.utc).isoformat(); clock=time.monotonic(); env=os.environ.copy(); removed=[]
for key in list(env):
 if key.startswith(('ANTHROPIC_','CLAUDE_','MERIDIAN_','E71_','E72_')): removed.append(key);env.pop(key)
log=out/f'{name}.log'; assert not log.exists()
with log.open('xb') as stream:
 process=subprocess.Popen(command,cwd=r,env=env,stdin=subprocess.DEVNULL,stdout=stream,stderr=subprocess.STDOUT,start_new_session=True)
 active={'head':freeze['head'],'command':command,'pid':process.pid,'processGroup':process.pid,'startedUtc':started,'removedEnvNames':removed,'log':str(log)}
 (out/f'{name}.active.json').write_text(json.dumps(active,indent=2)+'\n'); print(json.dumps(active),flush=True); code=process.wait()
unchanged(); raw=log.read_bytes();result={**active,'exitCode':code,'elapsedSeconds':time.monotonic()-clock,'completedUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'logBytes':len(raw),'logSha256':hashlib.sha256(raw).hexdigest(),'sourceUnchanged':True,'terminalProcessWaitObserved':True}
(out/f'{name}.result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result),flush=True);print(raw.decode(errors='replace')[-1800:],flush=True);sys.exit(code)
