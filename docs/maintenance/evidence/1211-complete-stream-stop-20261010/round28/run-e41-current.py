from pathlib import Path
import argparse,subprocess,json,hashlib,datetime,os,time,shutil,math
p=argparse.ArgumentParser();p.add_argument('--phase',choices=['prepare','live'],required=True);p.add_argument('--mode',choices=['chain','parallel'],required=True);p.add_argument('--stream',choices=['0','1'],required=True);p.add_argument('--target',choices=['source','installed'],required=True);a=p.parse_args();mode=a.mode;stream=a.stream;target=a.target;root=Path(__file__).parent;name='e41-'+target+'-'+mode+'-'+stream+'-'+a.phase;out=root/name;out.mkdir(exist_ok=False,mode=0o700);proof=out/'proof';proof.mkdir(mode=0o700);private=out/'.private';private.mkdir(mode=0o700);grant=private/'access-token'
build=json.loads((root.parent/'pr1211-complete-stream-stop-build-20261010-round23/CHANGED_BUILD_IDENTITY.json').read_text());assert build['head']=='34b49d82d9f69b1044ccca2d12a082eca05969ca' and build['clean'];fixture=json.loads((root.parent/'pr1211-complete-stream-stop-e41-20261010-round27/sidecar-build/BUILD_TERMINAL.json').read_text());assert fixture['exit']==0 and fixture['originalJoined'];image=fixture['imageId'];identity=build['targets'][target];assert json.loads(subprocess.check_output(['docker','image','inspect',image]))[0]['Id']==image
gates=json.loads((root.parent/'pr1211-complete-stream-stop-correction-20261010-round22/final-local-gates/TERMINAL.json').read_text());assert gates['qualified'] and gates['head']==build['head']
for kind in ['source','installed']:
 actual=json.loads((root.parent/'pr1211-complete-stream-stop-actual-client-20261010-round25'/(kind+'-live')/'TERMINAL.json').read_text());assert actual['qualified']
if a.phase=='live':assert json.loads((root/('e41-'+target+'-chain-0-prepare')/'TERMINAL.json').read_text())['qualified']
if target=='installed' and a.phase=='live':
 for m in ['chain','parallel']:
  for st in ['0','1']:assert json.loads((root/('e41-source-'+m+'-'+st+'-live')/'TERMINAL.json').read_text())['qualified']
def source_read():
 q=json.loads((root.parent/'pr1211-e41-sonnet-native-20261009-round1/PRIVATE_SOURCE_READ_QUALIFICATION.json').read_text());r=subprocess.run(['security','find-generic-password','-s',q['sourceService'],'-a',q['sourceAccount'],'-w'],capture_output=True,timeout=15)
 if r.returncode:raise RuntimeError('source unavailable')
 return r.stdout.strip()
sourceHash=None
if a.phase=='live':
 raw=source_read();sourceHash=hashlib.sha256(raw).hexdigest();g=json.loads(raw)['claudeAiOauth'];assert 'user:inference' in g['scopes'] and g['expiresAt']/1000-time.time()>600;grant.write_text(g['accessToken']);del raw,g
