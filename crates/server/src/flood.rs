//! Token bucket flood control.

use std::time::{Duration, Instant};

pub struct TokenBucket {
    burst: f64,
    rate: f64,
    tokens: f64,
    last: Instant,
}

impl TokenBucket {
    /// `burst` lines at most; `rate` tokens added each second.
    pub fn new(burst: u32, rate: u32) -> TokenBucket {
        let burst = f64::from(burst.max(1));
        TokenBucket {
            burst,
            rate: f64::from(rate.max(1)),
            tokens: burst,
            last: Instant::now(),
        }
    }

    fn refill(&mut self) {
        let now = Instant::now();
        let dt = now.duration_since(self.last).as_secs_f64();
        self.last = now;
        self.tokens = (self.tokens + dt * self.rate).min(self.burst);
    }

    /// Take one token. Returns `None` when a token is available now, or the
    /// time to wait. The token is taken in both cases.
    pub fn take(&mut self) -> Option<Duration> {
        self.refill();
        self.tokens -= 1.0;
        if self.tokens >= 0.0 {
            None
        } else {
            Some(Duration::from_secs_f64(-self.tokens / self.rate))
        }
    }

    /// Take one token only when one is available now. Returns false (and
    /// takes nothing) when the bucket is empty.
    pub fn try_take(&mut self) -> bool {
        self.refill();
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn burst_then_throttle() {
        let mut b = TokenBucket::new(3, 1);
        assert!(b.take().is_none());
        assert!(b.take().is_none());
        assert!(b.take().is_none());
        assert!(b.take().is_some());
    }

    #[test]
    fn try_take_does_not_go_negative() {
        let mut b = TokenBucket::new(2, 1);
        assert!(b.try_take());
        assert!(b.try_take());
        assert!(!b.try_take());
        assert!(!b.try_take());
    }
}
