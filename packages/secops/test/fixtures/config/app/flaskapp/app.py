from flask import Flask
from flask_cors import CORS

app = Flask(__name__)
CORS(app, origins="*", supports_credentials=True)


@app.get("/")
def index():
    return "ok"


if __name__ == "__main__":
    app.run(
        host="0.0.0.0",
        port=int("5000"),
        debug=True,
    )
