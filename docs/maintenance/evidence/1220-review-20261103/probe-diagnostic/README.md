# Antigravity subprocess startup diagnostic

Original results remain **red** for the candidate checkout. This diagnostic is
not an async-store acceptance test or a product fix. Read [findings](findings.md).

`proof.tar.gz` contains the exact original scripts/results/fixture listed in
`original-sha256.json`; all member digests were verified before escrow. Original
scripts contain absolute review paths. `probe.cjs` is the same exact fixture body.
The adjacent portable `probe-exec-forms.ts` changes only fixture lookup to its own
directory and permits explicit Node/minimal PATH settings. Assertions, one case
per arm and1000ms/50ms bounds are unchanged. It does not invoke agy or a model.

```sh
cd <selected candidate-or-baseline-checkout>
PROBE_NODE=<absolute native Node executable> \
PROBE_MINIMAL_PATH=<Node-directory>:/usr/bin:/bin:/usr/sbin:/sbin \
  bun <this-directory>/probe-exec-forms.ts
```

Run sequentially, not concurrently with other tests. Retain a failure; do not run
repeatedly for a green. Existing environment is inherited for this startup probe,
so use an approved context; only environment digests/key names are printed, not
values. stdout/stderr from the fixed synthetic child body are counted only.

This host's candidate cwd shebang timed out before script entry while explicit
env/direct Node succeeded. Baseline cwd shebang succeeded. PATH and selected Node
were not the demonstrated cause. OS-vs-Bun startup cause remains unestablished;
no timeout or product constant was changed. A current pass cannot clear the
historical E41 cache/fingerprint/initializer evidence holds.
