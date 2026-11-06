//! Reading a table of data one row at a time, whatever its size: `.jsonl`, a `.json` array, `.csv` or `.tsv`, or the lines
//! the data helper prints. What a row says is only ever counted and shown. Nothing here holds more than a row and the
//! tallies below, whose limits are the constants at the top.
use std::collections::HashMap;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io::{self, BufRead};

use saturn_domain::js;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

/// The longest row kept, in bytes. A longer one is counted and left out.
pub(super) const MAX_ROW: usize = 1024 * 1024;
/// How much row text one page of a preview carries.
const PAGE_BYTES: usize = 4 * 1024 * 1024;
/// How much of a row that cannot be read is shown.
const RAW_SHOWN: usize = 4096;
/// The most columns a profile describes.
const MAX_COLUMNS: usize = 200;
/// The most different values kept per column; past it a column's count is "at least".
const MAX_DISTINCT: usize = 1000;
/// How many of a column's most common values are given.
const COMMON_SHOWN: usize = 5;
/// How much of one value a profile keeps, in characters.
const VALUE_KEPT: usize = 200;
/// The most different rows an overlap remembers from its first file.
pub(super) const MAX_HASHED: usize = 4_000_000;

/// How a file's bytes divide into rows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Shape {
    /// One JSON value per line.
    Lines,
    /// One JSON array, its elements the rows.
    JsonArray,
    /// A header line, then fields split by this byte.
    Delimited(u8),
}

/// What one row turned out to be.
#[derive(Debug, PartialEq)]
pub(super) enum Item {
    Row(Value),
    Malformed { problem: String, raw: String },
    TooLong,
}

/// Rows read in order from a reader. An offset is where a row begins, so that a later page can start there.
pub(super) struct Rows<R> {
    reader: R,
    shape: Shape,
    offset: u64,
    columns: Vec<String>,
    /// For a JSON array: whether its opening bracket has been passed.
    begun: bool,
    ended: bool,
    /// How many bytes the last row took, for keeping a page to its size.
    last_size: usize,
}

/// Text of bytes that may not be valid UTF-8, for showing.
fn shown(bytes: &[u8]) -> String {
    String::from_utf8_lossy(&bytes[..bytes.len().min(RAW_SHOWN)]).into_owned()
}

/// Reads to the end of the line, keeping at most `MAX_ROW` bytes. Gives what was read and whether it all fit.
fn read_line_capped<R: BufRead>(reader: &mut R, kept: &mut Vec<u8>) -> io::Result<(u64, bool)> {
    let mut read = 0;
    let mut fits = true;
    loop {
        let buffer = reader.fill_buf()?;
        if buffer.is_empty() {
            return Ok((read, fits));
        }
        let end = buffer.iter().position(|byte| *byte == b'\n');
        let used = end.map_or(buffer.len(), |at| at + 1);
        if fits && kept.len() + used <= MAX_ROW {
            kept.extend_from_slice(&buffer[..used]);
        } else {
            fits = false;
            kept.clear();
        }
        reader.consume(used);
        read += used as u64;
        if end.is_some() {
            return Ok((read, fits));
        }
    }
}

/// Reads one record of a delimited file, where a quoted field may hold line breaks. An unclosed quote cannot swallow
/// the file: past the limit quotes stop counting, and the record ends at the next line break.
fn read_record_capped<R: BufRead>(
    reader: &mut R,
    separator: u8,
    kept: &mut Vec<u8>,
) -> io::Result<(u64, bool)> {
    let mut read = 0;
    let mut fits = true;
    let mut at_field_start = true;
    let mut quoted = false;
    let mut after_close = false;
    loop {
        let buffer = reader.fill_buf()?;
        if buffer.is_empty() {
            return Ok((read, fits));
        }
        let mut used = 0;
        let mut finished = false;
        for byte in buffer {
            used += 1;
            fits = fits && kept.len() + used <= MAX_ROW;
            if quoted && fits {
                if *byte == b'"' {
                    quoted = false;
                    after_close = true;
                }
                continue;
            }
            if after_close && *byte == b'"' {
                quoted = true;
                after_close = false;
                continue;
            }
            after_close = false;
            if *byte == b'\n' {
                finished = true;
                break;
            }
            if *byte == separator {
                at_field_start = true;
            } else if *byte == b'"' && at_field_start {
                quoted = true;
                at_field_start = false;
            } else {
                at_field_start = false;
            }
        }
        if fits {
            kept.extend_from_slice(&buffer[..used]);
        } else {
            kept.clear();
        }
        reader.consume(used);
        read += used as u64;
        if finished {
            return Ok((read, fits));
        }
    }
}

