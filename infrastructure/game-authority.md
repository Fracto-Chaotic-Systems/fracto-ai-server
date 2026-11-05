# Game environment authority

An AI explanation or proposed world event is advisory; it does not grant authority to modify game state.
The roadmap requires typed allowlisted game actions, game-rule validation and state-version checks before future AI decisions can change a world.
Frame rendering, movement and collision must remain independent of model latency, with deterministic fallback behavior when inference fails.
Game activity must not grant server administration or starve operational work.
The infrastructure reference skill only retrieves documentation. It does not create environments, edit world definitions, repair data, execute proposed actions or inspect live game state.
Production game-direction behavior remains future roadmap work, not an available capability implied by successful reference retrieval.
