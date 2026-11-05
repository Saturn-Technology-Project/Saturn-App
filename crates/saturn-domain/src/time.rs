//! Times as Saturn saves them: UTC, in the form `Date.toISOString` writes.
use jiff::Timestamp;
use jiff::civil::Date;
use jiff::tz::TimeZone;
use std::time::{SystemTime, UNIX_EPOCH};

/// Milliseconds since 1970-01-01 UTC.
pub fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as i64)
}

/// A time like `2026-11-03T05:37:09.916Z`. A time past the year 9999 either way, which no clock gives, reads as the nearest time
/// jiff can hold.
pub fn iso_time(millis: i64) -> String {
    let (earliest, latest) = (
        Timestamp::MIN.as_millisecond(),
        Timestamp::MAX.as_millisecond(),
    );
    let at = Timestamp::from_millisecond(millis.clamp(earliest, latest))
        .unwrap_or(Timestamp::UNIX_EPOCH);
    let time = at.to_zoned(TimeZone::UTC).datetime();
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        time.year(),
        time.month(),
        time.day(),
        time.hour(),
        time.minute(),
        time.second(),
        time.millisecond()
    )
}

/// The calendar date of a day counted from 1970-01-01. Days past the year 9999 either way read as the nearest date jiff can hold.
pub fn civil_date(days: i64) -> (i64, u32, u32) {
    let (earliest, latest) = (Timestamp::MIN.as_second(), Timestamp::MAX.as_second());
    let seconds = days.saturating_mul(86_400).clamp(earliest, latest);
    let date = Timestamp::from_second(seconds)
        .unwrap_or(Timestamp::UNIX_EPOCH)
        .to_zoned(TimeZone::UTC)
        .date();
    (
        i64::from(date.year()),
        u32::try_from(date.month()).unwrap_or(1),
        u32::try_from(date.day()).unwrap_or(1),
    )
}

/// The day counted from 1970-01-01 of a calendar date, or `None` for a year jiff cannot hold (past 9999 either way) or a month
/// outside 1 to 12. A day past the end of its month runs on into the next, as it always has here.
fn checked_days_from_civil(year: i64, month: u32, day: u32) -> Option<i64> {
    let first = Date::new(i16::try_from(year).ok()?, i8::try_from(month).ok()?, 1).ok()?;
    let start = first.at(0, 0, 0, 0).to_zoned(TimeZone::UTC).ok()?;
    Some(start.timestamp().as_second().div_euclid(86_400) + i64::from(day) - 1)
}

/// The day counted from 1970-01-01 of a calendar date. A year jiff cannot hold counts as the nearest one it can, a month outside 1
/// to 12 as the nearest month.
pub fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    checked_days_from_civil(year.clamp(-9999, 9999), month.clamp(1, 12), day).unwrap_or(0)
}

/// The day of the week of a day counted from 1970-01-01; 0 is Sunday.
pub fn weekday(days: i64) -> u32 {
    (days + 4).rem_euclid(7) as u32
}

/// The milliseconds of a date or time as JavaScript reads one: `2026-11-03T05:37:09.916Z`, the fraction and seconds optional, with `Z`
/// or an offset such as `+08:00`, or a date alone, which means its start in UTC. A time with no zone is refused: which day it means
/// would depend on this computer.
pub fn parse_iso(text: &str) -> Option<i64> {
    let (date, time) = match text.split_once('T') {
        Some((date, time)) => (date, Some(time)),
        None => (text, None),
    };
    let mut parts = date.split('-');
    let year: i64 = parts.next()?.parse().ok()?;
    let month: u32 = parts.next()?.parse().ok()?;
    let day: u32 = parts.next()?.parse().ok()?;
    if parts.next().is_some() || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let midnight = checked_days_from_civil(year, month, day)? * 86_400_000;
    let Some(time) = time else {
        return Some(midnight);
    };
    let (time, offset_minutes) = if let Some(time) = time.strip_suffix('Z') {
        (time, 0)
    } else {
        let at = time.rfind(['+', '-'])?;
        let (time, zone) = time.split_at(at);
        let (hours, minutes) = zone[1..].split_once(':')?;
        let size = hours.parse::<i64>().ok()? * 60 + minutes.parse::<i64>().ok()?;
        (time, if zone.starts_with('-') { -size } else { size })
    };
    let (clock, fraction) = time.split_once('.').unwrap_or((time, "0"));
    let mut pieces = clock.split(':');
    let hours: i64 = pieces.next()?.parse().ok()?;
    let minutes: i64 = pieces.next()?.parse().ok()?;
    let seconds: i64 = pieces
        .next()
        .map_or(Some(0), |seconds| seconds.parse().ok())?;
    let millis: i64 = format!("{fraction:0<3}").get(..3)?.parse().ok()?;
    Some(midnight + (hours * 3600 + minutes * 60 + seconds - offset_minutes * 60) * 1000 + millis)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_and_offsets_read_as_javascript_reads_them() {
        let utc = parse_iso("2026-10-20T00:00:00.000Z");
        assert!(utc.is_some());
        assert_eq!(parse_iso("2026-10-20"), utc);
        assert_eq!(parse_iso("2026-10-20T08:00:00+08:00"), utc);
        assert_eq!(parse_iso("2026-10-19T16:30-07:30"), utc);
        for refused in [
            "2026-10-20T08:00:00",
            "2026-13-01",
            "2026-10-20-01",
            "soon",
            "",
        ] {
            assert_eq!(parse_iso(refused), None, "{refused}");
        }
    }

    #[test]
    fn times_read_as_javascript_writes_them() {
        assert_eq!(iso_time(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_time(1_709_210_096_789), "2024-02-29T12:34:56.789Z");
        assert_eq!(iso_time(1_793_450_229_916), "2026-10-31T12:37:09.916Z");
    }

    #[test]
    fn dates_convert_both_ways() {
        for days in [-719_468, -1, 0, 59, 19_782, 20_757, 100_000] {
            let (year, month, day) = civil_date(days);
            assert_eq!(days_from_civil(year, month, day), days);
        }
        assert_eq!(days_from_civil(2026, 12, 1) * 86_400_000, 1_796_083_200_000);
        assert_eq!(weekday(0), 4, "1970-01-01 was a Thursday");
        assert_eq!(weekday(days_from_civil(2026, 11, 3)), 2, "a Tuesday");
    }

    #[test]
    fn a_day_past_the_end_of_its_month_runs_on_and_a_year_jiff_cannot_hold_is_refused() {
        assert_eq!(days_from_civil(2026, 2, 31), days_from_civil(2026, 3, 3));
        assert_eq!(parse_iso("2026-02-31"), parse_iso("2026-03-03"));
        assert_eq!(parse_iso("10000-01-01"), None);
        assert_eq!(iso_time(i64::MAX), iso_time(i64::MAX - 1));
        assert_eq!(civil_date(i64::MIN).0, -9999);
    }
}
