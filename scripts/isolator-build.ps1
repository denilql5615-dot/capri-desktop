$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$isolatorDir = Join-Path $root 'isolator'

Write-Host '[isolator-build] Building capri-tor-gw:latest...'
docker build -f (Join-Path $isolatorDir 'Dockerfile.torgw') -t capri-tor-gw:latest $isolatorDir
if ($LASTEXITCODE -ne 0) {
  throw "Failed to build capri-tor-gw:latest (exit $LASTEXITCODE)"
}

Write-Host '[isolator-build] Building capri-tor-isolator:latest...'
docker build -f (Join-Path $isolatorDir 'Dockerfile.isolator') -t capri-tor-isolator:latest $isolatorDir
if ($LASTEXITCODE -ne 0) {
  throw "Failed to build capri-tor-isolator:latest (exit $LASTEXITCODE)"
}

Write-Host '[isolator-build] Done:'
docker images 'capri-tor-*' --format 'table {{.Repository}}\t{{.Tag}}\t{{.ID}}\t{{.Size}}'
