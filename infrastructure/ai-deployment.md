# Independent AI deployment

Each AI node owns a complete local engine, model files and persistent stores. Model execution is not split across servers.
Ollama is the first implemented engine adapter; other registered adapters remain unavailable until implemented and tested.
Ollama remains private to the host; authenticated peer communication uses the Fracto AI boundary rather than direct remote engine access.
Bounded inference has one active generation and a limited pending queue. Resource admission can reject work while ordinary Fracto readiness remains healthy.
Knowledge reference retrieval uses SQLite full-text search and requires no model inference or model memory allocation.
Knowledge persists separately from short-lived inference job history. Imported peer artifacts remain evidence, never permissions or executable instructions.
