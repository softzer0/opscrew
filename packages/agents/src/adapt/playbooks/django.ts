import type { Playbook } from "./types";

/** Django apps served by gunicorn. */
export const djangoPlaybook: Playbook = {
  id: "django",
  title: "Django (gunicorn)",
  guidance: [
    "The container runs `collectstatic` at build time and starts gunicorn with `<project>.wsgi` as a non-root user.",
    "Production settings come from environment variables: SECRET_KEY, DEBUG, ALLOWED_HOSTS and CSRF_TRUSTED_ORIGINS.",
  ],
  steps: {
    "health-endpoint":
      'Add a view `def health(request): return JsonResponse({"status": "ok"})` and route it with `path("health", health)` in the root urls.py. It must not query the database or require login.',
    "port-config":
      "gunicorn binds to the PORT environment variable in the container. Remove any literal port from `runserver` calls in production code paths.",
    "build-config":
      'In settings, read `SECRET_KEY = os.environ["SECRET_KEY"]`, `DEBUG = os.environ.get("DEBUG", "") == "1"` and `ALLOWED_HOSTS` from a comma-separated environment variable, set `STATIC_ROOT` so `collectstatic` works, and make sure gunicorn is listed in the requirements.',
    "secret-removal":
      'Replace the hard-coded value with `os.environ["NAME"]` in settings and read it from `django.conf.settings` elsewhere. Say in your notes that the exposed value must be rotated.',
  },
  checks: {
    "health-endpoint": ["`GET /health` returns 200 without a database query or login."],
    "build-config": [
      "`python manage.py collectstatic --noinput` succeeds with DEBUG unset.",
      "SECRET_KEY, DEBUG and ALLOWED_HOSTS come from the environment.",
    ],
  },
};
