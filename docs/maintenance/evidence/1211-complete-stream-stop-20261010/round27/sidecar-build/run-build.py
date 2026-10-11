from pathlib import Path
import subprocess,json,hashlib,os,datetime,sys
r=Path(__file__).parent;tag='meridian1211:complete-stream-r27-e41-sidecars';argv=['docker','build','--platform','linux/amd64','--progress=plain','--tag',tag,str(r)]
with (r/'docker-build.log').open('wb') as f:p=subprocess.Popen(argv,stdout=f,stderr=f);code=p.wait()
v={'originalDriverPid':os.getpid(),'originalDockerBuildPid':p.pid,'originalJoined':True,'exit':code,'argv':argv,'finishedUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'DockerfileSHA256':hashlib.sha256((r/'Dockerfile').read_bytes()).hexdigest()}
if code==0:v['imageId']=subprocess.check_output(['docker','image','inspect',tag,'--format','{{.Id}}'],text=True).strip()
(r/'BUILD_TERMINAL.json').write_text(json.dumps(v,indent=2)+'\n');print(json.dumps(v),flush=True);sys.exit(code)
