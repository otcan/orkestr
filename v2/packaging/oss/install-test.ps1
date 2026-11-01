# PowerShell 5.1+ / Windows and PowerShell 7+. No administrator access required.
[CmdletBinding()]
param(
    [string]$Archive,
    [switch]$NoOpen,
    [ValidateRange(0, 600)][int]$ReadySeconds = 120
)
$ErrorActionPreference = 'Stop'
$CandidateCommit = 'e7c3e890b9f10bd2c327d0ecdff4c41d008206ef'
$CandidateRun = '41204535602'
$CandidateImage = "orkestr-oss-test:$CandidateCommit"
$InstallerContainer = 'orkestr-candidate-419'
$TemporaryDirectory = $null

function Invoke-Tool {
    param([string]$Tool, [string[]]$Arguments)
    $ErrorActionPreference = 'Continue'
    $ToolOutput = & $Tool @Arguments 2>&1
    $ToolExitCode = $LASTEXITCODE
    [pscustomobject]@{ Ok = ($ToolExitCode -eq 0); Text = (($ToolOutput | ForEach-Object { "$_" }) -join "`n").Trim() }
}
function Get-Docker {
    param([string[]]$Arguments, [string]$Failure)
    $Result = Invoke-Tool 'docker' $Arguments
    if (-not $Result.Ok) { throw $Failure }
    $Result.Text
}
function Open-InstallerPage {
    param([string]$Url)
    if (-not $NoOpen) { try { Start-Process $Url | Out-Null } catch { Write-Host "Open $Url in your browser." } }
}

