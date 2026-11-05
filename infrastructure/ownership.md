# Fracto infrastructure ownership

The root supervisor owns local process startup, ordered service readiness and shutdown.
The data service owns persistent application records and database-backed data operations.
The tiles service owns numerical tile access, the compiled tile index, mesh inventory and terrain cache jobs.
The asset service renders and publishes image and video assets.
The UI provides browser views and game environment presentation; it consumes service data.
The admin service provides administrative status, logs and version reporting.
The AI service provides bounded inference, local knowledge and explicitly authorized peer collaboration.
Infrastructure reference knowledge does not transfer ownership or permission to change another service's data.
