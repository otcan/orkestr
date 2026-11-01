# Orkestr terminal installer: macOS and Linux

The first installer delivery targets macOS Terminal (Intel and Apple Silicon)
and Linux terminals (amd64 and ARM64). Native Windows installation remains
planned for a follow-up; it is not part of this delivery.

This installs the prebuilt local-account candidate from PR #419, commit
`e7c3e890b9f10bd2c327d0ecdff4c41d008206ef`, without building source. Start
Docker Desktop on Mac or Docker Engine on Linux before running it. Installing
Docker itself is a prerequisite, not an installer action.

## Run

Download `install-test.sh` and run it in your terminal:

```sh
bash install-test.sh
```

The script works with the default macOS Bash 3.2; installing a newer shell is
not required. No root access is needed. Docker engine architecture selects
the image automatically, including Apple Silicon.

It prints progress before checking Docker. An engine that fails to answer is
reported after ten seconds instead of leaving the terminal apparently idle.
On Mac, open Docker Desktop and wait for the engine to run; if startup is
stuck, use **Troubleshoot > Restart Docker Desktop**, then rerun the installer.
Subsequent Docker checks are bounded too. Image loading and downloads have
longer limits and named progress stages. Ctrl+C reaps the installer-owned CLI
process without stopping or deleting existing containers or volumes.

To download this script from its reviewed GitHub commit, use curl's
`--connect-timeout 10 --max-time 60` options and leave its progress display
enabled, so a stalled network download is visible and bounded too.

The installer reuses a candidate image already loaded into Docker. Otherwise
it looks for a matching ZIP or `.tar.gz` in the current folder, the installer
folder and Downloads. With an already signed-in GitHub CLI it downloads the
image automatically. Without that CLI it opens the matching download page:
download the ZIP into Downloads and run the installer again. GitHub requires
sign-in to download Actions artifacts; the installer never asks for a GitHub
password or token.

- [Apple Silicon / ARM64 ZIP](https://github.com/otcan/orkestr/actions/runs/41204535602/artifacts/13043852479)
- [Intel / AMD64 ZIP](https://github.com/otcan/orkestr/actions/runs/41204535602/artifacts/13043533020)

These candidate artifacts expire seven days after the October 31 CI run.
An anonymous registry-based installer of the new account flow requires a
separately approved public release.

Select an archive explicitly if needed:

```sh
bash install-test.sh --archive ./candidate.zip
```

The ZIP's image and checksum are streamed into fixed temporary files;
untrusted ZIP paths and symlink attributes do not control extraction.
SHA256 is checked before Docker loads the archive.

## Setup and repeat runs

The installer starts the test at **http://127.0.0.1:19822**, waits for Docker's
health check and opens the browser. Choose a username and password directly,
then choose **Connect models** and sign in to Codex with ChatGPT. A setup token
does not need to be copied from logs.

Re-running preserves the account, container and named volumes. It restarts a
stopped matching test. A different installation with the same name or a port
conflict produces a specific error; other containers are not stopped or
removed. Stop an earlier manual test if it occupies port 19822, then rerun.
The installer also rejects a remote Docker context because the local browser
URL would point at the wrong computer.

```text
docker stop orkestr-candidate-419
docker start orkestr-candidate-419
```

`--no-open` prints the URL without launching a browser. The installer does
not collect provider credentials, reset state, upgrade an existing instance
or delete Docker volumes. `Install-Orkestr.command` is an optional Mac launcher
when the scripts are distributed together with executable permissions.

## Validation and next platforms

Native macOS and Linux CI execute the actual Bash script against fake Docker
and GitHub CLI processes. Cases cover both CPU architectures, ZIP and loose
archives, paths with spaces, checksum and architecture refusal, port conflicts,
repeat installation, restart, unrelated-container protection and health failure.
The default shell's syntax is checked separately before these tests.

The image has separate native Linux amd64/arm64 fresh-install and browser
acceptance evidence in PR #419. This does not establish qualification of every
Docker Desktop and host combination. Upgrade, rollback, restore, Windows
installation and machines without Docker are outside this first delivery.
Windows PowerShell work is preserved for the next platform step.
