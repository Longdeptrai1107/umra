$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$release = Join-Path $root 'release'
New-Item -ItemType Directory -Force -Path $release | Out-Null
$stage = Join-Path $release ('source-stage-' + [guid]::NewGuid().ToString('N'))
$project = Join-Path $stage 'umra'
New-Item -ItemType Directory -Force -Path $project | Out-Null
foreach ($name in @('frontend','desktop','backend','runtime-adapters','shared-schemas','scripts','docs','tests')) {
    $destination = Join-Path $project $name
    New-Item -ItemType Directory -Force -Path $destination | Out-Null
    foreach ($file in (Get-ChildItem (Join-Path $root $name) -File -Recurse | Where-Object { $_.FullName -notmatch '[\\/](target|node_modules|artifacts)[\\/]' })) {
        $relative = $file.FullName.Substring((Join-Path $root $name).Length + 1)
        $target = Join-Path $destination $relative
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
        Copy-Item $file.FullName $target
    }
}
New-Item -ItemType Directory -Force -Path (Join-Path $project 'instrumentation') | Out-Null
Copy-Item (Join-Path $root 'instrumentation\src') (Join-Path $project 'instrumentation\src') -Recurse -Force
Copy-Item (Join-Path $root 'instrumentation\pom.xml') (Join-Path $project 'instrumentation\pom.xml')
foreach ($name in @('package.json','package-lock.json','tsconfig.json','.gitignore','README.md','LICENSE','Start-UMRA.bat')) { Copy-Item (Join-Path $root $name) (Join-Path $project $name) }
$output = Join-Path $release 'UMRA-1.0.0-source.zip'
Compress-Archive -Path $project -DestinationPath $output -Force
Write-Output "Source package: $output"