try {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        throw 'Install Docker Desktop, start it in Linux containers mode, then run this installer again.'
    }
    $Engine = Get-Docker @('info', '--format', '{{.OSType}}|{{.Architecture}}') 'Start Docker Desktop or your Docker service, then run this installer again.'
    switch ($Engine) {
        { $_ -in @('linux|amd64', 'linux|x86_64') } { $EngineArchitecture = 'amd64'; break }
        { $_ -in @('linux|arm64', 'linux|aarch64') } { $EngineArchitecture = 'arm64'; break }
        default { throw 'Switch Docker Desktop to Linux containers. This candidate needs a Linux amd64 or arm64 engine.' }
    }
    $DockerEndpoint = $env:DOCKER_HOST
    if (-not $DockerEndpoint) {
        $DockerEndpoint = Get-Docker @('context', 'inspect', '--format', '{{.Endpoints.docker.Host}}') 'Could not inspect the Docker connection.'
    }
    if ($DockerEndpoint -notmatch '^(unix://|npipe://|tcp://(127\.0\.0\.1|localhost):)') {
        throw 'Select a Docker engine on this computer; remote Docker contexts are not supported by the local installer.'
    }
    # JSON avoids nested Go-template quoting differences in Windows PowerShell 5.1.
    $Existing = Invoke-Tool 'docker' @('container', 'inspect', $InstallerContainer)
    if ($Existing.Ok) {
        try { $ContainerRecord = @($Existing.Text | ConvertFrom-Json)[0] }
        catch { throw 'Could not inspect the existing container. It was left unchanged.' }
        $Ports = @($ContainerRecord.HostConfig.PortBindings.'19823/tcp')
        if ($ContainerRecord.Config.Image -ne $CandidateImage -or $Ports.Count -ne 1 -or
            $Ports[0].HostIp -ne '127.0.0.1' -or $Ports[0].HostPort -ne '19822' -or
            $ContainerRecord.Config.Env -notcontains 'ORKESTR_OSS_LOCAL_SETUP=1') {
            throw "Container $InstallerContainer belongs to a different installation. It was left unchanged."
        }
    }
    if (-not $Existing.Ok) {
        $Bindings = Get-Docker @('ps', '--format', '{{.Names}}|{{.Ports}}') 'Could not check Docker port usage.'
        $Occupied = (($Bindings -split '\r?\n' | Where-Object { $_ -match ':19822->' } | ForEach-Object { $_.Split('|')[0] }) -join ', ')
        if ($Occupied) { throw "Port 19822 is already used by $Occupied. Stop that container, then run this installer again." }
        $ImagePlatform = Invoke-Tool 'docker' @('image', 'inspect', '--format', '{{.Os}}|{{.Architecture}}', $CandidateImage)
        if (-not $ImagePlatform.Ok) {
            $ArchiveName = "orkestr-oss-test-$EngineArchitecture.tar.gz"
            $ArtifactName = "v2-test-image-$EngineArchitecture-$CandidateRun"
            $ArtifactId = if ($EngineArchitecture -eq 'arm64') { '13043852479' } else { '13043533020' }
            $ArtifactUrl = "https://github.com/otcan/orkestr/actions/runs/$CandidateRun/artifacts/$ArtifactId"
            if (-not $Archive) {
                $Downloads = Join-Path ([Environment]::GetFolderPath('UserProfile')) 'Downloads'
                :Search foreach ($Folder in @((Get-Location).Path, $PSScriptRoot, $Downloads)) {
                    foreach ($FileName in @($ArchiveName, "$ArtifactName.zip")) {
                        $PossibleArchive = Join-Path $Folder $FileName
                        if (Test-Path -LiteralPath $PossibleArchive -PathType Leaf) { $Archive = $PossibleArchive; break Search }
                    }
                }
            }
            $TemporaryDirectory = Join-Path ([IO.Path]::GetTempPath()) ('orkestr-install-' + [Guid]::NewGuid().ToString('N'))
            New-Item -ItemType Directory -Path $TemporaryDirectory | Out-Null
            if (-not $Archive) {
                $GhCommand = Get-Command gh -ErrorAction SilentlyContinue
                if ($GhCommand -and (Invoke-Tool 'gh' @('auth', 'status')).Ok) {
                    Write-Host "Downloading the prebuilt $EngineArchitecture test image..."
                    $Downloaded = Invoke-Tool 'gh' @('run', 'download', $CandidateRun, '--repo', 'otcan/orkestr', '--name', $ArtifactName, '--dir', $TemporaryDirectory)
                    if (-not $Downloaded.Ok) { throw "Download failed. Download the ZIP at $ArtifactUrl and run the installer again." }
                    $Archive = Join-Path $TemporaryDirectory $ArchiveName
                } else {
                    Write-Host "Download this ZIP to Downloads, then run this installer again: $ArtifactUrl"
                    Open-InstallerPage $ArtifactUrl
                    throw 'This unpublished test image needs a GitHub download. An existing signed-in gh CLI can download it automatically.'
                }
            }
            if (-not (Test-Path -LiteralPath $Archive -PathType Leaf)) { throw 'The selected archive does not exist.' }
            if ($Archive.EndsWith('.zip', [StringComparison]::OrdinalIgnoreCase)) {
                # Extract only the two fixed files, never arbitrary ZIP paths.
                Add-Type -AssemblyName System.IO.Compression.FileSystem
                $ZipArchive = [IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $Archive).Path)
                try {
                    foreach ($EntryName in @($ArchiveName, "$ArchiveName.sha256")) {
                        $Entry = $ZipArchive.GetEntry($EntryName)
                        if (-not $Entry) { throw 'The ZIP does not contain the image for this Docker architecture.' }
                        [IO.Compression.ZipFileExtensions]::ExtractToFile($Entry, (Join-Path $TemporaryDirectory $EntryName), $true)
                    }
                } finally { $ZipArchive.Dispose() }
                $Archive = Join-Path $TemporaryDirectory $ArchiveName
            } elseif (-not $Archive.EndsWith('.tar.gz', [StringComparison]::OrdinalIgnoreCase)) {
                throw 'Select the downloaded ZIP or .tar.gz image archive.'
            }
            if (-not (Test-Path -LiteralPath "$Archive.sha256" -PathType Leaf)) { throw 'Keep the .sha256 file beside the image archive.' }
            $Receipt = (Get-Content -LiteralPath "$Archive.sha256" -Raw).Trim()
            if ($Receipt -notmatch ('^([a-fA-F0-9]{64})  ' + [regex]::Escape($ArchiveName) + '$')) { throw 'Invalid image checksum receipt.' }
            $ExpectedHash = $Matches[1]
            if ((Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash -ne $ExpectedHash) { throw 'Image checksum mismatch. Download the archive again.' }
            Write-Host 'Loading the checked image into Docker...'
            Get-Docker @('load', '-i', $Archive) 'Docker could not load the checked image.' | Out-Null
            $ImagePlatform = Invoke-Tool 'docker' @('image', 'inspect', '--format', '{{.Os}}|{{.Architecture}}', $CandidateImage)
        }
        if (-not $ImagePlatform.Ok -or $ImagePlatform.Text -ne "linux|$EngineArchitecture") { throw 'The loaded image does not match this Docker architecture or candidate.' }
        Write-Host 'Starting your local Orkestr test...'
        Get-Docker @('run', '-d', '--name', $InstallerContainer, '--label', 'org.orkestr.installer=docker-test-v1',
            '--cap-add', 'SYS_PTRACE', '-e', 'ORKESTR_OSS_LOCAL_SETUP=1', '-p', '127.0.0.1:19822:19823',
            '-v', 'orkestr-419-state:/state', '-v', 'orkestr-419-credentials:/credentials', $CandidateImage) 'Docker could not start Orkestr. Port 19822 may be in use; no existing data was removed.' | Out-Null
    } else {
        $Running = Get-Docker @('container', 'inspect', '--format', '{{.State.Running}}', $InstallerContainer) 'Could not inspect the existing test.'
        if ($Running -ne 'true') { Get-Docker @('start', $InstallerContainer) 'Could not restart the existing test. Check whether port 19822 is occupied.' | Out-Null }
    }
    Write-Host 'Waiting for Orkestr to become healthy...'
    $Deadline = [DateTime]::UtcNow.AddSeconds($ReadySeconds)
    while ($true) {
        $Health = Get-Docker @('container', 'inspect', '--format', '{{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}', $InstallerContainer) 'Could not inspect startup.'
        if ($Health -eq 'true|healthy') { break }
        if ($Health.StartsWith('false|') -or $Health -eq 'true|unhealthy') { throw 'The test container stopped or became unhealthy. Its data is preserved.' }
        if ([DateTime]::UtcNow -ge $Deadline) { throw 'Startup is taking longer than expected. Data is preserved; run this installer again to recheck.' }
        Start-Sleep -Seconds 2
    }
    Write-Host "`nOrkestr is ready: http://127.0.0.1:19822"
    Write-Host 'Create your account, then choose Connect models.'
    Write-Host "Stop: docker stop $InstallerContainer"
    Write-Host "Start: docker start $InstallerContainer"
    Open-InstallerPage 'http://127.0.0.1:19822'
} catch {
    Write-Host "Orkestr: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
} finally {
    if ($TemporaryDirectory -and (Test-Path -LiteralPath $TemporaryDirectory)) { Remove-Item -LiteralPath $TemporaryDirectory -Recurse -Force }
}
