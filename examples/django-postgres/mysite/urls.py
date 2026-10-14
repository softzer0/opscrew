from django.urls import path

from visits import views

urlpatterns = [
    path("", views.index),
    path("health/", views.health),
]
