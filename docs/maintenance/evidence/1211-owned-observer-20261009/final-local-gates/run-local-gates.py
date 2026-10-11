from pathlib import Path
import subprocess,json,datetime,os,sys
p=Path(__file__).parent
w=Path("/Users/rynfar/repos/meridian-claude-sidecalls-stack-1292-20261008")
head=subprocess.check_output(["git","rev-parse","HEAD"],cwd=w,text=True).strip()
for name,argv in [("npm-test",["npm","test"]),("typecheck",["npm","run","typecheck"]),("build",["npm","run","build"])]:
 start=datetime.datetime.now(datetime.timezone.utc).isoformat()
 with (p/(name+".log")).open("wb") as log:
  actor=subprocess.Popen(argv,cwd=w,stdout=log,stderr=log)
  (p/(name+"-started.json")).write_text(json.dumps({"argv":argv,"head":head,"originalRunnerPid":os.getpid(),"originalProcessPid":actor.pid,"startUTC":start},indent=2)+"\n")
  code=actor.wait()
 after=subprocess.check_output(["git","rev-parse","HEAD"],cwd=w,text=True).strip()
 receipt={"argv":argv,"head":head,"headAfter":after,"originalProcessPid":actor.pid,"originalProcessJoined":True,"exit":code,"startUTC":start,"endUTC":datetime.datetime.now(datetime.timezone.utc).isoformat()}
 (p/(name+"-terminal.json")).write_text(json.dumps(receipt,indent=2)+"\n")
 print(json.dumps(receipt),flush=True)
 if code or after!=head:sys.exit(1)
