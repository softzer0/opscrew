import os

from flask import Flask

app = Flask(__name__)
app.config["DEBUG"] = os.environ.get("FLASK_DEBUG") == "1"

if __name__ == "__main__":
    # app.run(debug=True)
    app.run(debug=False)
