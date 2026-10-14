import { describe, expect, it } from "vitest";
import { appFacts, healthInput, indentationError, written } from "./__fixtures__/repo";
import { healthRouteEdit } from "./index";

const lines = (...text: string[]) => `${text.join("\n")}\n`;
const django = appFacts({ languages: ["python"], frameworks: ["django"], appKind: "fullstack" });

/** A Django project like `django-admin startproject mysite` writes it. */
function project(
  urls: string,
  settings = lines('ROOT_URLCONF = "mysite.urls"', "MIDDLEWARE = []"),
): Record<string, string> {
  return {
    "manage.py": lines("import os", "import sys"),
    "mysite/__init__.py": "",
    "mysite/settings.py": settings,
    "mysite/urls.py": urls,
    "mysite/wsgi.py": lines("from django.core.wsgi import get_wsgi_application"),
    "polls/views.py": lines("def index(request):", "    pass"),
  };
}

const URLS = lines(
  '"""URL configuration for mysite."""',
  "",
  "from django.contrib import admin",
  "from django.urls import include, path",
  "",
  "urlpatterns = [",
  '    path("admin/", admin.site.urls),',
  '    path("polls/", include("polls.urls")),',
  "]",
);

describe("Django", () => {
  it("adds a view and the first urlpatterns entry in the ROOT_URLCONF module", async () => {
    const edit = await healthRouteEdit(healthInput("django", django, project(URLS)));
    expect(edit).toMatchObject({ action: "write", framework: "Django", path: "mysite/urls.py" });
    const content = written(edit, "mysite/urls.py");
    expect(content).toBe(
      lines(
        '"""URL configuration for mysite."""',
        "",
        "from django.contrib import admin",
        "from django.urls import include, path",
        "from django.http import JsonResponse",
        "",
        "",
        "def health(request):",
        '    return JsonResponse({"status": "ok"})',
        "",
        "",
        "urlpatterns = [",
        '    path("health", health),',
        '    path("admin/", admin.site.urls),',
        '    path("polls/", include("polls.urls")),',
        "]",
      ),
    );
    expect(indentationError(content)).toBeUndefined();
    expect(edit.action === "write" && edit.note).toBe(
      'Added GET /health to mysite/urls.py by OpsCrew, first in urlpatterns: a small view answers {"status":"ok"} for the deploy health check.',
    );
  });

  it("keeps a trailing slash the plan asks for, and an existing route", async () => {
    const slash = await healthRouteEdit(healthInput("django", django, project(URLS), "/health/"));
    expect(written(slash, "mysite/urls.py")).toContain('    path("health/", health),\n');
    const routed = lines(
      "from django.urls import path",
      "from . import views",
      "",
      'urlpatterns = [path("health/", views.health)]',
    );
    expect(
      await healthRouteEdit(healthInput("django", django, project(routed), "/health/")),
    ).toEqual({
      action: "none",
      reason: "mysite/urls.py already routes /health/; OpsCrew left it as it is.",
    });
    const other = await healthRouteEdit(healthInput("django", django, project(routed)));
    expect(other).toMatchObject({ action: "manual" });
    expect(other.action === "manual" && other.reason).toContain(
      "mysite/urls.py already routes /health/, but the plan checks /health",
    );
  });

  it("exempts the view from LoginRequiredMiddleware and imports path when only re_path is used", async () => {
    const urls = lines(
      "from django.urls import re_path",
      "",
      'urlpatterns = [re_path(r"^$", home)]',
    );
    const settings = lines(
      "ROOT_URLCONF = 'mysite.urls'",
      "MIDDLEWARE = ['django.contrib.auth.middleware.LoginRequiredMiddleware']",
      "SECURE_SSL_REDIRECT = True",
    );
    const edit = await healthRouteEdit(healthInput("django", django, project(urls, settings)));
    const content = written(edit, "mysite/urls.py");
    expect(content).toBe(
      lines(
        "from django.urls import re_path",
        "from django.http import JsonResponse",
        "from django.urls import path",
        "from django.contrib.auth.decorators import login_not_required",
        "",
        "",
        "@login_not_required",
        "def health(request):",
        '    return JsonResponse({"status": "ok"})',
        "",
        "",
        'urlpatterns = [path("health", health), re_path(r"^$", home)]',
      ),
    );
    expect(indentationError(content)).toBeUndefined();
    expect(edit.action === "write" && edit.checks[0]).toContain("SECURE_SSL_REDIRECT");
  });

  it("leaves unclear settings and urlpatterns to the agent", async () => {
    const two = {
      ...project(URLS),
      "mysite/settings_prod.py": lines('ROOT_URLCONF = "mysite.prod_urls"'),
      // Test settings are not the app's.
      "mysite/settings_test.py": lines('ROOT_URLCONF = "mysite.test_urls"'),
    };
    const ambiguous = await healthRouteEdit(healthInput("django", django, two));
    expect(ambiguous.action === "manual" && ambiguous.reason).toContain(
      "the Django settings name different root URLconfs",
    );
    const computed = await healthRouteEdit(
      healthInput("django", django, project(lines("urlpatterns = build_patterns()"))),
    );
    expect(computed).toEqual({
      action: "manual",
      reason: "urlpatterns in mysite/urls.py is not a plain list, so OpsCrew did not edit it.",
    });
    const none = await healthRouteEdit(
      healthInput("django", django, project(URLS, lines("DEBUG = True"))),
    );
    expect(none).toEqual({
      action: "manual",
      reason: "OpsCrew found no ROOT_URLCONF in the Django settings.",
    });
  });
});
