//! Benchmark CLI

use clap::Parser;
use hexactra_benchmark::{BenchmarkConfig, BenchmarkRunner};
use std::process;

#[derive(Parser, Debug)]
#[command(name = "benchmark")]
#[command(about = "Run Hexactra benchmark suite", long_about = None)]
struct Args {
    /// Number of iterations per fixture
    #[arg(short, long, default_value = "30")]
    iterations: usize,

    /// Use memory guidance
    #[arg(long, default_value = "false")]
    use_memory: bool,

    /// Use AEF connector
    #[arg(long, default_value = "false")]
    use_aef: bool,

    /// Output file for results (JSON)
    #[arg(short, long)]
    output: Option<String>,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let args = Args::parse();

    let config = BenchmarkConfig {
        iterations: args.iterations,
        fixtures: vec![
            hexactra_benchmark::FixtureConfig {
                url: "http://localhost:8080/fixture1".to_string(),
                task_type: "navigation".to_string(),
                expected_success_rate: 0.95,
            },
            hexactra_benchmark::FixtureConfig {
                url: "http://localhost:8080/fixture2".to_string(),
                task_type: "form_submission".to_string(),
                expected_success_rate: 0.90,
            },
        ],
        use_memory: args.use_memory,
        use_aef: args.use_aef,
    };

    let runner = BenchmarkRunner::new(config);
    let result = runner.run().await;

    // Print summary
    println!("\n=== Benchmark Results ===");
    for fixture in &result.fixture_results {
        println!(
            "Fixture: {}",
            fixture.url
        );
        println!("  Success rate: {:.2}%", fixture.success_rate * 100.0);
        println!("  Avg latency: {:.2}ms", fixture.avg_latency_ms);
        println!("  Tokens used: {:.2}", fixture.avg_tokens);
    }

    // Save results to file if specified
    if let Some(output) = args.output {
        match serde_json::to_string_pretty(&result) {
            Ok(json) => {
                if let Err(e) = std::fs::write(&output, json) {
                    eprintln!("Failed to write output: {}", e);
                    process::exit(1);
                }
            }
            Err(e) => {
                eprintln!("Failed to serialize results: {}", e);
                process::exit(1);
            }
        }
    }
}
