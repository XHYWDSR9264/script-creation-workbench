$ErrorActionPreference = 'Stop'
$python = 'C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
if (-not (Test-Path $python)) { $python = 'python' }
Write-Host '剧本创作总控台：http://127.0.0.1:8786'
& $python server.py