else:grant.write_text('zero-query-prepare')
grant.chmod(0o400);gs=grant.stat();gh=hashlib.sha256(grant.read_bytes()).hexdigest();assert gs.st_uid==os.getuid() and gs.st_nlink==1
machine=out/'machine-id';machine.write_text(hashlib.sha256(('e41-r14-'+name).encode()).hexdigest()[:32]+'\n');machine.chmod(0o444)
runtime=proof/'runtime';base=identity['root'];argv=['docker','create','--init','--platform','linux/amd64','--read-only','--tmpfs','/tmp:rw,nosuid,nodev,size=1g,mode=1777','--name','meridian1211-r27-'+name,'--pids-limit','128','--memory','4g','--mount','type=bind,source='+str(proof)+',target=/proof','--mount','type=bind,source='+str(private)+',target=/grant,readonly','--mount','type=bind,source='+str(machine)+',target=/etc/machine-id,readonly']
if a.phase=='prepare':argv+=['--network','none']
env={'TMPDIR':'/tmp','E2E_MERIDIAN_ENTRY':base+'/dist/server.js','E2E_SDK_ENTRY':identity['sdk'],'E2E_NATIVE_BIN':identity['native'],'E2E_OPENCLAW_BIN':'/opt/e41/sidecars/node_modules/openclaw/openclaw.mjs','E2E_SCRUB_ENTRY':'/opt/e41/sidecars/node_modules/@rynfar/meridian-plugin-openclaw-scrub/dist/index.js','E2E_OUTPUT_DIR':'/proof/runtime','E2E_TOKEN_FILE':'/grant/access-token','E2E_EXPECT':'candidate','E2E_E41_MODE':mode,'E2E_E41_STREAM':stream,'E2E_E41_MODEL':'claude-sonnet-5-5','E2E_E41_NATIVE_VERSION':identity['nativeVersion']}
for k,v in env.items():argv+=['--env',k+'='+v]
argv+=[image,'bun','/opt/e71/corrected/scripts/e2e-openclaw-native.mjs']
if a.phase=='prepare':argv+=['--prepare-only']
cid=None;actor=None;code=None;joined=False;overdue=False;removed=False;qualified=False;failure=None;grantSame=False;sourceSame=None;r=None
try:
 cid=subprocess.check_output(argv,text=True).strip();(out/'INVOCATION.json').write_text(json.dumps({'argv':argv,'containerId':cid,'imageId':image,'driverPid':os.getpid(),'runtimeHead':build['head'],'actualClientClaim':False,'scope':'E41 direct HTTP protocol with real SDK/native/model; no actual OpenCode or Claude Code client claim'},indent=2)+'\n')
 with (out/'public.output.log').open('wb') as log:
  actor=subprocess.Popen(['docker','start','--attach',cid],stdout=log,stderr=log);(out/'STARTED.json').write_text(json.dumps({'originalAttachPid':actor.pid,'startUTC':datetime.datetime.now(datetime.timezone.utc).isoformat()},indent=2)+'\n')
  try:code=actor.wait(timeout=540)
  except subprocess.TimeoutExpired:
   overdue=True
   if json.loads(subprocess.check_output(['docker','inspect',cid]))[0]['State']['Running']:subprocess.run(['docker','kill','--signal','SIGKILL',cid],capture_output=True,check=True)
   code=actor.wait()
  joined=True
 state=json.loads(subprocess.check_output(['docker','inspect',cid]))[0]['State'];assert not state['Running'] and state['Pid']==0
 r=json.loads((runtime/'REPORT.json').read_text());shutil.copyfile(runtime/'REPORT.json',out/'REPORT.json')
 assert r['inputFiles']['MERIDIAN_ENTRY']['sha256']==identity['coreSha256']
 assert r['inputFiles']['SDK_ENTRY']['sha256']==identity['sdkEntrySha256']
 assert r['inputFiles']['NATIVE_BIN']['sha256']==identity['nativeSha256']
 if a.phase=='prepare':
  assert code==state['ExitCode']==0 and r['disposition']=='PASS_PREREQUISITES_ONLY' and r['firstFailure'] is None and r['actualProviderQueries']==0 and not r['queries']
 else:
  version = identity['nativeVersion']
  count = 5 if mode == 'chain' else 3
  expected = 'PASS_E41_' + mode.upper() + ('_STREAM' if stream == '1' else '_NONSTREAM')
  assert code == state['ExitCode'] == 0
  assert r['disposition'] == expected and r['firstFailure'] is None
  assert r['platform'] == 'linux' and r['architecture'] == 'x64' and r['sdkVersion'] == '0.2.141'
  assert r['nativeVersion'] == version + ' (Claude Code)'
  assert r['e41']['mode'] == mode and r['e41']['stream'] == (stream == '1')
  assert r['e41']['requestedModel'] == r['e41']['requiredServedModel'] == 'claude-sonnet-5-5'
  assert r['actualProviderQueries'] == len(r['queries']) == len(r['requests']) == len(r['stages']) == count
  assert r['httpJoined'] and r['queryJoins'] and r['sourceCredentialLoginRefreshWrites'] is False
  w = r['httpWitnesses']
  assert w['proxyCloseSeen'] and not w['proxyListening'] and not w['relayListening']
  assert w['remainingSockets'] == w['remainingHandlers'] == 0
  assert all(x['settled'] for x in r['supportedHistoryReads'])
  sdk = [c for c in r['children'] if c['kind'] == 'sdk-gate']
  assert len(sdk) == count
  for child in r['children']:
      c = child['closure']
      assert child['stdinClosed'] and all(c[k] for k in ['joined', 'exitSeen', 'closeSeen', 'stdoutClosed', 'stderrClosed'])
      assert not c['spawnFailed'] and c['exitSignal'] is None and c['signalFailure'] is None
      assert not c['termSent'] and not c['killSent']
      if child['kind'] != 'sdk-gate':
          assert c['exitCode'] == 0
  cost = 0
  targets = set()
  prior_cached = 0
  for q, request, stage in zip(r['queries'], r['requests'], r['stages']):
      assert all(q[k] for k in ['constructed', 'iteratorSettled', 'closeCalled', 'publicSpawn', 'privateGrantMatched', 'configOwned', 'cwdOwned', 'resultCompleted', 'terminalSessionMatched'])
      assert q['actualModels'] and set(q['actualModels']) == {'claude-sonnet-5-5'}
      assert q['inputUsageTokens'] > 0 and q['outputTokens'] > 0
      assert math.isfinite(q['estimatedCostUsd']) and 0 <= q['estimatedCostUsd'] <= .5
      cost += q['estimatedCostUsd']
      assert request['phase'] == q['phase'] == stage['stage']
      assert request['status'] == 200 and request['responseJoined'] and stage['responseJoined']
      assert request['stream'] == (stream == '1') and request['model'] == 'claude-sonnet-5-5'
      assert stage['workingSessionDigest'] == q['targetSessionDigest']
      assert q['targetSessionDigest'] not in targets
      targets.add(q['targetSessionDigest'])
      if prior_cached:
          assert q['resume'] and stage['lineage'] == 'continuation' and stage['cacheRead'] >= .95 * prior_cached
      prior_cached = stage['cacheRead'] + stage['cacheWrite']
      assert prior_cached > 0
      matching = [c for c in sdk if c['originalPid'] == q['originalPid'] and c['phase'] == q['phase']]
      assert len(matching) == 1
      c = matching[0]
      assert c['nativeInit'] and all(i['model'] == 'claude-sonnet-5-5' and i['version'] == version for i in c['nativeInit'])
      assert len(c['nativeTerminal']) == 1
      n = c['nativeTerminal'][0]
      assert n['subtype'] == q['resultSubtype'] and n['isError'] == q['resultIsError']
      if q['resultSubtype'] == 'success':
          assert q['resultIsError'] is False and c['closure']['exitCode'] == 0
      else:
          assert q['resultSubtype'] == 'error_max_turns' and q['resultIsError'] is True and c['closure']['exitCode'] == 1
          assert request['phase'] != 'e41-saved-fork-followup'
  assert cost <= 4
  v = r['e41']['verdict']
  assert v['batches'] == ([1, 1, 1] if mode == 'chain' else [3])
  assert v['realAnswers'] == 3 and v['immutableParents'] == v['distinctContinuations'] == count - 1
  assert v['savedForkFollowup'] and v['actualModel'] == 'claude-sonnet-5-5' and v['cachedPrefixFloor'] == .95
 qualified=True