/// The fields of a delimited record, with their quotes taken off.
fn split_fields(record: &[u8], separator: u8) -> Vec<String> {
    let mut fields = Vec::new();
    let mut field = Vec::new();
    let mut quoted = false;
    let mut at_start = true;
    let mut index = 0;
    while index < record.len() {
        let byte = record[index];
        if quoted {
            if byte == b'"' {
                if record.get(index + 1) == Some(&b'"') {
                    field.push(b'"');
                    index += 1;
                } else {
                    quoted = false;
                }
            } else {
                field.push(byte);
            }
        } else if byte == separator {
            fields.push(String::from_utf8_lossy(&field).into_owned());
            field.clear();
            at_start = true;
            index += 1;
            continue;
        } else if byte == b'"' && at_start {
            quoted = true;
        } else {
            field.push(byte);
        }
        at_start = false;
        index += 1;
    }
    fields.push(String::from_utf8_lossy(&field).into_owned());
    fields
}

/// A record's bytes without its line ending.
fn without_line_end(record: &[u8]) -> &[u8] {
    let record = record.strip_suffix(b"\n").unwrap_or(record);
    record.strip_suffix(b"\r").unwrap_or(record)
}

/// Column names from a header: an empty one gets its place's name, and a repeated one a number, so that none hides another.
pub(super) fn column_names(header: Vec<String>) -> Vec<String> {
    let mut names: Vec<String> = Vec::with_capacity(header.len());
    for (index, name) in header.into_iter().enumerate() {
        let name = name.trim();
        let base = if name.is_empty() {
            format!("column_{}", index + 1)
        } else {
            name.to_owned()
        };
        let mut unique = base.clone();
        let mut count = 1;
        while names.contains(&unique) {
            count += 1;
            unique = format!("{base}_{count}");
        }
        names.push(unique);
    }
    names
}

/// Passes a byte order mark at the start of a file. Gives how many bytes it took.
pub(super) fn skip_byte_order_mark<R: BufRead>(reader: &mut R) -> io::Result<u64> {
    if reader.fill_buf()?.starts_with(&[0xEF, 0xBB, 0xBF]) {
        reader.consume(3);
        return Ok(3);
    }
    Ok(0)
}

/// The header of a delimited file, at the reader's start. Gives its columns and how many bytes it took.
pub(super) fn read_header<R: BufRead>(
    reader: &mut R,
    separator: u8,
) -> io::Result<(Vec<String>, u64)> {
    let mut total = 0;
    loop {
        let mut kept = Vec::new();
        let (read, fits) = read_record_capped(reader, separator, &mut kept)?;
        total += read;
        if read == 0 {
            return Ok((Vec::new(), total));
        }
        if !fits {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "The file's first line is longer than Saturn reads, so it has no usable header.",
            ));
        }
        if without_line_end(&kept).is_empty() {
            continue;
        }
        let fields = split_fields(without_line_end(&kept), separator);
        return Ok((column_names(fields), total));
    }
}

impl<R: BufRead> Rows<R> {
    /// Rows from where the reader stands, which is `offset` into the file. A delimited file brings its columns; a JSON
    /// array read from a later row has already `begun`.
    pub(super) fn new(
        reader: R,
        shape: Shape,
        offset: u64,
        columns: Vec<String>,
        begun: bool,
    ) -> Self {
        Self {
            reader,
            shape,
            offset,
            columns,
            begun,
            ended: false,
            last_size: 0,
        }
    }

    /// The columns a delimited file's header named.
    pub(super) fn columns(&self) -> &[String] {
        &self.columns
    }

    /// The next row and where it begins.
    pub(super) fn next_item(&mut self) -> io::Result<Option<(u64, Item)>> {
        match self.shape {
            Shape::Lines => self.next_line(),
            Shape::Delimited(separator) => self.next_record(separator),
            Shape::JsonArray => self.next_element(),
        }
    }

    /// The next non-blank JSON line.
    fn next_line(&mut self) -> io::Result<Option<(u64, Item)>> {
        loop {
            let start = self.offset;
            let mut kept = Vec::new();
            let (read, fits) = read_line_capped(&mut self.reader, &mut kept)?;
            self.offset += read;
            self.last_size = read as usize;
            if read == 0 {
                return Ok(None);
            }
            if !fits {
                return Ok(Some((start, Item::TooLong)));
            }
            if kept.iter().all(u8::is_ascii_whitespace) {
                continue;
            }
            return Ok(Some((start, json_item(&kept))));
        }
    }

