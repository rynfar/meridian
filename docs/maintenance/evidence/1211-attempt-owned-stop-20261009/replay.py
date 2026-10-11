#!/usr/bin/env python3
"""Replay one escrowed offline integrated arm in a caller-selected exact image.
Creates only a fresh owned evidence directory and one bounded owned container.
No host credentials, SDK private files, existing worktree or global Docker context.
"""
from pathlib import Path
import argparse, datetime, hashlib, json, os, re, shutil, subprocess, sys, uuid

parser = argparse.ArgumentParser()
parser.add_argument('--arm', required=True, choices=['integrated-http-source-textdecode', 'integrated-http-installed'])
parser.add_argument('--image', required=True)
parser.add_argument('--output', required=True, type=Path)
a = parser.parse_args()
assert re.fullmatch(r'sha256:[0-9a-f]{64}', a.image), 'An exact local image ID is required'
assert subprocess.check_output(['docker', 'image', 'inspect', a.image, '--format', '{{.Id}}'], text=True).strip() == a.image
original = Path(__file__).parent / a.arm
out = a.output.resolve()
out.mkdir(mode=0o700, parents=True, exist_ok=False)
shutil.copytree(original / 'probe', out / 'probe')
proof = out / 'proof'; proof.mkdir(mode=0o700)
uid, gid = os.getuid(), os.getgid()
if uid == 0:
    uid, gid = 501, 501
    os.chown(proof, uid, gid)
inputs = []
for f in sorted((out / 'probe').iterdir()):
    assert f.is_file() and not f.is_symlink()
    f.chmod(0o444)
    inputs.append({'path': f.name, 'bytes': f.stat().st_size, 'sha256': hashlib.sha256(f.read_bytes()).hexdigest()})
(out / 'probe').chmod(0o555)
installed = a.arm == 'integrated-http-installed'
root = '/opt/e71/installed/node_modules/@rynfar/meridian' if installed else '/opt/e71/candidate'
cli = '/opt/e71/installed/node_modules/@anthropic-ai/claude-code/bin/claude.exe' if installed else '/opt/e71/candidate/node_modules/@anthropic-ai/claude-code/bin/claude.exe'
version = '2.1.296' if installed else '2.1.284'
name = 'meridian1211-offline-replay-' + uuid.uuid4().hex[:12]
argv = ['docker', 'create', '--init', '--platform', 'linux/amd64', '--network=none', '--read-only', '--pids-limit', '128', '--memory', '4g', '--name', name, '--user', f'{uid}:{gid}', '--tmpfs', '/tmp:rw,mode=1777,size=256m', '--mount', f'type=bind,src={out}/probe/machine-id,dst=/etc/machine-id,readonly', '--mount', f'type=bind,src={proof},dst=/proof', '--mount', f'type=bind,src={out}/probe,dst=/probe,readonly', a.image, 'bun', '/probe/integrated-proxy.mjs', '--source-root=' + root, '--evidence-dir=/proof', '--claude-executable=' + cli, '--expected-cli-version=' + version]
(out / 'INPUTS.json').write_text(json.dumps({'arm': a.arm, 'image': a.image, 'inputs': inputs, 'runtimeNetwork': 'none', 'realCredentialMounts': 0, 'actualModelClientAcceptance': False}, indent=2) + '\n')
cid = subprocess.check_output(argv, text=True).strip()
(out / 'INVOCATION.json').write_text(json.dumps({'argv': argv, 'containerId': cid, 'originalDriverPid': os.getpid()}, indent=2) + '\n')
actor = None; code = 1; overdue = False; joined = False; removed = False
try:
    with (out / 'native.output.log').open('wb') as log:
        actor = subprocess.Popen(['docker', 'start', '--attach', cid], stdout=log, stderr=log)
        (out / 'STARTED.json').write_text(json.dumps({'originalAttachPid': actor.pid, 'containerId': cid}, indent=2) + '\n')
        try:
            code = actor.wait(timeout=400)
        except subprocess.TimeoutExpired:
            overdue = True
            state = json.loads(subprocess.check_output(['docker', 'inspect', cid]))[0]['State']
            if state['Running']:
                subprocess.run(['docker', 'kill', '--signal', 'SIGKILL', cid], check=True, capture_output=True)
            code = actor.wait()
        joined = True
finally:
    info = json.loads(subprocess.check_output(['docker', 'inspect', cid]))[0]
    state = info['State']
    (out / 'CONTAINER_TERMINAL.json').write_text(json.dumps({'state': state, 'image': info['Image'], 'networkMode': info['HostConfig']['NetworkMode'], 'readOnlyRoot': info['HostConfig']['ReadonlyRootfs']}, indent=2) + '\n')
    if not state['Running'] and state['Pid'] == 0:
        subprocess.run(['docker', 'rm', cid], check=True, capture_output=True); removed = True
    unchanged = all((out / 'probe' / row['path']).stat().st_size == row['bytes'] and hashlib.sha256((out / 'probe' / row['path']).read_bytes()).hexdigest() == row['sha256'] for row in inputs)
    receipt = {'atUTC': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'originalDriverPid': os.getpid(), 'originalAttachPid': actor.pid if actor else None, 'originalAttachJoined': joined, 'attachExit': code, 'hostDeadlineExceeded': overdue, 'containerStoppedPidZero': not state['Running'] and state['Pid'] == 0, 'ownedContainerRemoved': removed, 'inputsUnchanged': unchanged, 'actualModelClientAcceptance': False}
    (out / 'TERMINAL.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt), flush=True)
sys.exit(0 if code == 0 and joined and removed and unchanged and not overdue else 1)
