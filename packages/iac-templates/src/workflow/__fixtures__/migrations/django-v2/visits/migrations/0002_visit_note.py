from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("visits", "0001_initial")]

    operations = [
        migrations.AddField(
            model_name="visit",
            name="note",
            field=models.TextField(null=True),
        ),
    ]