    /// The next non-blank record of a delimited file, as an object by column.
    fn next_record(&mut self, separator: u8) -> io::Result<Option<(u64, Item)>> {
        loop {
            let start = self.offset;
            let mut kept = Vec::new();
            let (read, fits) = read_record_capped(&mut self.reader, separator, &mut kept)?;
            self.offset += read;
            self.last_size = read as usize;
            if read == 0 {
                return Ok(None);
            }
            if !fits {
                return Ok(Some((start, Item::TooLong)));
            }
            let record = without_line_end(&kept);
            if record.is_empty() {
                continue;
            }
            let fields = split_fields(record, separator);
            if fields.len() != self.columns.len() {
                return Ok(Some((
                    start,
                    Item::Malformed {
                        problem: format!(
                            "This row has {} fields where the header has {}.",
                            fields.len(),
                            self.columns.len()
                        ),
                        raw: shown(record),
                    },
                )));
            }
            let row: Map<String, Value> = self
                .columns
                .iter()
                .cloned()
                .zip(fields.into_iter().map(Value::String))
                .collect();
            return Ok(Some((start, Item::Row(Value::Object(row)))));
        }
    }

    /// The next element of a JSON array, found without parsing the whole file.
    fn next_element(&mut self) -> io::Result<Option<(u64, Item)>> {
        if self.ended {
            return Ok(None);
        }
        if !self.begun {
            self.pass(|byte| byte.is_ascii_whitespace())?;
            match self.reader.fill_buf()?.first() {
                Some(b'[') => {
                    self.reader.consume(1);
                    self.offset += 1;
                    self.begun = true;
                }
                None => {
                    self.ended = true;
                    return Ok(None);
                }
                Some(_) => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "This .json file is not an array of rows, so Saturn cannot read it as a table.",
                    ));
                }
            }
        }
        self.pass(|byte| byte.is_ascii_whitespace() || byte == b',')?;
        match self.reader.fill_buf()?.first() {
            Some(b']') => {
                self.ended = true;
                return Ok(None);
            }
            None => {
                self.ended = true;
                return Ok(Some((
                    self.offset,
                    Item::Malformed {
                        problem: "The file ends before its array closes.".to_owned(),
                        raw: String::new(),
                    },
                )));
            }
            Some(_) => {}
        }
        let start = self.offset;
        let (kept, fits, closed) = self.read_element()?;
        self.last_size = (self.offset - start) as usize;
        if !fits {
            self.ended = self.ended || !closed;
            return Ok(Some((start, Item::TooLong)));
        }
        if !closed {
            self.ended = true;
            return Ok(Some((
                start,
                Item::Malformed {
                    problem: "The file ends before this row does.".to_owned(),
                    raw: shown(&kept),
                },
            )));
        }
        Ok(Some((start, json_item(&kept))))
    }

    /// Passes bytes for as long as `wanted` says.
    fn pass(&mut self, wanted: impl Fn(u8) -> bool) -> io::Result<()> {
        loop {
            let buffer = self.reader.fill_buf()?;
            if buffer.is_empty() {
                return Ok(());
            }
            let used = buffer
                .iter()
                .position(|byte| !wanted(*byte))
                .unwrap_or(buffer.len());
            let all = used == buffer.len();
            self.reader.consume(used);
            self.offset += used as u64;
            if !all {
                return Ok(());
            }
        }
    }

    /// One element's bytes, up to a comma or closing bracket at its own depth, which stay unread. Gives what was kept,
    /// whether it all fit, and whether its end was found.
    fn read_element(&mut self) -> io::Result<(Vec<u8>, bool, bool)> {
        let mut kept = Vec::new();
        let mut fits = true;
        let mut depth = 0_u64;
        let mut in_text = false;
        let mut escaped = false;
        loop {
            let buffer = self.reader.fill_buf()?;
            if buffer.is_empty() {
                return Ok((kept, fits, false));
            }
            let mut used = 0;
            let mut closed = false;
            for byte in buffer {
                if in_text {
                    if escaped {
                        escaped = false;
                    } else if *byte == b'\\' {
                        escaped = true;
                    } else if *byte == b'"' {
                        in_text = false;
                    }
                } else {
                    match byte {
                        b'"' => in_text = true,
                        b'{' | b'[' => depth += 1,
                        b'}' | b']' if depth > 0 => depth -= 1,
                        b',' | b']' if depth == 0 => {
                            closed = true;
                            break;
                        }
                        _ => {}
                    }
                }
                used += 1;
            }
            if fits && kept.len() + used <= MAX_ROW {
                kept.extend_from_slice(&buffer[..used]);
            } else {
                fits = false;
                kept.clear();
            }
            self.reader.consume(used);
            self.offset += used as u64;
            if closed {
                return Ok((kept, fits, true));
            }
        }
    }
}

