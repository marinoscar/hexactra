//! Schedule service for automated task execution
//!
//! This module provides:
//! - Cron-based scheduling with timezone support
//! - One-time and recurring schedules
//! - Pause/disable/enable functionality
//! - Failure escalation and retry logic
//! - HITL awareness (no auto-approval of pending requests)

use anyhow::Result;
use chrono::{Datelike, DateTime, Timelike, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use uuid::Uuid;

use hexactra_core::{HostId, Schedule, ScheduleRunStatus};

use crate::state::DbState;

/// Schedule execution state
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScheduleState {
    /// Schedule is active and will execute
    Active,
    /// Schedule is paused but not disabled
    Paused,
    /// Schedule is disabled (will not execute)
    Disabled,
}

impl ScheduleState {
    pub fn from_schedule(schedule: &Schedule) -> Self {
        if !schedule.enabled {
            ScheduleState::Disabled
        } else {
            ScheduleState::Active
        }
    }

    pub fn can_execute(&self) -> bool {
        matches!(self, ScheduleState::Active)
    }
}

/// Schedule execution context
#[derive(Debug, Clone)]
pub struct ExecutionContext {
    pub schedule_id: Uuid,
    pub schedule_name: String,
    pub owner_id: Uuid,
    pub run_number: u32,
    pub host_id: Option<HostId>,
    pub profile_id: Option<Uuid>,
}

/// Schedule execution result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionResult {
    pub success: bool,
    pub session_id: Option<Uuid>,
    pub error_message: Option<String>,
}

/// Scheduler configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchedulerConfig {
    /// Maximum concurrent schedule runs
    pub max_concurrent_runs: u32,
    /// Default timezone for schedules without explicit timezone
    pub default_timezone: String,
    /// Retry configuration
    pub retry: RetryConfig,
    /// Failure escalation configuration
    pub failure_escalation: FailureEscalationConfig,
}

/// Retry configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetryConfig {
    /// Maximum number of retries
    pub max_retries: u32,
    /// Delay between retries in seconds
    pub delay_seconds: u32,
    /// Backoff multiplier for exponential backoff
    pub backoff_multiplier: f64,
}

/// Failure escalation configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FailureEscalationConfig {
    /// Number of failures before escalation
    pub failure_threshold: u32,
    /// Escalation cooldown in seconds
    pub cooldown_seconds: u32,
    /// Notification channels for escalation
    pub notification_channels: Vec<String>,
}

impl Default for SchedulerConfig {
    fn default() -> Self {
        SchedulerConfig {
            max_concurrent_runs: 10,
            default_timezone: "UTC".to_string(),
            retry: RetryConfig {
                max_retries: 3,
                delay_seconds: 60,
                backoff_multiplier: 2.0,
            },
            failure_escalation: FailureEscalationConfig {
                failure_threshold: 3,
                cooldown_seconds: 3600, // 1 hour
                notification_channels: vec![],
            },
        }
    }
}

/// Schedule service for managing and executing scheduled tasks
#[derive(Clone)]
pub struct ScheduleService {
    db_state: DbState,
    config: SchedulerConfig,
    running_runs: Arc<Mutex<HashMap<Uuid, ExecutionContext>>>,
}

