use crate::tool_activity::FIELD_LIMIT;
use anyhow::{Result, ensure};
use serde_json::Value;
use std::io::{self, BufRead, BufReader, Read};
use tokio::io::{AsyncRead, AsyncReadExt, duplex};
use tokio_util::io::SyncIoBridge;

const CHUNK_SIZE: usize = 64 * 1024;

pub(super) async fn read(input: &mut (impl AsyncRead + Unpin), limit: usize) -> Result<Value> {
    let size = input.read_u32_le().await? as usize;
    ensure!((1..=limit).contains(&size), "Codex IPC 消息大小无效");

    let (mut writer, reader) = duplex(CHUNK_SIZE);
    let reader = SyncIoBridge::new(reader);
    let decode = tokio::task::spawn_blocking(move || {
        let input = BufReader::with_capacity(CHUNK_SIZE, reader);
        serde_json::from_reader::<_, Value>(OutputPreviews::new(input))
    });
    let size = size as u64;
    let copied = tokio::io::copy(&mut input.take(size), &mut writer).await;
    drop(writer);
    let value = decode.await??;
    ensure!(
        copied? == size && value.is_object(),
        "Codex IPC 消息格式无效"
    );
    Ok(value)
}

#[derive(Clone, Copy)]
enum Field {
    Snapshot,
    Turns,
    Output,
}

enum NextToken {
    Any,
    Colon(Field),
    Value(Field),
}

/// Keep the command preview that the remote UI can display and consume the rest
/// of the string without buffering it. Other fields and patch paths stay intact.
struct OutputPreviews<R> {
    input: R,
    next: NextToken,
    depth: usize,
    snapshot: Option<usize>,
    turns: Option<usize>,
    quoted: bool,
    escaped: bool,
    token: [u8; 17],
    token_len: usize,
    preview: std::vec::IntoIter<u8>,
}

impl<R: BufRead> OutputPreviews<R> {
    fn new(input: R) -> Self {
        Self {
            input,
            next: NextToken::Any,
            depth: 0,
            snapshot: None,
            turns: None,
            quoted: false,
            escaped: false,
            token: [0; 17],
            token_len: 0,
            preview: Vec::new().into_iter(),
        }
    }

    fn next_byte(&mut self) -> io::Result<Option<u8>> {
        if let Some(byte) = self.preview.next() {
            return Ok(Some(byte));
        }
        let Some(&byte) = self.input.fill_buf()?.first() else {
            return Ok(None);
        };
        self.input.consume(1);
        if self.quoted {
            if byte == b'"' && !self.escaped {
                self.quoted = false;
                if let Some(key) = self.token.get(..self.token_len) {
                    self.next = match key {
                        b"conversationState" => NextToken::Colon(Field::Snapshot),
                        b"turns" | b"turnHistory" if self.snapshot == Some(self.depth) => {
                            NextToken::Colon(Field::Turns)
                        }
                        key if self.turns.is_some() && is_output_key(key) => {
                            NextToken::Colon(Field::Output)
                        }
                        _ => NextToken::Any,
                    };
                }
            } else {
                if self.token_len <= self.token.len() {
                    if let Some(slot) = self.token.get_mut(self.token_len) {
                        *slot = byte;
                    }
                    self.token_len += 1;
                }
                self.escaped = byte == b'\\' && !self.escaped;
            }
        } else if !byte.is_ascii_whitespace() {
            match byte {
                b'"' => {
                    if matches!(self.next, NextToken::Value(Field::Output)) {
                        self.preview = command_preview(&mut self.input)?.into_iter();
                    } else {
                        self.quoted = true;
                        self.token_len = 0;
                    }
                }
                b'{' | b'[' => {
                    self.depth += 1;
                    match self.next {
                        NextToken::Value(Field::Snapshot) if self.snapshot.is_none() => {
                            self.snapshot = Some(self.depth);
                        }
                        NextToken::Value(Field::Turns) => self.turns = Some(self.depth),
                        _ => {}
                    }
                }
                b'}' | b']' => {
                    if self.turns == Some(self.depth) {
                        self.turns = None;
                    }
                    if self.snapshot == Some(self.depth) {
                        self.snapshot = None;
                    }
                    self.depth = self.depth.saturating_sub(1);
                }
                _ => {}
            }
            self.next = match self.next {
                NextToken::Colon(field) if byte == b':' => NextToken::Value(field),
                _ => NextToken::Any,
            };
        }
        Ok(Some(byte))
    }
}

impl<R: BufRead> Read for OutputPreviews<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        for (index, slot) in buffer.iter_mut().enumerate() {
            let Some(byte) = self.next_byte()? else {
                return Ok(index);
            };
            *slot = byte;
        }
        Ok(buffer.len())
    }
}

pub(super) fn is_output_key(key: &[u8]) -> bool {
    matches!(key, b"aggregatedOutput" | b"aggregated_output")
}