/// A row from its JSON, or why it is not one.
fn json_item(bytes: &[u8]) -> Item {
    match serde_json::from_slice::<Value>(bytes) {
        Ok(value) => Item::Row(value),
        Err(error) => Item::Malformed {
            problem: format!("It is not JSON: {error}."),
            raw: shown(bytes),
        },
    }
}

/// A page of rows from where `rows` stands, and where the next page begins. With `first_index` the rows are numbered from
/// it rather than by where they begin, for the helper's output, whose pages go by row.
pub(super) fn preview_page<R: BufRead>(
    rows: &mut Rows<R>,
    limit: usize,
    first_index: Option<u64>,
) -> io::Result<(Vec<Value>, Option<u64>)> {
    let mut items = Vec::new();
    let mut spent = 0;
    loop {
        let Some((offset, item)) = rows.next_item()? else {
            return Ok((items, None));
        };
        let place = first_index.map_or(offset, |first| first + items.len() as u64);
        if items.len() >= limit || spent >= PAGE_BYTES {
            return Ok((items, Some(place)));
        }
        spent += rows.last_size;
        items.push(match item {
            Item::Row(row) => json!({ "offset": place, "row": row }),
            Item::Malformed { problem, raw } => {
                json!({ "offset": place, "problem": problem, "raw": raw })
            }
            Item::TooLong => json!({
                "offset": place,
                "problem": format!("This row is longer than {MAX_ROW} bytes, so it was left out."),
            }),
        });
    }
}

/// A row as named fields: a row that is not an object is one column called `value`.
fn fields_of(row: &Value) -> Vec<(&str, &Value)> {
    match row {
        Value::Object(fields) => fields
            .iter()
            .map(|(key, value)| (key.as_str(), value))
            .collect(),
        other => vec![("value", other)],
    }
}

/// Whether a value counts as missing.
fn is_missing(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::String(text) => text.is_empty(),
        _ => false,
    }
}

/// A number written as text, as every value of a delimited file is.
fn number_in_text(text: &str) -> Option<f64> {
    text.parse::<f64>().ok().filter(|number| number.is_finite())
}

/// What is known about one column so far.
struct ColumnTally {
    name: String,
    present: u64,
    numbers: u64,
    texts: u64,
    others: u64,
    range: Option<(f64, f64)>,
    lengths: Option<(u64, u64)>,
    /// Each different value by its hash: as much of it as is kept, and how often it came.
    values: HashMap<u64, (String, u64)>,
    capped: bool,
}

impl ColumnTally {
    /// A column not seen before.
    fn new(name: &str) -> Self {
        Self {
            name: name.to_owned(),
            present: 0,
            numbers: 0,
            texts: 0,
            others: 0,
            range: None,
            lengths: None,
            values: HashMap::new(),
            capped: false,
        }
    }

    /// Adds a number to the range.
    fn add_number(&mut self, number: f64) {
        self.numbers += 1;
        self.range = Some(self.range.map_or((number, number), |(low, high)| {
            (low.min(number), high.max(number))
        }));
    }

    /// Adds one value, unless it is missing. Numbers in a delimited file's text count as numbers.
    fn add(&mut self, value: &Value, numbers_in_text: bool) {
        if is_missing(value) {
            return;
        }
        self.present += 1;
        let number = match value {
            Value::Number(number) => number.as_f64(),
            Value::String(text) if numbers_in_text => number_in_text(text),
            _ => None,
        };
        if let Some(number) = number {
            self.add_number(number);
        } else if let Value::String(text) = value {
            self.texts += 1;
            let length = js::length(text) as u64;
            self.lengths = Some(self.lengths.map_or((length, length), |(low, high)| {
                (low.min(length), high.max(length))
            }));
        } else if !value.is_number() {
            self.others += 1;
        }
        let written;
        let text = match value {
            Value::String(text) => text.as_str(),
            other => {
                written = other.to_string();
                written.as_str()
            }
        };
        let mut hasher = DefaultHasher::new();
        text.hash(&mut hasher);
        let key = hasher.finish();
        if let Some(found) = self.values.get_mut(&key) {
            found.1 += 1;
        } else if self.values.len() < MAX_DISTINCT {
            self.values
                .insert(key, (text.chars().take(VALUE_KEPT).collect(), 1));
        } else {
            self.capped = true;
        }
    }

