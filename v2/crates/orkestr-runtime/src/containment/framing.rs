use super::Error;
use std::collections::VecDeque;
use std::io::{ErrorKind, Read, Write};
use std::process::{ChildStdin, ChildStdout};

#[derive(Clone, Copy)]
pub struct TransportBounds {
    pub max_frame_bytes: usize,
    pub max_pending_frames: usize,
    pub io_bytes_per_poll: usize,
}

impl Default for TransportBounds {
    fn default() -> Self {
        Self {
            max_frame_bytes: 65536,
            max_pending_frames: 8,
            io_bytes_per_poll: 65536,
        }
    }
}

impl TransportBounds {
    pub(super) fn validate(self) -> Result<Self, Error> {
        if !(1..=1048576).contains(&self.max_frame_bytes)
            || !(1..=64).contains(&self.max_pending_frames)
            || !(1..=1048576).contains(&self.io_bytes_per_poll)
        {
            return Err(Error::InvalidBounds);
        }
        Ok(self)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Output {
    Pending,
    Frame(Vec<u8>),
    Eof,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Flush {
    pub written: usize,
    pub pending_frames: usize,
}

pub(super) struct Framing {
    pub input: Option<ChildStdin>,
    pub output: Option<ChildStdout>,
    pub queue: VecDeque<Vec<u8>>,
    offset: usize,
    buffer: Vec<u8>,
    eof: bool,
    pub broken: bool,
    bounds: TransportBounds,
}

impl Framing {
    pub fn new(input: ChildStdin, output: ChildStdout, bounds: TransportBounds) -> Self {
        Self {
            input: Some(input),
            output: Some(output),
            queue: VecDeque::new(),
            offset: 0,
            buffer: Vec::new(),
            eof: false,
            broken: false,
            bounds,
        }
    }

    pub fn enqueue(&mut self, frame: &[u8]) -> Result<(), Error> {
        if self.broken {
            return Err(Error::PipeClosed);
        }
        if frame.len() > self.bounds.max_frame_bytes {
            return Err(Error::FrameTooLarge);
        }
        if frame.is_empty() || frame.iter().any(|byte| matches!(byte, b'\n' | b'\r' | 0)) {
            return Err(Error::InvalidFrame);
        }
        if self.queue.len() == self.bounds.max_pending_frames {
            return Err(Error::Backpressure);
        }
        let mut frame = frame.to_vec();
        frame.push(b'\n');
        self.queue.push_back(frame);
        Ok(())
    }

    pub fn flush(&mut self) -> Result<Flush, Error> {
        if self.broken {
            return Err(Error::PipeClosed);
        }
        let mut written = 0;
        let mut attempts = 0;
        while let Some(frame) = self.queue.front() {
            if written == self.bounds.io_bytes_per_poll || attempts == 64 {
                break;
            }
            attempts += 1;
            let end = frame
                .len()
                .min(self.offset + self.bounds.io_bytes_per_poll - written);
            match self
                .input
                .as_mut()
                .ok_or(Error::PipeClosed)?
                .write(&frame[self.offset..end])
            {
                Ok(0) => return Err(Error::PipeClosed),
                Ok(count) => {
                    written += count;
                    self.offset += count;
                    if self.offset == frame.len() {
                        self.queue.pop_front();
                        self.offset = 0;
                    }
                }
                Err(error) if error.kind() == ErrorKind::WouldBlock => break,
                Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                Err(_) => return Err(Error::PipeClosed),
            }
        }
        Ok(Flush {
            written,
            pending_frames: self.queue.len(),
        })
    }

    pub fn read(&mut self) -> Result<Output, Error> {
        if self.broken {
            return Err(Error::PipeClosed);
        }
        let mut read = 0;
        let mut attempts = 0;
        loop {
            if let Some(end) = self.buffer.iter().position(|byte| *byte == b'\n') {
                let mut frame: Vec<u8> = self.buffer.drain(..=end).collect();
                frame.pop();
                if frame.last() == Some(&b'\r') {
                    frame.pop();
                }
                return Ok(Output::Frame(frame));
            }
            if self.buffer.len() > self.bounds.max_frame_bytes {
                return Err(Error::FrameTooLarge);
            }
            if self.eof {
                return if self.buffer.is_empty() {
                    Ok(Output::Eof)
                } else {
                    Err(Error::TruncatedFrame)
                };
            }
            if read == self.bounds.io_bytes_per_poll || attempts == 64 {
                return Ok(Output::Pending);
            }
            attempts += 1;
            let mut chunk = [0; 4096];
            let capacity = chunk
                .len()
                .min(self.bounds.io_bytes_per_poll - read)
                .min(self.bounds.max_frame_bytes + 1 - self.buffer.len());
            match self
                .output
                .as_mut()
                .ok_or(Error::PipeClosed)?
                .read(&mut chunk[..capacity])
            {
                Ok(0) => self.eof = true,
                Ok(count) => {
                    self.buffer.extend_from_slice(&chunk[..count]);
                    read += count;
                }
                Err(error) if error.kind() == ErrorKind::WouldBlock => return Ok(Output::Pending),
                Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                Err(_) => return Err(Error::PipeClosed),
            }
        }
    }

    pub fn close(&mut self) {
        self.broken = true;
        self.input.take();
        self.output.take();
        self.queue.clear();
        self.buffer.clear();
    }
}
