# Orkestr local test installer

This installer starts the prebuilt local-account candidate from PR #419,
commit `e7c3e890b9f10bd2c327d0ecdff4c41d008206ef`. It does not build source.
The published beta.6 still uses its separate setup-token flow.

## Platforms

| Computer | Installer | Docker engine |
| --- | --- | --- |
| Windows | `Install-Orkestr.cmd` or `install-test.ps1` | Docker Desktop, Linux containers |
| Apple Silicon Mac | `Install-Orkestr.command` or `install-test.sh` | Docker Desktop, arm64 |
| Intel Mac | `Install-Orkestr.command` or `install-test.sh` | Docker Desktop, amd64 |
| Linux Intel/AMD | `install-test.sh` | Docker Engine, amd64 |
| Linux ARM64 | `install-test.sh` | Docker Engine, arm64 |

The scripts detect the Docker engine architecture, including Windows ARM
engines, rather than assume it from the host CPU. Windows uses native
PowerShell; Bash is not needed there. Start Docker before running the
installer. Installing Docker itself is a prerequisite, not an installer action.

Download the installer bundle and extract it into a folder. Keep all its
files together. On Windows double-click **Install-Orkestr.cmd**; on Mac open
**Install-Orkestr.command**. Alternatively, from that folder:

Windows PowerShell:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install-test.ps1
```

macOS or Linux:

```sh
bash install-test.sh
```

The Windows launcher sets the execution policy for that process only.
Enterprise policy may still require the administrator's approved script path.

## Obtaining the prebuilt test image

The installer reuses the candidate image if Docker already has it. Otherwise
it looks for the matching image archive in the current folder, the installer
folder and Downloads. It accepts either an extracted `.tar.gz` plus its
`.sha256` receipt, or the original artifact ZIP. With an already signed-in
GitHub CLI, it can download the candidate automatically.

Without the CLI, it opens the matching artifact page. Download the ZIP into
Downloads and run the installer again. GitHub requires sign-in to download
Actions artifacts. No GitHub password or token is requested by the installer.

- [Apple Silicon / ARM64 ZIP](https://github.com/otcan/orkestr/actions/runs/41204535602/artifacts/13043852479)
- [Intel / AMD64 ZIP](https://github.com/otcan/orkestr/actions/runs/41204535602/artifacts/13043533020)

These candidate artifacts expire seven days after the October 31 CI run.
This is a test delivery path. An anonymous one-command registry install
requires a separately approved GHCR release of the new setup flow.

To choose an archive explicitly:

```powershell
.\install-test.ps1 -Archive .\candidate.zip
```

```sh
bash install-test.sh --archive ./candidate.zip
```

## What happens

The installer checks Docker readiness, architecture and the local engine
connection. It verifies the archive SHA256, loads the image, creates the
loopback-only test container and waits for Docker's health check. It then
opens **http://127.0.0.1:19822**. Create your username and password directly,
then choose **Connect models** and sign in to Codex with ChatGPT.

Re-running preserves the existing test container, account and named volumes.
A stopped matching instance is started again. A different container with the
same name or a port conflict produces a clear error; other containers are
not stopped or removed. If an earlier manual test occupies port 19822, stop
that test and rerun the installer.

Stop and start later:

```text
docker stop orkestr-candidate-419
docker start orkestr-candidate-419
```

`--no-open` (Bash) or `-NoOpen` (PowerShell) prints the URL without launching
a browser. The installer does not collect provider credentials, reset state,
upgrade existing instances or delete Docker volumes.

## Validation scope

Subprocess tests run the actual scripts against fake Docker and GitHub CLI
processes. They cover both CPU architectures, ZIP and loose archives, paths
with spaces, checksum refusal, port conflicts, restart, repeat installation,
unrelated-container protection and health failures. Dedicated CI runs them
on Linux, macOS and Windows, including Windows PowerShell 5.1 and PowerShell 7.

The image itself has separate native Linux amd64/arm64 installation and
browser acceptance evidence in PR #419. Those image tests do not establish
end-to-end qualification on every Docker Desktop/host combination. Upgrade,
rollback, restore and machines without Docker remain outside this test
installer's scope.