fn command_preview(input: &mut impl BufRead) -> io::Result<Vec<u8>> {
    let mut output = Vec::new();
    let mut remaining = FIELD_LIMIT + 1;
    loop {
        let chunk = input.fill_buf()?;
        if chunk.is_empty() {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        let plain = chunk
            .iter()
            .take_while(|&&byte| matches!(byte, 0x20..=0x7f) && !matches!(byte, b'"' | b'\\'))
            .count();
        if plain != 0 {
            let keep = remaining.min(plain);
            output.extend_from_slice(&chunk[..keep]);
            remaining -= keep;
            input.consume(plain);
            continue;
        }
        let byte = chunk[0];
        input.consume(1);
        if byte == b'"' {
            output.push(b'"');
            return Ok(output);
        }
        let mut encoded = [0; 12];
        encoded[0] = byte;
        let (size, decoded) = match byte {
            b'\\' => read_escape(input, &mut encoded)?,
            0xc2..=0xf4 => {
                let width = match byte {
                    0xc2..=0xdf => 2,
                    0xe0..=0xef => 3,
                    _ => 4,
                };
                input.read_exact(&mut encoded[1..width])?;
                std::str::from_utf8(&encoded[..width]).map_err(|_| invalid_string())?;
                (width, width)
            }
            _ => return Err(invalid_string()),
        };
        if remaining > 0 {
            output.extend_from_slice(&encoded[..size]);
            remaining = remaining.saturating_sub(decoded);
        }
    }
}

fn read_escape(input: &mut impl Read, encoded: &mut [u8; 12]) -> io::Result<(usize, usize)> {
    input.read_exact(&mut encoded[1..2])?;
    match encoded[1] {
        b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't' => Ok((2, 1)),
        b'u' => {
            input.read_exact(&mut encoded[2..6])?;
            let high = hex_unit(&encoded[2..6])?;
            if (0xd800..=0xdbff).contains(&high) {
                input.read_exact(&mut encoded[6..])?;
                let low = hex_unit(&encoded[8..])?;
                if encoded[6..8] != *b"\\u" || !(0xdc00..=0xdfff).contains(&low) {
                    return Err(invalid_string());
                }
                Ok((12, 4))
            } else {
                let character = char::from_u32(high).ok_or_else(invalid_string)?;
                Ok((6, character.len_utf8()))
            }
        }
        _ => Err(invalid_string()),
    }
}

fn hex_unit(bytes: &[u8]) -> io::Result<u32> {
    bytes.iter().try_fold(0, |value, byte| {
        let digit = char::from(*byte).to_digit(16).ok_or_else(invalid_string)?;
        Ok((value << 4) | digit)
    })
}

fn invalid_string() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "invalid Codex IPC JSON string")
}

#[cfg(test)]
mod tests {
    use super::{CHUNK_SIZE, FIELD_LIMIT, OutputPreviews, read};
    use anyhow::Result;
    use serde_json::{Value, json};
    use std::io::BufReader;
    use tokio::io::AsyncReadExt;

    #[tokio::test]
    async fn streams_a_large_output_without_retaining_it_or_consuming_the_next_frame() -> Result<()>
    {
        const OUTPUT_SIZE: usize = 33 * 1024 * 1024;
        let start = br#"{"change":{"type":"snapshot","conversationState":{"turns":[{"id":"newest","items":[{"aggregatedOutput": ""#;
        let end = br#""}]}]}}}"#;
        let size = ((start.len() + OUTPUT_SIZE + end.len()) as u32).to_le_bytes();
        let next = br#"{"change":{"type":"patches"}}"#;
        let next_size = (next.len() as u32).to_le_bytes();
        let mut input = size
            .as_slice()
            .chain(start.as_slice())
            .chain(tokio::io::repeat(b'a').take(OUTPUT_SIZE as u64))
            .chain(end.as_slice())
            .chain(next_size.as_slice())
            .chain(next.as_slice());
        let snapshot = read(&mut input, 128 * 1024 * 1024).await?;
        let turn = &snapshot["change"]["conversationState"]["turns"][0];
        assert_eq!(turn["id"], "newest");
        assert_eq!(
            turn["items"][0]["aggregatedOutput"].as_str().unwrap(),
            "a".repeat(FIELD_LIMIT + 1)
        );
        assert!(snapshot.to_string().len() < CHUNK_SIZE);
        assert_eq!(
            read(&mut input, CHUNK_SIZE).await?,
            json!({"change":{"type":"patches"}})
        );
        Ok(())
    }

    #[test]
    fn validates_escaped_unicode_even_after_the_preview() -> Result<()> {
        let prefix = "x".repeat(FIELD_LIMIT - 1);
        let body = format!(
            r#"{{"conversationState":{{"turnHistory":[{{"aggregated_output":"{prefix}\uD83D\uDC10\n\"尾","text":"aggregatedOutput"}}],"requests":[{{"aggregatedOutput":"{prefix}untouched"}}]}}}}"#
        );
        let reader = BufReader::with_capacity(3, body.as_bytes());
        let value: Value = serde_json::from_reader(OutputPreviews::new(reader))?;
        let state = &value["conversationState"];
        assert_eq!(
            state["turnHistory"][0]["aggregated_output"],
            format!("{prefix}🐐")
        );
        assert_eq!(state["turnHistory"][0]["text"], "aggregatedOutput");
        assert_eq!(
            state["requests"][0]["aggregatedOutput"],
            format!("{prefix}untouched")
        );

        let malformed = format!(
            r#"{{"conversationState":{{"turns":[{{"aggregatedOutput":"{prefix}more\uD83D\u0000"}}]}}}}"#
        );
        assert!(
            serde_json::from_reader::<_, Value>(OutputPreviews::new(malformed.as_bytes())).is_err()
        );
        Ok(())
    }
}
