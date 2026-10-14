from django.http import JsonResponse

from .models import Visit


def index(request):
    """Records a visit in Postgres and returns the total."""
    Visit.objects.create()
    return JsonResponse({"visits": Visit.objects.count()})


def health(request):
    """Liveness check; it does not touch the database."""
    return JsonResponse({"status": "ok"})
