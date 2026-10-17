//! Simple HTTP server for benchmark fixtures

use axum::{response::IntoResponse, routing::get, Router};
use std::net::SocketAddr;
use tokio::signal;

async fn shutdown_signal() {
    let terminate = signal::ctrl_c();
    terminate.await.unwrap();
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let app = Router::new()
        .route("/", get(root))
        .route("/fixture1", get(fixture1))
        .route("/fixture2", get(fixture2));

    let addr = SocketAddr::from(([127, 0, 0, 1], 8080));
    println!("Fixture server running on {}", addr);

    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .unwrap();
}

async fn root() -> &'static str {
    "Fixture server running"
}

async fn fixture1() -> impl IntoResponse {
    r#"<html>
<head><title>Fixture 1</title></head>
<body>
    <h1>Fixture 1 - Navigation Test</h1>
    <a href="/fixture2">Go to Fixture 2</a>
    <button class="btn">Click me</button>
</body>
</html>"#
}

async fn fixture2() -> impl IntoResponse {
    r#"<html>
<head><title>Fixture 2</title></head>
<body>
    <h1>Fixture 2 - Form Submission Test</h1>
    <form>
        <input type="text" name="username" placeholder="Username">
        <input type="password" name="password" placeholder="Password">
        <button type="submit">Login</button>
    </form>
</body>
</html>"#
}
