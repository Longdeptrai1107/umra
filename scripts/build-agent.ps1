$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\java-tools.ps1"
$root = Split-Path -Parent $PSScriptRoot
$project = Join-Path $root 'instrumentation'
$javac = Find-UmraJavaTool 'javac'
$jarTool = Find-UmraJavaTool 'jar'
$version = '1.18.17'
$lib = Join-Path $project "lib\byte-buddy-$version.jar"
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $lib) | Out-Null
if (-not (Test-Path $lib)) {
    $download = "$lib.download"
    Invoke-WebRequest -UseBasicParsing "https://repo.maven.apache.org/maven2/net/bytebuddy/byte-buddy/$version/byte-buddy-$version.jar" -OutFile $download
    Move-Item $download $lib -Force
}
$expected = (Invoke-WebRequest -UseBasicParsing "https://repo.maven.apache.org/maven2/net/bytebuddy/byte-buddy/$version/byte-buddy-$version.jar.sha256").Content.Trim()
if ((Get-FileHash $lib -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected.ToLowerInvariant()) { throw 'Byte Buddy SHA256 mismatch' }
$build = Join-Path $project ('target\build-' + [guid]::NewGuid().ToString('N'))
$classes = Join-Path $build 'classes'
New-Item -ItemType Directory -Force -Path $classes | Out-Null
$sources = @(Get-ChildItem "$project\src\main\java" -Recurse -Filter '*.java' | ForEach-Object { $_.FullName })
$compilerHelp = (& $javac --help 2>&1 | Out-String)
$options = @('-encoding', 'UTF-8', '-Xlint:-options', '-cp', $lib, '-d', $classes)
if ($compilerHelp -match '--release') { $options += @('--release', '8') } else { $options += @('-source', '8', '-target', '8') }
& $javac @options @sources
if ($LASTEXITCODE -ne 0) { throw 'Agent compilation failed' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($lib)
try {
    foreach ($entry in $zip.Entries) {
        if (-not $entry.Name -or $entry.FullName -eq 'META-INF/MANIFEST.MF' -or $entry.FullName -match '^META-INF/.*\.(SF|RSA|DSA)$') { continue }
        $destination = Join-Path $classes $entry.FullName
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destination, $true)
    }
} finally { $zip.Dispose() }
$manifest = Join-Path $build 'MANIFEST.MF'
Set-Content $manifest -Encoding ASCII -Value @('Manifest-Version: 1.0', 'Main-Class: umra.tools.JarTool', 'Premain-Class: umra.agent.Agent', 'Agent-Class: umra.agent.Agent', 'Can-Retransform-Classes: true', 'Can-Redefine-Classes: true', 'Multi-Release: true', '')
$output = Join-Path $project 'target\umra-agent.jar'
& $jarTool cfm $output $manifest -C $classes .
if ($LASTEXITCODE -ne 0) { throw 'Agent packaging failed' }
Write-Output "Agent built: $output"
