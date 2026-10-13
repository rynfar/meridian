# Windows detached CLI diagnostic failure

Head c9110450f405e0d1b26911b6d04cd25723e1a516; application still 7b0e2f467f5139374e55645f6cb58904b047e33b.
[Windows job](https://github.com/rynfar/meridian/actions/runs/38330733492/job/115079632913) failed. Both actual source and independently installed CLI receipts remain failures.

The configuration-only controls narrow the failure without proving a correction:
- Allowlisted environment: ACL subprocess killed by SIGTERM after roughly 10 seconds, no output.
- Adding PSModulePath: Get-Acl reports Microsoft.PowerShell.Security could not be loaded.
- Clean hosted runner environment control: same module-load error. This control imports only detachedStore; it does not run a model or print environment values.

Full host environment did not make the control pass, so missing PSModulePath alone is not an established cause. Preserve ACL fail-closed behavior. Next diagnostic should expose the explicit security-module import exception under the same owned scratch-directory conditions, then rerun the actual source and installed lifecycle after a justified correction. No timeout increase or ACL bypass is justified by these results. PR remains draft; native Windows lifecycle and live active-turn drain remain open gates.
