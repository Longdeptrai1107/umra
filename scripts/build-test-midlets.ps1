param([string]$MicroEmulator)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\java-tools.ps1"
if (-not $MicroEmulator) { $MicroEmulator = $env:UMRA_MICROEMULATOR }
if (-not $MicroEmulator -or -not (Test-Path $MicroEmulator)) { throw 'Pass -MicroEmulator <path-to-microemulator.jar> or set UMRA_MICROEMULATOR' }
$root = Split-Path -Parent $PSScriptRoot
$javac = Find-UmraJavaTool 'javac'
$jar = Find-UmraJavaTool 'jar'
$java = Join-Path (Split-Path -Parent $javac) 'java.exe'
$target = Join-Path $root 'tests\midlet\target'
New-Item -ItemType Directory -Force -Path $target | Out-Null
$compilerHelp = (& $javac --help 2>&1 | Out-String)
foreach ($fixture in @(@('umratest', 'TestMidlet', 'UMRA A-F Test'), @('independent', 'CommandMidlet', 'UMRA Command Game'), @('obfuscated', 'a', 'UMRA Obfuscated Game'))) {
    $package = $fixture[0]; $class = $fixture[1]; $title = $fixture[2]
    $classes = Join-Path $target "$package-classes"
    New-Item -ItemType Directory -Force -Path $classes | Out-Null
    $options = @('-encoding', 'UTF-8', '-Xlint:-options', '-cp', $MicroEmulator, '-d', $classes)
    if ($compilerHelp -match '--release') { $options += @('--release', '8') } else { $options += @('-source', '8', '-target', '8') }
    & $javac @options "$root\tests\midlet\src\$package\$class.java"
    if ($LASTEXITCODE -ne 0) { throw "Cannot compile $package" }
    # Re-emit the controlled fixture as v48 without modern stack-map frames for the
    # original MicroEmulator ASM preprocessor. Never rewrite a user's game this way.
    & $java -jar "$root\instrumentation\target\umra-agent.jar" legacy-fixture $classes
    if ($LASTEXITCODE -ne 0) { throw "Cannot convert test fixture $package" }
    $manifest = Join-Path $target "$package.mf"
    Set-Content $manifest -Encoding ASCII -Value @('Manifest-Version: 1.0', "MIDlet-Name: $title", 'MIDlet-Version: 1.0.0', 'MIDlet-Vendor: UMRA', "MIDlet-1: $title,,$package.$class", 'MicroEdition-Configuration: CLDC-1.1', 'MicroEdition-Profile: MIDP-2.0', '')
    $output = Join-Path $target "$package.jar"
    & $jar cfm $output $manifest -C $classes .
    if ($LASTEXITCODE -ne 0) { throw "Cannot package $package" }
    Write-Output "Fixture built: $output"
}
