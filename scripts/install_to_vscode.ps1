$source = "d:\watchtower"
$dest = "$env:USERPROFILE\.vscode\extensions\watchtower-dev.watchtower-0.1.0"

if (Test-Path $dest) {
    Remove-Item -Recurse -Force $dest
}

Copy-Item -Path $source -Destination $dest -Recurse
Write-Host "Watchtower installed to $dest!"
Write-Host "Please reload your VS Code / Antigravity window (Ctrl+Shift+P -> Developer: Reload Window) to activate it."
