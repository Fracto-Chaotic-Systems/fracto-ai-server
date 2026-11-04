# Workflows

`validate.yml` installs locked dependencies on Node 22 and runs syntax and HTTP
contract tests. Integrated launcher and port-discovery checks live in Fracto's
root test suite; the root Docker build also runs the service's checks.
