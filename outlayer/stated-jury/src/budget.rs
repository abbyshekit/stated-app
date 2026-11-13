//! Monotonic runtime accounting. All timestamps are nanoseconds supplied by the caller.

const SECOND: u64 = 1_000_000_000;
const RUN_LIMIT: u64 = 150 * SECOND;
const OUTPUT_RESERVE: u64 = 5 * SECOND;
const MINIMUM_STAGE: u64 = 1_000_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Stage {
    Planner,
    Evidence,
    Jury,
}

pub struct RunBudget {
    started: u64,
    active: Option<(Stage, u64)>,
}

impl RunBudget {
    pub fn new(started: u64) -> Self {
        Self {
            started,
            active: None,
        }
    }

    pub fn set_stage(&mut self, stage: Stage, now: u64) -> Result<u64, String> {
        if self.active.is_some_and(|(active, _)| active == stage) {
            return self.deadline(now);
        }
        let (limit, future) = match stage {
            Stage::Planner => (30 * SECOND, 115 * SECOND),
            Stage::Evidence => (25 * SECOND, 90 * SECOND),
            Stage::Jury => (90 * SECOND, 0),
        };
        let latest = self
            .started
            .saturating_add(RUN_LIMIT)
            .saturating_sub(OUTPUT_RESERVE)
            .saturating_sub(future);
        let deadline = now.saturating_add(limit).min(latest);
        if deadline.saturating_sub(now) < MINIMUM_STAGE {
            return Err("Insufficient runtime for stage".into());
        }
        self.active = Some((stage, deadline));
        Ok(deadline)
    }

    pub fn deadline(&self, now: u64) -> Result<u64, String> {
        self.active
            .map(|(_, end)| end)
            .filter(|end| now < *end)
            .ok_or_else(|| "Stage deadline exceeded".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn planner_fallbacks_share_thirty_seconds() {
        let mut budget = RunBudget::new(0);
        assert_eq!(budget.set_stage(Stage::Planner, 0), Ok(30 * SECOND));
        assert_eq!(
            budget.set_stage(Stage::Planner, 20 * SECOND),
            Ok(30 * SECOND)
        );
        assert!(budget.deadline(30 * SECOND).is_err());
    }

    #[test]
    fn stages_preserve_the_run_reserve() {
        let mut budget = RunBudget::new(0);
        assert_eq!(
            budget.set_stage(Stage::Evidence, 30 * SECOND),
            Ok(55 * SECOND)
        );
        assert_eq!(budget.set_stage(Stage::Jury, 55 * SECOND), Ok(145 * SECOND));
        assert!(budget.deadline(145 * SECOND).is_err());
    }

    #[test]
    fn late_stages_fail_before_starting_requests() {
        let mut budget = RunBudget::new(0);
        assert!(budget.set_stage(Stage::Planner, 30 * SECOND).is_err());
        assert!(budget.set_stage(Stage::Evidence, 55 * SECOND).is_err());
        assert!(budget.set_stage(Stage::Jury, 145 * SECOND).is_err());
    }

    #[test]
    fn late_evidence_cannot_spend_reserved_jury_time() {
        let mut budget = RunBudget::new(10 * SECOND);
        assert_eq!(
            budget.set_stage(Stage::Evidence, 64 * SECOND),
            Ok(65 * SECOND)
        );
        assert_eq!(budget.set_stage(Stage::Jury, 65 * SECOND), Ok(155 * SECOND));
    }

    #[test]
    fn an_expired_stage_cannot_be_restarted() {
        let mut budget = RunBudget::new(0);
        assert!(budget.deadline(0).is_err());
        assert!(budget.set_stage(Stage::Planner, 0).is_ok());
        assert!(budget.set_stage(Stage::Planner, 31 * SECOND).is_err());
    }

    #[test]
    fn minimum_stage_time_is_required() {
        let mut budget = RunBudget::new(0);
        assert!(budget
            .set_stage(Stage::Jury, 145 * SECOND - MINIMUM_STAGE + 1)
            .is_err());
        assert_eq!(
            budget.set_stage(Stage::Jury, 145 * SECOND - MINIMUM_STAGE),
            Ok(145 * SECOND)
        );
    }
}