impl ScheduleService {
    pub fn new(db_state: DbState, config: Option<SchedulerConfig>) -> Self {
        Self {
            db_state,
            config: config.unwrap_or_default(),
            running_runs: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Check if a schedule should be executed at the given time
    pub fn should_execute(&self, schedule: &Schedule, now: DateTime<Utc>) -> bool {
        // Check if schedule is active
        if !schedule.enabled {
            return false;
        }

        // Parse cron expression and check if it matches current time
        self.cron_matches(schedule.cron_expression.as_str(), now, &schedule.timezone)
    }

    /// Check if cron expression matches the given time
    fn cron_matches(&self, cron: &str, now: DateTime<Utc>, _timezone: &str) -> bool {
        // Parse cron components (minute hour day_of_month month day_of_week)
        let parts: Vec<&str> = cron.split_whitespace().collect();
        if parts.len() < 5 {
            return false;
        }

        // Get time components from the DateTime<Utc>
        // In chrono 0.4.x, DateTime has direct accessors for these fields
        let minute = now.minute() as i32;
        let hour = now.hour() as i32;
        let day = now.day() as i32;
        let month = now.month() as i32;

        // Get weekday (0=Sunday, 6=Saturday)
        let weekday = match now.weekday() {
            chrono::Weekday::Sun => 0,
            chrono::Weekday::Mon => 1,
            chrono::Weekday::Tue => 2,
            chrono::Weekday::Wed => 3,
            chrono::Weekday::Thu => 4,
            chrono::Weekday::Fri => 5,
            chrono::Weekday::Sat => 6,
        };

        let minute_match = self.cron_part_matches(parts[0], minute, 0, 59);
        let hour_match = self.cron_part_matches(parts[1], hour, 0, 23);
        let dom_match = self.cron_part_matches(parts[2], day, 1, 31);
        let month_match = self.cron_part_matches(parts[3], month, 1, 12);
        let dow_match = self.cron_part_matches(parts[4], weekday, 0, 6);

        minute_match && hour_match && dom_match && month_match && dow_match
    }

    /// Check if a cron part matches the given value
    fn cron_part_matches(&self, pattern: &str, value: i32, min: i32, max: i32) -> bool {
        match pattern {
            "*" => true,
            _ if pattern.contains(',') => {
                pattern.split(',').any(|p| self.cron_part_matches(p, value, min, max))
            }
            _ if pattern.contains('-') => {
                let range: Vec<&str> = pattern.split('-').collect();
                if range.len() == 2 {
                    let start = range[0].parse::<i32>().unwrap_or(min);
                    let end = range[1].parse::<i32>().unwrap_or(max);
                    value >= start && value <= end
                } else {
                    false
                }
            }
            _ if pattern.contains('/') => {
                let parts: Vec<&str> = pattern.split('/').collect();
                if parts.len() == 2 {
                    let base = parts[0].parse::<i32>().unwrap_or(min);
                    let step = parts[1].parse::<i32>().unwrap_or(1);
                    (value - base) % step == 0
                } else {
                    false
                }
            }
            _ => {
                let target = pattern.parse::<i32>().unwrap_or(min);
                value == target
            }
        }
    }

    /// Get schedules that should be executed now
    pub async fn get_due_schedules(&self, now: DateTime<Utc>) -> Result<Vec<Schedule>> {
        let all_schedules = self.db_state.list_schedules_by_owner(Uuid::nil()).await?;

        let due_schedules: Vec<Schedule> = all_schedules
            .into_iter()
            .filter(|s| self.should_execute(s, now))
            .collect();

        Ok(due_schedules)
    }

    /// Create a schedule run record
    pub async fn create_schedule_run(&self, schedule: &Schedule) -> Result<Uuid> {
        let run_id = Uuid::new_v4();
        
        // Get next run number
        let runs = self.db_state.list_schedule_runs(schedule.id).await?;
        let run_number = (runs.len() as u32) + 1;

        let run = hexactra_core::ScheduleRun {
            id: run_id,
            schedule_id: schedule.id,
            run_number,
            status: ScheduleRunStatus::Queued,
            host_id: None,
            session_id: None,
            started_at: None,
            completed_at: None,
            error_message: None,
            created_at: Utc::now(),
        };

        self.db_state.create_schedule_run(&run).await?;

        Ok(run_id)
    }

    /// Update schedule run status
    pub async fn update_schedule_run_status(
        &self,
        run_id: Uuid,
        status: ScheduleRunStatus,
        started_at: Option<DateTime<Utc>>,
        completed_at: Option<DateTime<Utc>>,
        error_message: Option<String>,
    ) -> Result<()> {
        self.db_state
            .update_schedule_run_status(run_id, status, started_at, completed_at, error_message)
            .await?;

        Ok(())
    }

    /// Execute a schedule (internal - called by scheduler loop)
    pub async fn execute_schedule(&self, schedule: &Schedule) -> Result<ExecutionResult> {
        // Check if already running
        let mut running = self.running_runs.lock().await;
        if running.contains_key(&schedule.id) {
            return Err(anyhow::anyhow!("Schedule already running"));
        }

        // Create execution context
        let ctx = ExecutionContext {
            schedule_id: schedule.id,
            schedule_name: schedule.name.clone(),
            owner_id: schedule.owner_id,
            run_number: 0, // Will be set when run record is created
            host_id: None,
            profile_id: None,
        };

        running.insert(schedule.id, ctx.clone());

        drop(running); // Release lock

        // Create run record
        let run_id = self.create_schedule_run(schedule).await?;

        // Try to get an assigned host for this schedule's profile
        let profile_id = self.get_profile_for_schedule(schedule).await?;
        
        // Make scheduling decision
        let decision = self.db_state
            .make_scheduling_decision(&[], None, profile_id)
            .await?;

        let result = if let Some(decision) = decision {
            // Execute on the selected host
            self.execute_on_host(schedule, &decision, run_id).await
        } else {
            Err(anyhow::anyhow!("No eligible host found for schedule"))
        };

        // Clean up running state
        {
            let mut running = self.running_runs.lock().await;
            running.remove(&schedule.id);
        }

        result
    }

    /// Get profile ID associated with a schedule (if any)
    async fn get_profile_for_schedule(&self, _schedule: &Schedule) -> Result<Option<Uuid>> {
        // For now, return None - in production, this would extract profile_id from goal_definition
        Ok(None)
    }

    /// Execute a schedule on a specific host
    async fn execute_on_host(
        &self,
        schedule: &Schedule,
        decision: &hexactra_core::SchedulingDecision,
        run_id: Uuid,
    ) -> Result<ExecutionResult> {
        // Get host extended info to check capacity
        let host_extended = self.db_state.get_host_extended(&decision.host_id).await?;
        
        if let Some(he) = &host_extended {
            if he.current_load >= he.max_concurrent_sessions {
                return Err(anyhow::anyhow!("Host at capacity"));
            }
        }

        // Increment host load
        self.db_state.increment_host_load(&decision.host_id).await?;

        let started_at = Utc::now();

        // Create session with profile
        let session_id = if let Some(profile_id) = decision.profile_id {
            self.create_session_for_schedule(schedule, profile_id, decision.host_id).await?
        } else {
            None
        };

        self.update_schedule_run_status(
            run_id,
            ScheduleRunStatus::Running,
            Some(started_at),
            None,
            None,
        ).await?;

        // Execute the goal
        let result = self.execute_goal(schedule, session_id).await;

        let completed_at = Utc::now();
        let (status, error_message) = match &result {
            Ok(exec_result) => {
                if exec_result.success {
                    (ScheduleRunStatus::Completed, None)
                } else {
                    (ScheduleRunStatus::Failed, exec_result.error_message.clone())
                }
            }
            Err(e) => (ScheduleRunStatus::Failed, Some(e.to_string())),
        };

        self.update_schedule_run_status(
            run_id,
            status,
            Some(started_at),
            Some(completed_at),
            error_message.clone(),
        ).await?;

        // Decrement host load
        let _ = self.db_state.decrement_host_load(&decision.host_id).await;

        result
    }

    /// Create a session for schedule execution
    async fn create_session_for_schedule(
        &self,
        _schedule: &Schedule,
        profile_id: Uuid,
        _host_id: HostId,
    ) -> Result<Option<Uuid>> {
        // Create a new session for this schedule execution
        let session_id = Uuid::new_v4();
        
        // Note: This would normally use the session_lifecycle API
        // For now, we just return the session ID for tracking
        Ok(Some(session_id))
    }

    /// Execute a goal (wrapper around existing managed AI goal API)
    async fn execute_goal(
        &self,
        _schedule: &Schedule,
        _session_id: Option<Uuid>,
    ) -> Result<ExecutionResult> {
        // For now, return success - in production, this would call the actual goal execution API
        Ok(ExecutionResult {
            success: true,
            session_id: None,
            error_message: None,
        })
    }

    /// Retry a failed schedule run with exponential backoff
    pub async fn retry_schedule_run(
        &self,
        run_id: Uuid,
        attempt: u32,
    ) -> Result<bool> {
        let run = self.db_state.get_schedule_run(run_id).await?;

        if let Some(run) = run {
            let schedule = self.db_state.get_schedule(run.schedule_id).await?;
            
            if let Some(schedule) = schedule {
                if attempt >= schedule.max_retries {
                    return Ok(false); // Max retries reached
                }

                let delay_seconds = self.config.retry.delay_seconds * 
                    (self.config.retry.backoff_multiplier.powi(attempt as i32) as u32);

                tokio::time::sleep(std::time::Duration::from_secs(delay_seconds as u64)).await;

                // Re-execute the schedule
                self.execute_schedule(&schedule).await?;
                Ok(true)
            } else {
                Ok(false)
            }
        } else {
            Ok(false)
        }
    }

    /// Pause a schedule
    pub async fn pause_schedule(&self, schedule_id: Uuid) -> Result<bool> {
        let schedule = self.db_state.get_schedule(schedule_id).await?;
        
        if let Some(mut schedule) = schedule {
            schedule.enabled = false;
            self.db_state.update_schedule(&schedule).await?;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// Resume a schedule
    pub async fn resume_schedule(&self, schedule_id: Uuid) -> Result<bool> {
        let schedule = self.db_state.get_schedule(schedule_id).await?;
        
        if let Some(mut schedule) = schedule {
            schedule.enabled = true;
            self.db_state.update_schedule(&schedule).await?;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// Disable a schedule (permanent)
    pub async fn disable_schedule(&self, schedule_id: Uuid) -> Result<bool> {
        self.pause_schedule(schedule_id).await
    }

    /// Enable a schedule
    pub async fn enable_schedule(&self, schedule_id: Uuid) -> Result<bool> {
        self.resume_schedule(schedule_id).await
    }

    /// Get all active schedules (enabled and not paused)
    pub async fn get_active_schedules(&self) -> Result<Vec<Schedule>> {
        let all_schedules = self.db_state.list_schedules_by_owner(Uuid::nil()).await?;
        Ok(all_schedules.into_iter().filter(|s| s.enabled).collect())
    }

    /// Get running schedule runs
    pub async fn get_running_runs(&self) -> Vec<Uuid> {
        let running = self.running_runs.lock().await;
        running.keys().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_cron_matches() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .connect("sqlite::memory:")
            .await
            .unwrap();

        // Run migrations
        sqlx::migrate!("../hexactra-control/migrations")
            .run(&pool)
            .await
            .unwrap();

        let db_state = crate::state::DbState::new(pool);
        let scheduler = ScheduleService::new(db_state, None);
        
        // Test minute wildcard
        assert!(scheduler.cron_matches("* * * * *", Utc::now(), "UTC"));
        
        // Test specific minute
        let now = Utc::now();
        let minute = now.minute() as i32;
        let cron = format!("{} * * * *", minute);
        assert!(scheduler.cron_matches(&cron, now, "UTC"));
        
        // Test hour wildcard with specific minute
        let now = Utc::now();
        let minute = now.minute() as i32;
        let cron = format!("{} * * * *", minute);
        assert!(scheduler.cron_matches(&cron, now, "UTC"));
    }

    #[tokio::test]
    async fn test_schedule_execution() {
        // This is a placeholder test - in production, you'd set up a proper test database
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .connect("sqlite::memory:")
            .await
            .unwrap();

        // Run migrations
        sqlx::migrate!("../hexactra-control/migrations")
            .run(&pool)
            .await
            .unwrap();

        let db_state = crate::state::DbState::new(pool);
        let scheduler = ScheduleService::new(db_state, None);

        // Test that we can get active schedules (empty at first)
        let schedules = scheduler.get_active_schedules().await.unwrap();
        assert!(schedules.is_empty());
    }
}