    /// The column as an answer says it, `rows` being how many rows were read.
    fn into_json(self, rows: u64) -> Value {
        let kind = match (self.numbers > 0, self.texts > 0, self.others > 0) {
            (false, false, false) => "empty",
            (true, false, false) => "number",
            (false, true, false) => "text",
            (false, false, true) => "other",
            _ => "mixed",
        };
        let distinct = self.values.len();
        let mut common: Vec<(String, u64)> = self.values.into_values().collect();
        common.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));
        common.truncate(COMMON_SHOWN);
        json!({
            "name": self.name,
            "kind": kind,
            "present": self.present,
            "missing": rows.saturating_sub(self.present),
            "numbers": self.numbers,
            "texts": self.texts,
            "others": self.others,
            "distinct": distinct,
            "distinctCapped": self.capped,
            "common": common.iter().map(|(value, count)| json!({ "value": value, "count": count })).collect::<Vec<_>>(),
            "range": self.range.map(|(min, max)| json!({ "min": min, "max": max })),
            "lengths": self.lengths.map(|(min, max)| json!({ "min": min, "max": max })),
        })
    }
}

/// Reads every row and says what its columns hold. Memory stays within the limits at the top of this file, whatever the file.
pub(super) fn profile_rows<R: BufRead>(
    rows: &mut Rows<R>,
    numbers_in_text: bool,
) -> io::Result<Value> {
    let (mut count, mut malformed, mut too_long) = (0_u64, 0_u64, 0_u64);
    let mut columns: Vec<ColumnTally> = rows
        .columns()
        .iter()
        .take(MAX_COLUMNS)
        .map(|name| ColumnTally::new(name))
        .collect();
    let mut places: HashMap<String, usize> = columns
        .iter()
        .enumerate()
        .map(|(place, column)| (column.name.clone(), place))
        .collect();
    let mut left_out = false;
    while let Some((_, item)) = rows.next_item()? {
        let row = match item {
            Item::Row(row) => row,
            Item::Malformed { .. } => {
                malformed += 1;
                continue;
            }
            Item::TooLong => {
                too_long += 1;
                continue;
            }
        };
        count += 1;
        for (name, value) in fields_of(&row) {
            let place = match places.get(name) {
                Some(place) => *place,
                None if columns.len() < MAX_COLUMNS => {
                    columns.push(ColumnTally::new(name));
                    places.insert(name.to_owned(), columns.len() - 1);
                    columns.len() - 1
                }
                None => {
                    left_out = true;
                    continue;
                }
            };
            columns[place].add(value, numbers_in_text);
        }
    }
    Ok(json!({
        "rows": count,
        "malformed": malformed,
        "tooLong": too_long,
        "columnsCapped": left_out,
        "columns": columns.into_iter().map(|column| column.into_json(count)).collect::<Vec<_>>(),
    }))
}

/// A value in the form rows are compared in: object keys in order, and a number or a boolean as its text, since a delimited
/// file holds only text.
fn comparable(value: &Value) -> Value {
    match value {
        Value::Object(fields) => {
            let mut keys: Vec<&String> = fields.keys().collect();
            keys.sort();
            Value::Object(
                keys.into_iter()
                    .map(|key| (key.clone(), comparable(&fields[key])))
                    .collect(),
            )
        }
        Value::Array(items) => Value::Array(items.iter().map(comparable).collect()),
        Value::Number(number) => Value::String(number.to_string()),
        Value::Bool(flag) => Value::String(flag.to_string()),
        other => other.clone(),
    }
}

/// The hash a row is compared by: its whole canonical form with missing fields left out, or the chosen columns in order.
/// A row with none of the chosen columns has none, since rows that lack them are not the same row.
pub(super) fn row_hash(row: &Value, columns: Option<&[String]>) -> Option<u128> {
    let fields = fields_of(row);
    let form = match columns {
        Some(columns) => {
            let chosen: Vec<Value> = columns
                .iter()
                .map(|column| {
                    fields
                        .iter()
                        .find(|(name, _)| *name == column.as_str())
                        .map_or(Value::Null, |(_, value)| {
                            if is_missing(value) {
                                Value::Null
                            } else {
                                comparable(value)
                            }
                        })
                })
                .collect();
            if chosen.iter().all(Value::is_null) {
                return None;
            }
            Value::Array(chosen)
        }
        None => {
            let kept: Map<String, Value> = fields
                .iter()
                .filter(|(_, value)| !is_missing(value))
                .map(|(name, value)| ((*name).to_owned(), (*value).clone()))
                .collect();
            comparable(&Value::Object(kept))
        }
    };
    let digest = Sha256::digest(form.to_string().as_bytes());
    let mut bytes = [0; 16];
    bytes.copy_from_slice(&digest[..16]);
    Some(u128::from_be_bytes(bytes))
}

