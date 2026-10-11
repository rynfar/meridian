from pathlib import Path
import subprocess,json,datetime,os,sys
p=Path(__file__).parent
argv=["docker","build","--platform","linux/amd64","--progress=plain","--iidfile",str(p/"IMAGE_ID.txt"),"--tag","meridian1211:checkpoint-r6-44ae1bc2",str(p/"context")]
with (p/"build.log").open("wb") as log:
 actor=subprocess.Popen(argv,stdout=log,stderr=log)
 (p/"BUILD_STARTED.json").write_text(json.dumps({"argv":argv,"runnerPid":os.getpid(),"originalBuildPid":actor.pid,"startUTC":datetime.datetime.now(datetime.timezone.utc).isoformat()},indent=2)+"\n")
 code=actor.wait()
r={"exit":code,"originalBuildPid":actor.pid,"originalBuildJoined":True,"endUTC":datetime.datetime.now(datetime.timezone.utc).isoformat(),"imageId":(p/"IMAGE_ID.txt").read_text().strip() if (p/"IMAGE_ID.txt").exists() else None}
if code==0:
 r["imageInspect"]=json.loads(subprocess.check_output(["docker","image","inspect",r["imageId"]]))[0]
(p/"BUILD_TERMINAL.json").write_text(json.dumps(r,indent=2)+"\n")
print(json.dumps({k:v for k,v in r.items() if k!="imageInspect"}),flush=True)
sys.exit(code)
