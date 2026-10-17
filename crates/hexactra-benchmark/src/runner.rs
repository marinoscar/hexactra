//! Benchmark runner for Hexactra

use crate::{BenchmarkConfig, BenchmarkResult, FixtureResult};
use chrono::Utc;
use std::time::Instant;

/// Runner for benchmarking Hexactra
pub struct BenchmarkRunner {
    config: BenchmarkConfig,
}

impl BenchmarkRunner {
    /// Create a new benchmark runner
    pub fn new(config: BenchmarkConfig) -> Self {
        Self { config }
    }

    /// Run the benchmark suite
    pub async fn run(&self) -> BenchmarkResult {
        let start_time = Utc::now();
        let mut fixture_results = Vec::new();

        for fixture in &self.config.fixtures {
            let result = self.run_fixture(fixture).await;
            fixture_results.push(result);
        }

        let end_time = Utc::now();

        BenchmarkResult {
            run_id: uuid::Uuid::new_v4(),
            start_time,
            end_time,
            config: self.config.clone(),
            fixture_results,
        }
    }

    /// Run a single fixture
    async fn run_fixture(&self, fixture: &crate::FixtureConfig) -> FixtureResult {
        let mut latencies = Vec::new();
        let mut successful = 0;
        let mut failed = 0;
        let mut total_tokens = 0u64;

        for _ in 0..self.config.iterations {
            let start = Instant::now();

            // Simulate running a task (in real implementation, this would
            // use hexactra-core to run actual browser tasks)
            let success = self.simulate_task(fixture).await;

            let elapsed = start.elapsed().as_millis() as u64;
            latencies.push(elapsed);

            if success {
                successful += 1;
            } else {
                failed += 1;
            }

            // Simulate token consumption
            total_tokens += 100; // Simulated token count
        }

        let total_tasks = self.config.iterations;
        let success_rate = successful as f64 / total_tasks as f64;

        // Sort latencies for median calculation
        let mut sorted_latencies = latencies.clone();
        sorted_latencies.sort_unstable();

        let avg_latency = latencies.iter().sum::<u64>() as f64 / total_tasks as f64;
        let median_latency = if total_tasks > 0 {
            sorted_latencies[total_tasks / 2] as f64
        } else {
            0.0
        };
        let min_latency = latencies.iter().copied().min().unwrap_or(0);
        let max_latency = latencies.iter().copied().max().unwrap_or(0);

        let avg_tokens = total_tokens as f64 / total_tasks as f64;
        let avg_cost_usd = avg_tokens * 0.000001; // Simplified cost model

        FixtureResult {
            url: fixture.url.clone(),
            total_tasks,
            successful_tasks: successful,
            failed_tasks: failed,
            success_rate,
            avg_latency_ms: avg_latency,
            median_latency_ms: median_latency,
            min_latency_ms: min_latency,
            max_latency_ms: max_latency,
            avg_tokens,
            avg_cost_usd,
        }
    }

    /// Simulate running a task
    async fn simulate_task(&self, _fixture: &crate::FixtureConfig) -> bool {
        // In a real implementation, this would:
        // 1. Create a session with hexactra-core
        // 2. Run the task
        // 3. Collect experience events
        // 4. Submit to AEF if enabled

        // For now, simulate success with high probability
        use rand::Rng;
        let mut rng = rand::rng();
        rng.random_range(0.0..1.0) < 0.95
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_benchmark_runner() {
        let config = BenchmarkConfig {
            iterations: 3,
            fixtures: vec![crate::FixtureConfig {
                url: "http://localhost:8080/test".to_string(),
                task_type: "navigation".to_string(),
                expected_success_rate: 0.9,
            }],
            use_memory: false,
            use_aef: false,
        };

        let runner = BenchmarkRunner::new(config);
        let result = runner.run().await;

        assert!(result.fixture_results.len() >= 1);
        assert!(result.start_time <= result.end_time);
    }
}
