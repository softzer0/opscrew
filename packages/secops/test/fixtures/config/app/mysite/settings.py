import os

SECRET_KEY = os.environ["DJANGO_SECRET_KEY"]

DEBUG = True

INSTALLED_APPS = [
    "django.contrib.admin",
    "corsheaders",
]

CORS_ALLOW_ALL_ORIGINS = True

# Sessions are shared with the frontend.
SESSION_COOKIE_SECURE = True

CORS_ALLOW_CREDENTIALS = True
