
## Dependency boundaries

Tests import only their owner’s implementation and the `@fracto/sdk` npm exports.
Cross-service integration launches isolated owner fixture executables and uses
HTTP contracts; it never imports another service. See the SDK testing README
for fixture authentication, lifecycle and bounded control requests.
