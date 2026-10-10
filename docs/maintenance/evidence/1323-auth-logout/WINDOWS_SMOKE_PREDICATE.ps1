$ErrorActionPreference = 'Stop'
$cases = @(
  @{name='observed-logout'; status=503; auth=$false; state='unhealthy'; reject=$false},
  @{name='string-false'; status=503; auth='false'; state='unhealthy'; reject=$true},
  @{name='missing-auth'; status=503; auth=$null; state='unhealthy'; reject=$true},
  @{name='logged-in'; status=503; auth=$true; state='unhealthy'; reject=$true},
  @{name='wrong-state'; status=503; auth=$false; state='degraded'; reject=$true},
  @{name='healthy'; status=200; auth=$true; state='healthy'; reject=$false}
)
foreach ($case in $cases) {
  $r = @{StatusCode=$case.status}
  $body = @{status=$case.state; auth=@{loggedIn=$case.auth}}
  $rejected = $false
  if ($r.StatusCode -eq 503 -and ($body.status -ne "unhealthy" -or $body.auth.loggedIn -isnot [bool] -or $body.auth.loggedIn)) { $rejected = $true }
  if ($rejected -ne $case.reject) { throw "Wrong acceptance for $($case.name)" }
  Write-Output "$($case.name): PASS"
}
