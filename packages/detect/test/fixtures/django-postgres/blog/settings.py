import os

SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY")
DEBUG = os.getenv("DJANGO_DEBUG") == "1"
ALLOWED_HOSTS = os.environ.get("DJANGO_ALLOWED_HOSTS", "").split(",")

INSTALLED_APPS = ["django.contrib.admin", "django.contrib.auth", "django.contrib.contenttypes"]
ROOT_URLCONF = "blog.urls"
WSGI_APPLICATION = "blog.wsgi.application"

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": os.environ.get("POSTGRES_DB", "blog"),
        "HOST": os.environ.get("POSTGRES_HOST", "localhost"),
    }
}

TEMPLATES = [{"BACKEND": "django.template.backends.django.DjangoTemplates", "DIRS": ["templates"]}]
