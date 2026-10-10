import pathlib,subprocess,json,hashlib,datetime,os,sys,uuid
root=pathlib.Path(__file__).parent;c=root/'build-context';tag='meridian1211:json-identity-r36-corrected'
inputs=[{'path':str(p.relative_to(c)),'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in [c/'Dockerfile',c/'qualify-source.py',c/'qualify-build.cjs',c/'SOURCE_IDENTITY.json',c/'candidate.bundle']]
(root/'BUILD_STARTED.json').write_text(json.dumps({'driverPid':os.getpid(),'tag':tag,'inputs':inputs,'atUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'realCredentialReads':0},indent=2)+'\n')
assert subprocess.check_output(['docker','image','inspect','meridian1211:complete-stream-r23-corrected','--format','{{.Id}}'],text=True).strip()=='sha256:c07ed57b13929b0bc91e0d46da574bb9bfd0bb11f8e62e84b889281394db0e68'
argv=['docker','build','--platform','linux/amd64','--progress=plain','--tag',tag,str(c)]
with (root/'docker-build.log').open('wb') as f:
 p=subprocess.Popen(argv,stdout=f,stderr=f);code=p.wait()
row={'originalPid':p.pid,'originalJoined':True,'exit':code,'argv':argv,'finishedUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'logSHA256':hashlib.sha256((root/'docker-build.log').read_bytes()).hexdigest()}
(root/'BUILD_TERMINAL.json').write_text(json.dumps(row,indent=2)+'\n');print(json.dumps(row),flush=True)
if code:sys.exit(code)
image=subprocess.check_output(['docker','image','inspect',tag,'--format','{{.Id}}'],text=True).strip();name='meridian1211-r23-build-receipt-'+uuid.uuid4().hex[:12]
cid=subprocess.check_output(['docker','create','--name',name,image,'true'],text=True).strip()
try:
 subprocess.run(['docker','cp',cid+':/opt/e71/JSON_BUILD_IDENTITY.json',str(root/'CHANGED_BUILD_IDENTITY.json')],check=True)
 state=json.loads(subprocess.check_output(['docker','inspect',cid],text=True))[0]['State'];assert not state['Running'] and state['Pid']==0
finally:subprocess.run(['docker','rm',cid],check=True,capture_output=True)
receipt=json.loads((root/'CHANGED_BUILD_IDENTITY.json').read_text());receipt.update(imageId=image,tag=tag,receiptContainerRemoved=True,originalBuildDriverPid=os.getpid(),originalDockerBuildPid=p.pid,originalDockerBuildJoined=True)
assert receipt['head']==json.loads((c/'SOURCE_IDENTITY.json').read_text())['head'] and receipt['clean']
(root/'CHANGED_BUILD_IDENTITY.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps({'imageId':image,'head':receipt['head'],'qualifiedChangedBuild':True}),flush=True)
