# GrokBot Voice stopper — stops the three voice lanes by port (node processes only).
foreach ($port in 18793, 8094, 18795) {
  try {
    $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    foreach ($c in $conns) {
      $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
      if ($p -and $p.ProcessName -match 'node') {
        Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
        Write-Host "stopped $p.ProcessName pid $($p.Id) on :$port"
      }
    }
  } catch {}
}
Write-Host 'voice lanes stopped'
