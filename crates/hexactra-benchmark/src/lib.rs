//! Benchmark suite for Hexactra experience framework

pub mod runner;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Configuration for a benchmark run
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BenchmarkConfig {
    /// Number of tasks to run per fixture
    pub iterations: usize,

    /// List of fixtures to benchmark
    pub fixtures: Vec<FixtureConfig>,

    /// Whether to use memory guidance
    pub use_memory: bool,

    /// Whether to run with AEF connector
    pub use_aef: bool,
}

impl Default for BenchmarkConfig {
    fn default() -> Self {
        Self {
            iterations: 30,
            fixtures: vec![FixtureConfig::default()],
            use_memory: false,
            use_aef: false,
        }
    }
}

/// Configuration for a single fixture
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FixtureConfig {
    /// URL of the fixture website
    pub url: String,

    /// Task type to benchmark
    pub task_type: String,

    /// Expected success rate
    pub expected_success_rate: f64,
}

impl Default for FixtureConfig {
    fn default() -> Self {
        Self {
            url: "http://localhost:8080/fixture".to_string(),
            task_type: "navigation".to_string(),
            expected_success_rate: 0.95,
        }
    }
}

/// Results from a benchmark run
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BenchmarkResult {
    /// Unique identifier for this benchmark run
    pub run_id: Uuid,

    /// Timestamp when the benchmark started
    pub start_time: DateTime<Utc>,

    /// Timestamp when the benchmark ended
    pub end_time: DateTime<Utc>,

    /// Configuration used
    pub config: BenchmarkConfig,

    /// Results per fixture
    pub fixture_results: Vec<FixtureResult>,
}

/// Results for a single fixture
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FixtureResult {
    /// Fixture URL
    pub url: String,

    /// Total number of tasks run
    pub total_tasks: usize,

    /// Number of successful tasks
    pub successful_tasks: usize,

    /// Number of failed tasks
    pub failed_tasks: usize,

    /// Success rate
    pub success_rate: f64,

    /// Average latency in milliseconds
    pub avg_latency_ms: f64,

    /// Median latency in milliseconds
    pub median_latency_ms: f64,

    /// Min latency in milliseconds
    pub min_latency_ms: u64,

    /// Max latency in milliseconds
    pub max_latency_ms: u64,

    /// Average tokens consumed
    pub avg_tokens: f64,

    /// Average cost in USD
    pub avg_cost_usd: f64,
}

/// Summary of benchmark results
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BenchmarkSummary {
    /// Total number of runs
    pub total_runs: usize,

    /// Average success rate across all runs
    pub avg_success_rate: f64,

    /// Average latency in milliseconds
    pub avg_latency_ms: f64,

    /// Average tokens consumed
    pub avg_tokens: f64,

    /// Average cost in USD
    pub avg_cost_usd: f64,
}

pub use runner::BenchmarkRunner;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_config() {
        let config = BenchmarkConfig::default();
        assert_eq!(config.iterations, 30);
        assert!(!config.use_memory);
        assert!(!config.use_aef);
    }

    #[test]
    fn test_fixture_result_success_rate() {
        let result = FixtureResult {
            url: "https://example.com".to_string(),
            total_tasks: 100,
            successful_tasks: 95,
            failed_tasks: 5,
            success_rate: 0.95,
            avg_latency_ms: 100.0,
            median_latency_ms: 95.0,
            min_latency_ms: 50,
            max_latency_ms: 200,
            avg_tokens: 1000.0,
            avg_cost_usd: 0.01,
        };

        assert_eq!(result.success_rate, 0.95);
        assert_eq!(result.total_tasks, result.successful_tasks + result.failed_tasks);
    }
}