/// What one file of an overlap came to.
#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct OverlapSide {
    pub rows: u64,
    pub malformed: u64,
    pub too_long: u64,
    /// Rows without any of the chosen columns, which are not compared.
    pub without_columns: u64,
    /// Rows identical to some row of the other file.
    pub in_both: u64,
}

impl OverlapSide {
    /// Counts one item, giving its hash when it is a row that can be compared.
    fn count(&mut self, item: Item, columns: Option<&[String]>) -> Option<u128> {
        match item {
            Item::Row(row) => {
                self.rows += 1;
                let hash = row_hash(&row, columns);
                if hash.is_none() {
                    self.without_columns += 1;
                }
                hash
            }
            Item::Malformed { .. } => {
                self.malformed += 1;
                None
            }
            Item::TooLong => {
                self.too_long += 1;
                None
            }
        }
    }
}

/// What an overlap between two files came to.
#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct Overlap {
    pub first: OverlapSide,
    pub second: OverlapSide,
    /// Different rows found in both.
    pub shared_distinct: u64,
    /// Whether the first file had more different rows than are remembered, so that the counts are the least there are.
    pub capped: bool,
}

/// Counts the rows two files share: the first file's hashes are kept, up to `most`, and the second is read past them.
pub(super) fn overlap_rows<A: BufRead, B: BufRead>(
    first: &mut Rows<A>,
    second: &mut Rows<B>,
    columns: Option<&[String]>,
    most: usize,
) -> io::Result<Overlap> {
    let mut answer = Overlap::default();
    let mut seen: HashMap<u128, (u32, bool)> = HashMap::new();
    while let Some((_, item)) = first.next_item()? {
        let Some(hash) = answer.first.count(item, columns) else {
            continue;
        };
        if let Some(found) = seen.get_mut(&hash) {
            found.0 = found.0.saturating_add(1);
        } else if seen.len() < most {
            seen.insert(hash, (1, false));
        } else {
            answer.capped = true;
        }
    }
    while let Some((_, item)) = second.next_item()? {
        let Some(hash) = answer.second.count(item, columns) else {
            continue;
        };
        if let Some(found) = seen.get_mut(&hash) {
            answer.second.in_both += 1;
            if !found.1 {
                found.1 = true;
                answer.shared_distinct += 1;
                answer.first.in_both += u64::from(found.0);
            }
        }
    }
    Ok(answer)
}

/// The words of a name, in lower case: split at anything not a letter or digit and where a capital follows a small letter,
/// with a word's trailing digits off, so that `test2` and `testSet` say what they look like.
fn name_words(name: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut previous_small = false;
    for letter in name.chars() {
        if (!letter.is_alphanumeric() || (letter.is_uppercase() && previous_small))
            && !word.is_empty()
        {
            words.push(std::mem::take(&mut word));
        }
        if letter.is_alphanumeric() {
            word.extend(letter.to_lowercase());
        }
        previous_small = letter.is_lowercase();
    }
    if !word.is_empty() {
        words.push(word);
    }
    words
        .into_iter()
        .map(|word| {
            word.trim_end_matches(|letter: char| letter.is_ascii_digit())
                .to_owned()
        })
        .collect()
}

/// Whether words read as a test split.
fn words_say_test(words: &[String]) -> bool {
    words.iter().any(|word| {
        matches!(
            word.as_str(),
            "test" | "testing" | "testset" | "holdout" | "heldout"
        )
    }) || words
        .windows(2)
        .any(|pair| pair[0] == "held" && pair[1] == "out")
}

/// Whether words read as a split that is not the test one.
fn words_say_other_split(words: &[String]) -> bool {
    words.iter().any(|word| {
        matches!(
            word.as_str(),
            "train" | "training" | "val" | "valid" | "validation" | "dev"
        )
    })
}

/// Whether a declared split's name says it is a test split.
pub(super) fn split_says_test(split: &str) -> bool {
    words_say_test(&name_words(split))
}

