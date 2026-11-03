//! Times as Saturn saves them: UTC, in the form `Date.toISOString` writes.
use std::time::{SystemTime, UNIX_EPOCH};

/// Milliseconds since 1970-01-01 UTC.
pub fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as i64)
}

/// A time like `2026-11-03T05:37:09.916Z`.
pub fn iso_time(millis: i64) -> String {
    let days = millis.div_euclid(86_400_000);
    let clock = millis.rem_euclid(86_400_000);
    let (year, month, day) = civil_date(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        clock / 3_600_000,
        clock % 3_600_000 / 60_000,
        clock % 60_000 / 1000,
        clock % 1000
    )
}

/// The calendar date of a day counted from 1970-01-01 (Howard Hinnant's `civil_from_days`).
pub fn civil_date(days: i64) -> (i64, u32, u32) {
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * shifted_month + 2) / 5 + 1) as u32;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    } as u32;
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// The day counted from 1970-01-01 of a calendar date (Howard Hinnant's `days_from_civil`).
pub fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let year = year - i64::from(month <= 2);
    let era = year.div_euclid(400);
    let year_of_era = year.rem_euclid(400);
    let shifted_month = i64::from((month + 9) % 12);
    let day_of_year = (153 * shifted_month + 2) / 5 + i64::from(day) - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// The day of the week of a day counted from 1970-01-01; 0 is Sunday.
pub fn weekday(days: i64) -> u32 {
    (days + 4).rem_euclid(7) as u32
}

/// The milliseconds of a time as `iso_time` writes it (`2026-11-03T05:37:09.916Z`, fraction optional).
pub fn parse_iso(text: &str) -> Option<i64> {
    let (date, time) = text.strip_suffix('Z')?.split_once('T')?;
    let mut parts = date.split('-');
    let year: i64 = parts.next()?.parse().ok()?;
    let month: u32 = parts.next()?.parse().ok()?;
    let day: u32 = parts.next()?.parse().ok()?;
    let (clock, fraction) = time.split_once('.').unwrap_or((time, "0"));
    let mut pieces = clock.split(':');
    let hours: i64 = pieces.next()?.parse().ok()?;
    let minutes: i64 = pieces.next()?.parse().ok()?;
    let seconds: i64 = pieces.next()?.parse().ok()?;
    let millis: i64 = format!("{fraction:0<3}").get(..3)?.parse().ok()?;
    Some(
        days_from_civil(year, month, day) * 86_400_000
            + (hours * 3600 + minutes * 60 + seconds) * 1000
            + millis,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
