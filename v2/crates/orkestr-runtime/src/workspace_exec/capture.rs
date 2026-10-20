//! Bounded head-and-tail retention for trusted command output. Long builds
//! keep their first lines and, more usefully, their final error lines.
use std::collections::VecDeque;

pub struct Capture {
    head: Vec<u8>,
    tail: VecDeque<u8>,
    head_limit: usize,
    tail_limit: usize,
    total: u64,
}

impl Capture {
    /// `limit` bytes are retained in total: one quarter head, the rest tail.
    pub fn new(limit: usize) -> Self {
        let head_limit = limit / 4;
        Self {
            head: Vec::new(),
            tail: VecDeque::new(),
            head_limit,
            tail_limit: limit - head_limit,
            total: 0,
        }
    }

    pub fn push(&mut self, mut bytes: &[u8]) {
        self.total = self.total.saturating_add(bytes.len() as u64);
        let room = self.head_limit.saturating_sub(self.head.len());
        let taken = room.min(bytes.len());
        self.head.extend_from_slice(&bytes[..taken]);
        bytes = &bytes[taken..];
        if bytes.len() >= self.tail_limit {
            self.tail.clear();
            self.tail.extend(&bytes[bytes.len() - self.tail_limit..]);
            return;
        }
        let overflow = (self.tail.len() + bytes.len()).saturating_sub(self.tail_limit);
        self.tail.drain(..overflow);
        self.tail.extend(bytes);
    }

    pub fn total(&self) -> u64 {
        self.total
    }

    pub fn truncated(&self) -> bool {
        self.total > (self.head.len() + self.tail.len()) as u64
    }

    /// Last `limit` retained bytes (from the tail, or the head if short).
    pub fn last(&self, limit: usize) -> Vec<u8> {
        let mut all: Vec<u8> = self.head.clone();
        all.extend(self.tail.iter());
        let start = all.len().saturating_sub(limit);
        all.split_off(start)
    }

    /// Head, an explicit omission marker when bytes were dropped, then tail.
    pub fn finish(self) -> Vec<u8> {
        let dropped = self.total - (self.head.len() + self.tail.len()) as u64;
        let mut result = self.head;
        if dropped > 0 {
            result.extend_from_slice(format!("\n[... {dropped} bytes omitted ...]\n").as_bytes());
        }
        result.extend(self.tail);
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_output_is_exact_and_long_output_keeps_head_and_tail() {
        let mut short = Capture::new(64);
        short.push(b"hello ");
        short.push(b"world");
        assert!(!short.truncated());
        assert_eq!(short.finish(), b"hello world");

        let mut long = Capture::new(8);
        for chunk in [&b"abcdef"[..], b"ghijkl", b"mnopqrstuvwxyz"] {
            long.push(chunk);
        }
        assert!(long.truncated());
        assert_eq!(long.total(), 26);
        assert_eq!(long.last(3), b"xyz");
        let text = String::from_utf8(long.finish()).unwrap();
        assert!(text.starts_with("ab\n[... 18 bytes omitted ...]\n"));
        assert!(text.ends_with("uvwxyz"));
    }

    #[test]
    fn retention_never_exceeds_the_limit_for_many_small_pushes() {
        let mut capture = Capture::new(100);
        for _ in 0..10_000 {
            capture.push(b"0123456789");
        }
        assert_eq!(capture.head.len() + capture.tail.len(), 100);
        assert_eq!(capture.total(), 100_000);
    }
}
