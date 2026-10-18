//! A minimal axum API for OpsCrew's builder examples.
use axum::{Json, Router, routing::get};
use serde_json::{Value, json};

#[tokio::main]
async fn main() {
    let port = std::env::var("PORT").unwrap_or_else(|_| "8080".to_string());
    let app = Router::new()
        .route("/health", get(|| async { Json(json!({ "status": "ok" })) }))
        .route("/", get(root));
    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{port}")).await.unwrap();
    println!("Listening on port {port}");
    axum::serve(listener, app).await.unwrap();
}

async fn root() -> Json<Value> {
    Json(json!({ "message": "Hello from Rust" }))
}
