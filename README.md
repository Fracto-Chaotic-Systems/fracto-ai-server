# Fracto AI server

Independent Node 22 / Express service at `servers/fracto-ai-server/`. This is
the foundation for Fracto's future operations coordinator and AI game director.
The phased implementation plan is [ROADMAP.md](ROADMAP.md).

## Current stage

Only process health is implemented. No model is loaded, no provider is called,
no jobs are executed, and no remote data is synchronized. Startup requires no
model credentials, GPU, database connection, or additional persistent volume.
An empty `capabilities` list explicitly describes this stage.

| Endpoint       | Behavior                                                        |
| -------------- | --------------------------------------------------------------- |
| `GET /`        | Health response; compatible with ordinary Fracto service probes |
| `GET /healthz` | Process liveness, HTTP 200                                      |
| `GET /readyz`  | Foundation readiness, HTTP 200                                  |

Responses contain only `contract_version`, `service`, `status`, `stage`,
`capabilities`, and `uptime_seconds`, with `Cache-Control: no-store`. Unknown
paths and unsupported operations return a generic JSON 404. These read-only
health endpoints are public; there is no operational or inference API yet.
Adding any such API requires scoped machine authorization and field allowlists
before exposing it. Do not inherit browser sessions or forward raw logs.

## Run and build

From this directory: `npm ci`, `npm run check`, then `npm start`. Use `npm run dev`
for Node watch mode. From the Fracto root, the supported full-stack entry point
is `npm start`; an isolated supervised launch is
`node scripts/launch_service.js fracto-ai-server`.

`FRACTO_AI_PORT` selects a TCP port (1–65535), default 3007; development Compose
sets 3107. The listener binds to all container interfaces, like the other
backend services. Production Compose publishes it on host loopback only.
The nginx example maps `/api/ai/` to this listener. stdout/stderr are captured
by the supervisor in dated `logs/fracto-ai-server-log-YYYY-MM-DD.txt` files;
the root log API accepts `service=ai`. SIGINT/SIGTERM close the listener.

The root Dockerfile installs this service's locked dependencies, runs its
checks in the build stage, and includes it in production and development.
Port discovery, preflight, readiness, repository updates, build revisions,
Admin status/Reference/Commits, and coordinated milestone tags include it.
Health is local to this process; it does not imply any future AI capability
or fleet dependency is available.

## Files and ownership

- `app.js`: side-effect-free app factory, health contract, port validation.
- `index.js`: listener startup and bounded shutdown.
- `app.test.js`: HTTP contract, no identity echo, unsupported actions, port validation.
- `package.json` / `package-lock.json`: independent scripts and locked dependencies.
- `ROADMAP.md`: scope, boundaries, staged deliverables and acceptance criteria.
- `.gitignore`: local dependencies, credentials and future runtime artifacts.
- `LICENSE`: the license from the repository's initial commit, preserved.
- `.github/workflows/validate.yml`: independent Node 22 validation on pushes and pull requests.

This folder is an independent Git checkout, not part of the root repository.
Keep it directly under `servers/`. Commit its source here; commit supervisor,
Docker, Compose and shared integration changes in the root checkout, and Admin/UI
changes in their respective repositories. Follow the root PROJECT_GUIDELINES.md,
especially its prohibition on personal information crossing APIs.

For initial repository publication, create the remote as `fracto-ai-server`,
publish this source, and configure a tracking branch before ordinary `npm start`.
The root prestart updater intentionally rejects missing upstreams, uncommitted
tracked changes, and divergent branches. An empty remote is not a deployable
service release. Existing installations must check out this sixth service and
update Admin and the root together before rebuilding.
