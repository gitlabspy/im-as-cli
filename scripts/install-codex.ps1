param(
    [switch]$Link
)

$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent $PSScriptRoot
$SkillName = "remote-agent-control"
$CoreDirName = "Claude-to-IM"
$InstallHome = if ($env:REMOTE_AGENT_CONTROL_INSTALL_HOME) { $env:REMOTE_AGENT_CONTROL_INSTALL_HOME } else { $HOME }
$SkillsDir = Join-Path $InstallHome ".codex\skills"
$CoreSourceDir = Join-Path $RootDir $CoreDirName
$SkillSourceDir = Join-Path $RootDir "Claude-to-IM-skill"
$CoreTargetDir = Join-Path $SkillsDir $CoreDirName
$SkillTargetDir = Join-Path $SkillsDir $SkillName

function Copy-ProjectDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    Get-ChildItem -LiteralPath $Source -Force | Where-Object {
        $_.Name -notin @(".git", "node_modules", "dist") -and $_.Name -notlike "*.tgz"
    } | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $Destination -Recurse -Force
    }
}

function Link-Or-CopyDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination,
        [switch]$UseLink
    )

    if (Test-Path -LiteralPath $Destination) {
        Write-Host "Already installed at $Destination"
        Write-Host "To reinstall, remove it first."
        return
    }

    if ($UseLink) {
        New-Item -ItemType Junction -Path $Destination -Target $Source | Out-Null
        Write-Host "Linked: $Destination -> $Source"
    } else {
        Copy-ProjectDirectory -Source $Source -Destination $Destination
        Write-Host "Copied: $Destination"
    }
}

if (!(Test-Path -LiteralPath (Join-Path $CoreSourceDir "package.json"))) {
    throw "Core package not found at $CoreSourceDir"
}

if (!(Test-Path -LiteralPath (Join-Path $SkillSourceDir "SKILL.md"))) {
    throw "Skill package not found at $SkillSourceDir"
}

New-Item -ItemType Directory -Force -Path $SkillsDir | Out-Null

Write-Host "Installing Remote Agent Control for Codex..."
Link-Or-CopyDirectory -Source $CoreSourceDir -Destination $CoreTargetDir -UseLink:$Link

Write-Host "Installing core dependencies..."
Push-Location $CoreTargetDir
npm install
npm run build
Pop-Location

Link-Or-CopyDirectory -Source $SkillSourceDir -Destination $SkillTargetDir -UseLink:$Link

Write-Host "Installing skill dependencies..."
Push-Location $SkillTargetDir
npm install
npm run build
npm prune --production
Pop-Location

Write-Host ""
Write-Host "Done. Start a new Codex session and use:"
Write-Host "  remote-agent-control setup"
Write-Host "  remote-agent-control start"
Write-Host "  remote-agent-control doctor"