/// Whether a file's name looks like a test split: its own name, or else the folder right above it. A name is not proof.
pub(super) fn looks_like_test(path: &str) -> bool {
    let mut parts = path.rsplit(['/', '\\']);
    let name = parts.next().unwrap_or("");
    let stem = name.rsplit_once('.').map_or(name, |(stem, _)| stem);
    let words = name_words(stem);
    if words_say_test(&words) {
        return true;
    }
    if words_say_other_split(&words) {
        return false;
    }
    parts
        .next()
        .is_some_and(|folder| words_say_test(&name_words(folder)))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Rows over bytes in memory.
    fn rows(shape: Shape, bytes: &[u8]) -> Rows<&[u8]> {
        let mut reader = bytes;
        let columns = match shape {
            Shape::Delimited(separator) => read_header(&mut reader, separator).unwrap().0,
            _ => Vec::new(),
        };
        let offset = (bytes.len() - reader.len()) as u64;
        Rows::new(reader, shape, offset, columns, false)
    }

    /// Every item of some rows.
    fn all(mut rows: Rows<&[u8]>) -> Vec<Item> {
        let mut items = Vec::new();
        while let Some((_, item)) = rows.next_item().unwrap() {
            items.push(item);
        }
        items
    }

    #[test]
    fn a_name_looks_like_a_test_split_by_its_words_not_by_the_letters_in_it() {
        for name in [
            "data/test.jsonl",
            "test-00000-of-00001.parquet",
            "splits/test/part-0.csv",
            "eval_test2.csv",
            "myTestSet.tsv",
            "heldout.json",
            "held-out.csv",
            "TEST.JSONL",
        ] {
            assert!(looks_like_test(name), "{name}");
        }
        for name in [
            "data/train.jsonl",
            "latest.csv",
            "contest.json",
            "attest.csv",
            "tests/fixtures/train.jsonl",
            "test/train.jsonl",
            "tests/a.csv",
            "greatest/x.csv",
        ] {
            assert!(!looks_like_test(name), "{name}");
        }
        assert!(split_says_test("test"));
        assert!(split_says_test("heldout_test"));
        assert!(!split_says_test("validation"));
        assert!(!split_says_test("all"));
    }

    #[test]
    fn a_delimited_record_may_hold_quotes_and_line_breaks_and_a_bad_one_is_only_counted() {
        let items = all(rows(
            Shape::Delimited(b','),
            b"a,b\r\n1,\"two, with \"\"quotes\"\"\nand a break\"\r\n\n3\n4,5\n",
        ));
        assert_eq!(
            items[0],
            Item::Row(json!({ "a": "1", "b": "two, with \"quotes\"\nand a break" }))
        );
        assert!(
            matches!(&items[1], Item::Malformed { problem, .. } if problem.contains("1 fields"))
        );
        assert_eq!(items[2], Item::Row(json!({ "a": "4", "b": "5" })));
        assert_eq!(items.len(), 3);
        assert_eq!(
            column_names(vec!["a".into(), String::new(), "a".into()]),
            ["a", "column_2", "a_2"]
        );
    }

    #[test]
    fn an_unclosed_quote_cannot_swallow_the_file() {
        let mut bytes = b"a\tb\n\"open\tx\n".to_vec();
        bytes.extend(std::iter::repeat_n(b'y', MAX_ROW + 10));
        bytes.extend_from_slice(b"\nleft\tright\n");
        let items = all(rows(Shape::Delimited(b'\t'), &bytes));
        assert_eq!(items[0], Item::TooLong);
        assert_eq!(items[1], Item::Row(json!({ "a": "left", "b": "right" })));
    }

    #[test]
    fn a_json_array_gives_its_elements_one_by_one_and_says_when_it_ends_early() {
        let items = all(rows(
            Shape::JsonArray,
            br#" [ {"a":[1,2],"b":"x,]"} , {bad}, 3 ]"#,
        ));
        assert_eq!(items[0], Item::Row(json!({ "a": [1, 2], "b": "x,]" })));
        assert!(matches!(items[1], Item::Malformed { .. }));
        assert_eq!(items[2], Item::Row(json!(3)));
        assert_eq!(items.len(), 3);
        let cut = all(rows(Shape::JsonArray, br#"[{"a":1},{"a"#));
        assert_eq!(cut[0], Item::Row(json!({ "a": 1 })));
        assert!(
            matches!(&cut[1], Item::Malformed { problem, .. } if problem.contains("ends before"))
        );
        let mut not_array = rows(Shape::JsonArray, br#"{"a":1}"#);
        assert_eq!(
            not_array.next_item().unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
    }

    #[test]
    fn a_long_line_is_counted_and_passed_without_being_kept() {
        let mut bytes = vec![b'x'; MAX_ROW + 1];
        bytes.extend_from_slice(b"\n{\"a\":1}\n");
        let mut read = rows(Shape::Lines, &bytes);
        assert_eq!(read.next_item().unwrap().unwrap().1, Item::TooLong);
        assert_eq!(
            read.next_item().unwrap().unwrap(),
            (MAX_ROW as u64 + 2, Item::Row(json!({ "a": 1 })))
        );
        assert_eq!(read.next_item().unwrap(), None);
    }

    #[test]
    fn a_profile_says_what_each_column_holds_and_stops_counting_at_its_limit() {
        let mut bytes = Vec::new();
        for index in 0..(MAX_DISTINCT + 50) {
            bytes.extend_from_slice(format!("{{\"id\":{index},\"word\":\"same\"}}\n").as_bytes());
        }
        bytes.extend_from_slice(b"{\"id\":null,\"word\":\"\",\"mix\":[1]}\nnot json\n");
        let answer = profile_rows(&mut rows(Shape::Lines, &bytes), false).unwrap();
        assert_eq!(answer["rows"], MAX_DISTINCT as u64 + 51);
        assert_eq!(answer["malformed"], 1);
        let id = &answer["columns"][0];
        assert_eq!(id["kind"], "number");
        assert_eq!(id["missing"], 1);
        assert_eq!(id["distinct"], MAX_DISTINCT);
        assert_eq!(id["distinctCapped"], true);
        assert_eq!(id["range"]["max"], (MAX_DISTINCT + 49) as f64);
        let word = &answer["columns"][1];
        assert_eq!(word["kind"], "text");
        assert_eq!(word["common"][0]["value"], "same");
        assert_eq!(word["lengths"]["max"], 4);
        assert_eq!(answer["columns"][2]["kind"], "other");
        let numbers = profile_rows(
            &mut rows(Shape::Delimited(b','), b"n,t\n1.5,a\n,2\n-3,b\n"),
            true,
        )
        .unwrap();
        assert_eq!(numbers["columns"][0]["kind"], "number");
        assert_eq!(numbers["columns"][0]["missing"], 1);
        assert_eq!(
            numbers["columns"][0]["range"],
            json!({ "min": -3.0, "max": 1.5 })
        );
        assert_eq!(numbers["columns"][1]["kind"], "mixed");
    }

    #[test]
    fn a_row_is_the_same_row_whatever_the_order_of_its_keys_or_the_format_it_came_in() {
        assert_eq!(
            row_hash(&json!({ "a": 1, "b": "x" }), None),
            row_hash(&json!({ "b": "x", "a": "1" }), None)
        );
        assert_eq!(
            row_hash(&json!({ "a": 1, "b": null }), None),
            row_hash(&json!({ "a": 1 }), None)
        );
        assert_ne!(
            row_hash(&json!({ "a": 1 }), None),
            row_hash(&json!({ "a": 2 }), None)
        );
        let chosen = ["a".to_owned()];
        assert_eq!(
            row_hash(&json!({ "a": 1, "b": 2 }), Some(&chosen)),
            row_hash(&json!({ "a": 1, "b": 3 }), Some(&chosen))
        );
        assert_eq!(row_hash(&json!({ "b": 3 }), Some(&chosen)), None);
    }

    #[test]
    fn an_overlap_counts_both_sides_and_says_when_it_ran_out_of_room() {
        let left = b"{\"a\":1}\n{\"a\":1}\n{\"a\":2}\n{\"a\":3}\nbad\n";
        let right = b"{\"a\":1}\n{\"a\":3}\n{\"a\":3}\n{\"a\":4}\n";
        let found = overlap_rows(
            &mut rows(Shape::Lines, left),
            &mut rows(Shape::Lines, right),
            None,
            100,
        )
        .unwrap();
        assert_eq!(found.first.rows, 4);
        assert_eq!(found.first.malformed, 1);
        assert_eq!(found.first.in_both, 3);
        assert_eq!(found.second.rows, 4);
        assert_eq!(found.second.in_both, 3);
        assert_eq!(found.shared_distinct, 2);
        assert!(!found.capped);
        let small = overlap_rows(
            &mut rows(Shape::Lines, left),
            &mut rows(Shape::Lines, right),
            None,
            1,
        )
        .unwrap();
        assert!(small.capped);
        assert_eq!(
            small.shared_distinct, 1,
            "only what was remembered is found"
        );
    }
}
