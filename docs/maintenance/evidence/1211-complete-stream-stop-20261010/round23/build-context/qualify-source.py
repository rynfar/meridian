from pathlib import Path
import subprocess,json,hashlib
p=Path('/opt/e71/corrected');m=json.loads(Path('/snapshot-corrected/SOURCE_IDENTITY.json').read_text())
for r in m['allCurrentTrackedRegularFiles']:
 b=(p/r['path']).read_bytes();assert len(b)==r['bytes'] and hashlib.sha256(b).hexdigest()==r['sha256']
names=subprocess.check_output(['git','ls-tree','-r','--name-only','HEAD'],cwd=p)
subprocess.run(['git','hash-object','-w','--stdin-paths'],cwd=p,input=names,stdout=subprocess.DEVNULL,check=True)
subprocess.run(['git','reset','--mixed','HEAD'],cwd=p,stdout=subprocess.DEVNULL,check=True)
assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=p,text=True).strip()==m['head']
status=subprocess.check_output(['git','status','--porcelain'],cwd=p,text=True).strip()
assert not status, 'Frozen tree is dirty: '+status
print(json.dumps({'head':m['head'],'allCurrentTrackedFilesExact':len(m['allCurrentTrackedRegularFiles']),'clean':True,'ownerCheckoutReadOnly':True}))
