//! Reading server-sent events from a response.

/// One event.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct SseEvent {
    pub name: String,
    pub data: String,
}

/// Splits a stream of bytes into events.
#[derive(Default)]
pub(crate) struct SseParser {
    buffer: Vec<u8>,
    current: SseEvent,
    filled: bool,
}

impl SseParser {
    /// Takes more bytes and returns the events they finish.
    pub(crate) fn feed(&mut self, chunk: &[u8]) -> Vec<SseEvent> {
        self.buffer.extend_from_slice(chunk);
        let mut events = Vec::new();
        while let Some(end) = self.buffer.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = self.buffer.drain(..=end).collect();
            let text = String::from_utf8_lossy(&line);
            let text = text.trim_end_matches(['\n', '\r']);
            if text.is_empty() {
                if self.filled {
                    events.push(std::mem::take(&mut self.current));
                    self.filled = false;
                }
                continue;
            }
            if text.starts_with(':') {
                continue;
            }
            let (field, value) = text.split_once(':').unwrap_or((text, ""));
            let value = value.strip_prefix(' ').unwrap_or(value);
            match field {
                "event" => {
                    self.current.name = value.to_owned();
                    self.filled = true;
                }
                "data" => {
                    if !self.current.data.is_empty() {
                        self.current.data.push('\n');
                    }
                    self.current.data.push_str(value);
                    self.filled = true;
                }
                _ => {}
            }
        }
        events
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_are_split_whatever_the_chunks() {
        let mut parser = SseParser::default();
        assert!(parser.feed(b": comment\n\nevent: endp").is_empty());
        let events = parser.feed(b"oint\ndata: /a\r\n\r\ndata: one\ndata: two\n\n");
        assert_eq!(
            events,
            vec![
                SseEvent {
                    name: "endpoint".to_owned(),
                    data: "/a".to_owned()
                },
                SseEvent {
                    name: String::new(),
                    data: "one\ntwo".to_owned()
                },
            ]
        );
    }
}
