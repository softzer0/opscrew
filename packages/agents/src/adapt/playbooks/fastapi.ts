import type { Playbook } from "./types";

/** FastAPI apps served by uvicorn. */
export const fastapiPlaybook: Playbook = {
  id: "fastapi",
  title: "FastAPI (uvicorn)",
  guidance: [
    "The container starts uvicorn with `--host 0.0.0.0` on the PORT environment variable (default 8000) as a non-root user, so the app object must be importable without side effects such as opening network ports.",
    "Read configuration with `os.environ` (or the app's existing settings class) at start-up.",
  ],
  steps: {
    "health-endpoint":
      'Add `@app.get("/health")` returning `{"status": "ok"}` in the listed file, on the same `FastAPI()` instance the app serves. Do not add dependencies such as database sessions or authentication to it.',
    "port-config":
      'If the file calls `uvicorn.run(...)` with a literal port, read it from the environment instead: `port=int(os.environ.get("PORT", "<current port>"))` and `host="0.0.0.0"`, keeping the call under `if __name__ == "__main__":`.',
    "build-config":
      "Make sure `uvicorn` and every runtime dependency are listed in requirements.txt or pyproject.toml, so the image can install them without development extras.",
    "secret-removal":
      'Replace the hard-coded value with `os.environ["NAME"]` (or a field on the existing pydantic settings class without a default). Say in your notes that the exposed value must be rotated.',
  },
  checks: {
    "health-endpoint": ['`GET /health` returns 200 and `{"status": "ok"}`.'],
    "port-config": ['No literal port remains in `uvicorn.run`; the host is "0.0.0.0".'],
  },
};
