# Windows-local Ollama installation

The Windows pipeline provisions the official standalone Ollama **0.40.14**
package for native x64 or ARM64 Windows and runs `ollama serve` under an independent hidden host controller.
The version-specific URL and SHA-256 are pinned in `ollama_release.json`.
The installer selects `windows_amd64` or `windows_arm64` from the native OS
architecture, including when PowerShell runs under emulation. Both packages use
the same versioned executable and model-storage paths. New installation records
include the architecture; older records are treated as x64. An existing managed
installation for a different architecture is preserved and requires an explicit
migration rather than being overwritten.
No tray application, global PATH change, user environment change, automatic
upgrade or new Windows boot task is installed.

## Automated Fracto startup

The standard Windows production/development launchers, first-run and cold-boot
workflows invoke `scripts/windows_host_startup.js`. It starts the existing host
benchmark observer and the Ollama controller without waiting for downloads or
engine readiness. Native Windows root supervisor and standalone AI service
startup also start the controller. Linux/container processes skip Windows setup.

The controller holds a Windows-session mutex for local port 11434, so repeat
Fracto launches do not start additional engines. If another process already owns
that port, it records `port_in_use` without taking over or terminating it.
The controller and engine remain running when Fracto stops. If the engine exits,
the controller restarts its own child with a delay increasing to 60 seconds.
Installation errors are recorded and retried on a later standard Fracto launch.

Startup is tied to **Fracto startup**, as requested, rather than Windows logon.
A Fracto installation already started by a Windows service can invoke the same
pipeline before login; this change does not create such a service or require
stored login credentials. The pipeline runs with the launching account's existing
permissions and does not bypass PowerShell policy or open firewall rules.

## Storage and configuration

All project-managed files are beneath this checkout's ignored `runtime/ollama/`:

- `0.40.14/`: verified standalone executable and packaged runtime libraries.
- `models/`: persistent local model storage; initially empty.
- `installation.json`: version, official source and verified archive checksum.
- `status.json`: installation/start/readiness status, with generic error codes.
- `logs/`: engine stdout/stderr for local administration, never forwarded to AI.
- The verified release archive is retained for offline reinstall inspection.

Ollama may also create its ordinary per-account configuration/key directory under
the Windows account profile. It is not exported or shared with peers. Model
storage is explicitly redirected to the project-owned directory above. Neither
runtime files nor model weights are included in Git or Docker build context.

The controller applies these settings only to its child process:

| Setting                    | Value                                                     |
| -------------------------- | --------------------------------------------------------- |
| `OLLAMA_HOST`              | `127.0.0.1:11434`                                         |
| `OLLAMA_NO_CLOUD`          | `1`                                                       |
| `OLLAMA_MODELS`            | This checkout's `runtime/ollama/models`                   |
| `OLLAMA_MAX_LOADED_MODELS` | `1`                                                       |
| `OLLAMA_NUM_PARALLEL`      | `1`                                                       |
| `OLLAMA_MAX_QUEUE`         | `16`                                                      |
| `OLLAMA_CONTEXT_LENGTH`    | `4096`                                                    |
| `OLLAMA_KEEP_ALIVE`        | `0` (unload after a request unless explicitly overridden) |

`FRACTO_OLLAMA_ENABLED=false` suppresses new controller launches. It does not stop
an already running controller or engine. Ollama remains independent of Fracto's
required-service readiness; engine installation/failure never prevents ordinary
Fracto service startup.

## Current validation and remaining work

The engine was installed and its loopback API started on the connected 32 GB
development host. This does not provision the other lab hosts remotely; they
receive the same pinned setup through their next standard Windows Fracto startup
after deployment of these changes. First installation needs Internet access,
curl.exe, at least 10 GiB free disk and supported x64 or ARM64 Windows. Subsequent starts
reuse the installation without downloading the package again.

No model is pulled or loaded automatically. The current host has limited available
memory under Fracto load; model downloads, model/license selection, and cold/warm
generation benchmarks remain pending a sufficient resource budget. The candidate
model profile in FIRST_STAGE.md is not an installed or tested inference capability.

The AI service's Ollama adapter is implemented; see `engines/README.md`. The
foundation health `capabilities` list remains empty for compatibility and no
general-purpose prompt endpoint is exposed. The machine-authorized numeric-only
inference API is implemented in `inference/README.md`. `GET /engine/status` separately reports adapter
support and availability. Ollama stays bound to the Windows host's loopback
interface. Docker Compose opts into the verified same-machine Docker Desktop
host-gateway transport; native Windows defaults to loopback. `localhost` inside
a container refers to that container. Keep peer communication
at the Fracto AI API boundary rather than exposing the engine to the LAN.

To inspect the installation locally:

```powershell
Invoke-RestMethod http://127.0.0.1:11434/api/version
Invoke-RestMethod http://127.0.0.1:11434/api/tags
Get-Content .\runtime\ollama\status.json
.\runtime\ollama\0.40.14\ollama.exe list
```

Upgrades require changing the pin deliberately and preparing a versioned migration.
The installer refuses to overwrite a different recorded managed release during
ordinary startup. It verifies the official archive before extracting into a new
version directory. An incomplete/conflicting version directory is preserved for
inspection rather than recursively deleting or overwriting it.

### First installation on ARM64

From this repository on the target Windows host, run:

```powershell
powershell.exe -NoProfile -File .\install_ollama_windows.ps1
powershell.exe -NoProfile -File .\start_ollama_windows.ps1
Get-Content .\runtime\ollama\status.json
```

The first command verifies and installs the architecture-specific pinned package;
the second starts the independent hidden controller. Once status is `ready`,
inspect `/api/version` and `/api/tags` as above. Model download and selection remain
explicit separate steps. ARM64 installer selection is tested with disposable
installation fixtures; execution, acceleration and real-model performance still
require validation on the target ARM64 hardware.

## Sources

- [Official standalone Windows distribution](https://docs.ollama.com/windows)
- [Local-only operation and configuration](https://docs.ollama.com/faq)
- [Pinned release](https://github.com/ollama/ollama/releases/tag/v0.40.14)
