from django.http import HttpResponse
from django.urls import path
from django.views.generic import TemplateView

urlpatterns = [
    path("", TemplateView.as_view(template_name="home.html")),
    path("healthz/", lambda request: HttpResponse("ok")),
]
