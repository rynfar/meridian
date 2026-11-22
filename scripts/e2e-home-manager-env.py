#!/usr/bin/env python3
"""Credentialless Home Manager -> real systemd user-manager environment gate.

Run on Linux with nix and a running user manager, or use --machine for an owned
OrbStack Linux VM. --module selects an unchanged baseline or candidate module.
Only fixture variable values are read; no model, credentials, or account calls.
"""
import argparse
import json
import subprocess
import uuid

parser = argparse.ArgumentParser()
parser.add_argument('--machine')
parser.add_argument('--flake', required=True)
parser.add_argument('--module', required=True)
parser.add_argument('--expect', choices=['baseline', 'candidate'], required=True)
parser.add_argument('--report', required=True)
args = parser.parse_args()
prefix = ['orb', '-m', args.machine] if args.machine else []

def run(command, input=None):
    return subprocess.run(prefix + command, input=input, capture_output=True, text=True)

uid = run(['id', '-u'])
assert uid.returncode == 0 and uid.stdout.strip().isdigit()
home = run(['sh', '-c', 'printf %s "$HOME"'])
assert home.returncode == 0
runtime = '/run/user/' + uid.stdout.strip()
manager = run(['env', 'XDG_RUNTIME_DIR=' + runtime, 'systemctl', '--user', 'is-system-running'])
assert manager.returncode == 0, manager.stderr
# Values are fixed, credentialless fixtures, not inherited owner configuration.
values = {
    'MERIDIAN_PROFILES': '[{"claudeConfigDir":"/home/example/claude work","id":"personal"}]',
    'MERIDIAN_WORKDIR': '/home/example/back\\slash',
    'CLAUDE_CONFIG_DIR': '%h/.claude-work',
    'MERIDIAN_PORT': '4567',
    'EXAMPLE': 'two  spaces',
    'ESCAPES': 'tab\tline\nquote"slash\\',
    'UNICODE': 'café 雪',
}
# Serialize fixed values into a Nix string consumed by fromJSON. No shell eval.
nix_values = json.dumps(json.dumps(values, ensure_ascii=False), ensure_ascii=False)
# The current module takes the flake as `self`; earlier baselines take the
# package set `services.meridian.package` defaults from.
expression = f'''let
  flake = builtins.getFlake {json.dumps('path:' + args.flake)};
  pkgs = import flake.inputs.nixpkgs {{ system = builtins.currentSystem; }};
  module = import (builtins.toPath {json.dumps(args.module)});
  config = (flake.inputs.home-manager.lib.homeManagerConfiguration {{
    inherit pkgs;
    modules = (if builtins.functionArgs module ? self
      then [ (module {{ self = flake; }}) {{ services.meridian.package = pkgs.emptyDirectory; }} ]
      else [ (module {{ meridian = pkgs.emptyDirectory; }}) ]) ++ [ {{
      home.username = "meridian-test";
      home.homeDirectory = "/home/meridian-test";
      home.stateVersion = "25.11";
      services.meridian = {{ enable = true; settings.port = 3456; environment = builtins.fromJSON {nix_values}; }};
    }} ];
  }}).config;
in config.systemd.user.services.meridian.Service.Environment'''
evaluation = run(['nix', '--extra-experimental-features', 'nix-command flakes', 'eval', '--impure', '--json', '--expr', expression])
assert evaluation.returncode == 0, evaluation.stderr
assignments = json.loads(evaluation.stdout)
report = {'expect': args.expect, 'module': args.module, 'assignments': assignments, 'cases': [], 'modelCalls': 0}
# Write actual unit files: transient DBus Environment properties deliberately
# do not expand %h, so they cannot validate the unit-file specifier contract.
unit_dir = runtime + '/systemd/user'
assert run(['mkdir', '-p', unit_dir]).returncode == 0
for name, value in values.items():
    relevant = [item for item in assignments if item.startswith(name + '=') or item.startswith('"' + name + '=')]
    assert relevant, name
    identity = 'meridian-env-' + uuid.uuid4().hex
    unit_path = unit_dir + '/' + identity + '.service'
    output_path = '/tmp/' + identity + '.output'
    unit = '[Unit]\nDescription=Owned Meridian environment proof\n[Service]\nType=oneshot\n'
    unit += ''.join('Environment=' + assignment + '\n' for assignment in relevant)
    unit += 'ExecStart=/run/current-system/sw/bin/printenv ' + name + '\nStandardOutput=truncate:' + output_path + '\n'
    control = ['env', 'XDG_RUNTIME_DIR=' + runtime, 'systemctl', '--user']
    try:
        assert run(['sh', '-c', 'cat > "$1"', 'sh', unit_path], unit).returncode == 0
        assert run(control + ['daemon-reload']).returncode == 0
        result = run(control + ['start', identity])
        output = run(['cat', output_path])
        expected = value.replace('%h', home.stdout)
        passed = result.returncode == 0 and output.returncode == 0 and output.stdout == expected + '\n'
        report['cases'].append({'name': name, 'exit': result.returncode, 'expected': expected, 'observed': output.stdout.removesuffix('\n'), 'pass': passed, 'stderr': result.stderr})
    finally:
        stopped = run(control + ['stop', identity])
        if stopped.returncode != 0:
            # A malformed baseline unit can fail to load, so stop also fails.
            # Require no service process before removing that owned fixture.
            state = run(control + ['show', identity, '--property=MainPID', '--value'])
            assert state.stdout.strip() == '0', stopped.stderr
        run(control + ['reset-failed', identity])
        assert run(['rm', '-f', unit_path, output_path]).returncode == 0
        assert run(control + ['daemon-reload']).returncode == 0
report['result'] = 'PASS' if all(case['pass'] for case in report['cases']) else 'FAIL'
with open(args.report, 'w') as target:
    json.dump(report, target, indent=2, ensure_ascii=False)
    target.write('\n')
print(json.dumps({'result': report['result'], 'expect': args.expect, 'cases': [{'name': c['name'], 'pass': c['pass']} for c in report['cases']]}))
assert (report['result'] == 'PASS') == (args.expect == 'candidate')
if args.expect == 'baseline':
    assert any(not case['pass'] and case['name'] == 'MERIDIAN_PROFILES' for case in report['cases'])
