//! How often a live viewer gets a frame: at most one per gap, and never fewer than it needs to see the page as it is
//! now. A frame that comes too soon waits for its turn instead of being dropped, since a page that has gone still sends
//! no more frames and the viewer would otherwise keep an older picture.
use std::time::{Duration, Instant};

/// The frames one viewer is sent, spaced by `gap`.
pub struct Pace<T> {
    gap: Duration,
    last: Option<Instant>,
    waiting: Option<T>,
}

impl<T> Pace<T> {
    /// No frame sent yet.
    pub fn new(gap: Duration) -> Self {
        Self {
            gap,
            last: None,
            waiting: None,
        }
    }

    /// A frame arrived at `now`: it goes out now if its turn has come, or waits, replacing any frame already waiting.
    pub fn offer(&mut self, frame: T, now: Instant) -> Option<T> {
        if self.last.is_some_and(|last| now < last + self.gap) {
            self.waiting = Some(frame);
            return None;
        }
        self.waiting = None;
        self.last = Some(now);
        Some(frame)
    }

    /// When the waiting frame may go out, if one waits.
    pub fn turn(&self) -> Option<Instant> {
        self.waiting.as_ref()?;
        Some(self.last.map_or_else(Instant::now, |last| last + self.gap))
    }

    /// The waiting frame, if its turn has come by `now`.
    pub fn due(&mut self, now: Instant) -> Option<T> {
        if self.turn().is_some_and(|turn| now >= turn) {
            self.last = Some(now);
            return self.waiting.take();
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GAP: Duration = Duration::from_millis(80);

    #[test]
    fn the_last_frame_of_a_burst_still_goes_out_when_the_page_goes_still() {
        let start = Instant::now();
        let mut pace = Pace::new(GAP);
        assert_eq!(pace.offer("first", start), Some("first"));
        assert_eq!(
            pace.offer("second", start + Duration::from_millis(10)),
            None
        );
        assert_eq!(pace.offer("third", start + Duration::from_millis(30)), None);
        // Nothing more comes from the page; the newest frame waits for its turn rather than being lost.
        assert_eq!(pace.turn(), Some(start + GAP));
        assert_eq!(
            pace.due(start + Duration::from_millis(50)),
            None,
            "not before its turn"
        );
        assert_eq!(pace.due(start + GAP), Some("third"));
        assert_eq!(pace.turn(), None, "sent once");
    }

    #[test]
    fn frames_further_apart_than_the_gap_go_out_as_they_come() {
        let start = Instant::now();
        let mut pace = Pace::new(GAP);
        assert_eq!(pace.offer(1, start), Some(1));
        assert_eq!(pace.offer(2, start + GAP), Some(2));
        assert_eq!(pace.offer(3, start + GAP * 3), Some(3));
        assert_eq!(pace.turn(), None);
    }

    #[test]
    fn a_frame_on_its_turn_replaces_the_one_waiting() {
        let start = Instant::now();
        let mut pace = Pace::new(GAP);
        pace.offer("a", start);
        pace.offer("b", start + Duration::from_millis(20));
        assert_eq!(pace.offer("c", start + GAP), Some("c"));
        assert_eq!(
            pace.turn(),
            None,
            "the older waiting frame is not sent after a newer one"
        );
    }
}
