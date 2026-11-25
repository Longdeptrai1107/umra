function Find-UmraJavaTool([string]$Tool) {
    if ($env:JAVA_HOME -and (Test-Path "$env:JAVA_HOME\bin\$Tool.exe")) { return "$env:JAVA_HOME\bin\$Tool.exe" }
    $command = Get-Command $Tool -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    foreach ($base in @('C:\Program Files\Java', 'C:\Program Files\Eclipse Adoptium', 'C:\Program Files\Microsoft', "$env:USERPROFILE\.jdks")) {
        if (Test-Path $base) {
            foreach ($dir in (Get-ChildItem $base -Directory | Sort-Object Name -Descending)) {
                $candidate = Join-Path $dir.FullName "bin\$Tool.exe"
                if (Test-Path $candidate) { return $candidate }
            }
        }
    }
    throw "Cannot find $Tool. Install JDK 8+ and set JAVA_HOME."
}