except Exception as error:failure=type(error).__name__;qualified=False
finally:
 if cid:
  info=json.loads(subprocess.check_output(['docker','inspect',cid]))[0];state=info['State'];(out/'CONTAINER_TERMINAL.json').write_text(json.dumps({'state':state,'imageId':info['Image']},indent=2)+'\n')
  if not state['Running'] and state['Pid']==0:subprocess.run(['docker','rm',cid],capture_output=True,check=True);removed=True
 if a.phase=='live':sourceSame=hashlib.sha256(source_read()).hexdigest()==sourceHash
 stat=grant.stat();grantSame=stat.st_ino==gs.st_ino and stat.st_nlink==1 and stat.st_uid==gs.st_uid and (stat.st_mode&0o777)==0o400 and hashlib.sha256(grant.read_bytes()).hexdigest()==gh
 if (cid is None or removed) and (actor is None or joined):
  grant.unlink();private.rmdir()
  if runtime.exists():shutil.rmtree(runtime)
 qualified=bool(qualified and joined and removed and code==0 and not overdue and grantSame and (a.phase=='prepare' or sourceSame))
 receipt={'phase':a.phase,'mode':mode,'stream':stream=='1','qualified':qualified,'exit':code,'originalDriverPid':os.getpid(),'originalAttachPid':actor.pid if actor else None,'originalAttachJoined':joined,'hostDeadlineExceeded':overdue,'ownedContainerRemoved':removed,'sourceGrantUnchanged':sourceSame,'taskGrantUnchanged':grantSame,'taskGrantRemoved':not private.exists(),'ownedRuntimeRemoved':not runtime.exists(),'queries':len(r['queries']) if r else None,'costUsd':sum(q.get('estimatedCostUsd') or 0 for q in r['queries']) if r else None,'failureClass':failure,'firstFailure':r.get('firstFailure') if r else None,'finishedUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'wholeChangeAcceptance':'HELD'};(out/'TERMINAL.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt),flush=True)
sys_exit=0 if qualified else 2
raise SystemExit(sys_exit)
