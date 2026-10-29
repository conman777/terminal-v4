use chrono::{Datelike, NaiveDate, TimeZone};

pub(crate) const CRON_LIMIT: usize = 256;
const SEARCH_DAYS: u64 = 366 * 8;
const GAP_SEARCH_MINUTES: i64 = 26 * 60;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CronExpr {
    minutes: u64,
    hours: u32,
    days: u32,
    months: u16,
    weekdays: u8,
    day_unrestricted: bool,
    weekday_unrestricted: bool,
}

const MONTH_NAMES: [&str; 12] = [
    "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
];
const WEEKDAY_NAMES: [&str; 7] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

fn value(text: &str, min: u32, max: u32, names: &[&str], name_base: u32) -> Option<u32> {
    if let Some(index) = names
        .iter()
        .position(|name| text.eq_ignore_ascii_case(name))
    {
        return Some(index as u32 + name_base);
    }
    if text.is_empty() || text.len() > 3 || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    text.parse()
        .ok()
        .filter(|number| (min..=max).contains(number))
}

fn field(text: &str, min: u32, max: u32, names: &[&str], name_base: u32) -> Option<(u64, bool)> {
    let mut bits = 0u64;
    let mut unrestricted = false;
    for part in text.split(',') {
        let (range, step) = match part.split_once('/') {
            Some((range, step)) => {
                if step.is_empty()
                    || step.len() > 3
                    || !step.bytes().all(|byte| byte.is_ascii_digit())
                {
                    return None;
                }
                (range, step.parse::<u32>().ok().filter(|step| *step > 0)?)
            }
            None => (part, 1),
        };
        let (low, high) = if range == "*" {
            unrestricted = true;
            (min, max)
        } else if let Some((low, high)) = range.split_once('-') {
            (
                value(low, min, max, names, name_base)?,
                value(high, min, max, names, name_base)?,
            )
        } else {
            let start = value(range, min, max, names, name_base)?;
            (start, if part.contains('/') { max } else { start })
        };
        if low > high {
            return None;
        }
        let mut current = low;
        while current <= high {
            bits |= 1u64 << current;
            current += step;
        }
    }
    Some((bits, unrestricted))
}

impl CronExpr {
    pub(crate) fn parse(text: &str) -> Option<Self> {
        if text.len() > CRON_LIMIT || text.chars().any(char::is_control) {
            return None;
        }
        let parts: Vec<_> = text.split_whitespace().collect();
        let [minute, hour, day, month, weekday] = parts.as_slice() else {
            return None;
        };
        let (minutes, _) = field(minute, 0, 59, &[], 0)?;
        let (hours, _) = field(hour, 0, 23, &[], 0)?;
        let (days, day_unrestricted) = field(day, 1, 31, &[], 0)?;
        let (months, _) = field(month, 1, 12, &MONTH_NAMES, 1)?;
        let (mut weekdays, weekday_unrestricted) = field(weekday, 0, 7, &WEEKDAY_NAMES, 0)?;
        if weekdays & (1 << 7) != 0 {
            weekdays = (weekdays | 1) & 0x7f;
        }
        Some(Self {
            minutes,
            hours: hours as u32,
            days: days as u32,
            months: months as u16,
            weekdays: weekdays as u8,
            day_unrestricted,
            weekday_unrestricted,
        })
    }

    fn matches_date(&self, date: NaiveDate) -> bool {
        if self.months & (1 << date.month()) == 0 {
            return false;
        }
        let day = self.days & (1 << date.day()) != 0;
        let weekday = self.weekdays & (1 << date.weekday().num_days_from_sunday()) != 0;
        if self.day_unrestricted || self.weekday_unrestricted {
            day && weekday
        } else {
            day || weekday
        }
    }

    pub(crate) fn next_after<Z: TimeZone>(&self, zone: &Z, now_ms: i64) -> Option<i64> {
        let instant = chrono::DateTime::from_timestamp_millis(now_ms)?;
        let start = instant
            .with_timezone(zone)
            .date_naive()
            .checked_sub_days(chrono::Days::new(1))?;
        for offset in 0..SEARCH_DAYS {
            let date = start.checked_add_days(chrono::Days::new(offset))?;
            if !self.matches_date(date) {
                continue;
            }
            let mut best: Option<i64> = None;
            for hour in (0..24).filter(|hour| self.hours & (1 << hour) != 0) {
                for minute in (0..60).filter(|minute| self.minutes & (1 << minute) != 0) {
                    let Some(local) = date.and_hms_opt(hour, minute, 0) else {
                        continue;
                    };
                    let Some(candidate) = resolve_local(zone, local) else {
                        continue;
                    };
                    if candidate > now_ms && best.is_none_or(|current| candidate < current) {
                        best = Some(candidate);
                    }
                }
            }
            if best.is_some() {
                return best;
            }
        }
        None
    }
}

/// Folds resolve to their first occurrence; a time inside a spring-forward gap
/// resolves to the first instant after the gap.
fn resolve_local<Z: TimeZone>(zone: &Z, local: chrono::NaiveDateTime) -> Option<i64> {
    use chrono::LocalResult;
    match zone.from_local_datetime(&local) {
        LocalResult::Single(instant) => Some(instant.timestamp_millis()),
        LocalResult::Ambiguous(first, _) => Some(first.timestamp_millis()),
        LocalResult::None => (1..=GAP_SEARCH_MINUTES).find_map(|minutes| {
            let later = local.checked_add_signed(chrono::Duration::minutes(minutes))?;
            match zone.from_local_datetime(&later) {
                LocalResult::Single(instant) => Some(instant.timestamp_millis()),
                LocalResult::Ambiguous(first, _) => Some(first.timestamp_millis()),
                LocalResult::None => None,
            }
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono_tz::Tz;

    fn utc(text: &str) -> i64 {
        chrono::DateTime::parse_from_rfc3339(text)
            .unwrap()
            .timestamp_millis()
    }

    fn next(zone: &str, expression: &str, after: &str) -> String {
        let zone: Tz = zone.parse().unwrap();
        let expr = CronExpr::parse(expression).unwrap();
        let found = expr.next_after(&zone, utc(after)).unwrap();
        chrono::DateTime::from_timestamp_millis(found)
            .unwrap()
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
    }

    #[test]
    fn table_of_expressions_and_their_next_utc_instants() {
        let cases = [
            (
                "UTC",
                "*/15 * * * *",
                "2025-01-06T08:07:00Z",
                "2025-01-06T08:15:00Z",
            ),
            (
                "UTC",
                "0 9 * * 1-5",
                "2025-01-10T09:00:00Z",
                "2025-01-13T09:00:00Z",
            ),
            (
                "UTC",
                "30 4 1,15 * *",
                "2025-01-02T00:00:00Z",
                "2025-01-15T04:30:00Z",
            ),
            (
                "UTC",
                "0 0 29 2 *",
                "2025-03-01T00:00:00Z",
                "2028-02-29T00:00:00Z",
            ),
            (
                "UTC",
                "0 12 * jan-mar sun",
                "2025-01-06T00:00:00Z",
                "2025-01-12T12:00:00Z",
            ),
            (
                "UTC",
                "0 12 * * 7",
                "2025-01-06T00:00:00Z",
                "2025-01-12T12:00:00Z",
            ),
            (
                "UTC",
                "0 0 13 * fri",
                "2025-06-01T00:00:00Z",
                "2025-06-06T00:00:00Z",
            ),
            (
                "UTC",
                "5/20 * * * *",
                "2025-01-06T08:30:00Z",
                "2025-01-06T08:45:00Z",
            ),
            (
                "Asia/Tokyo",
                "0 9 * * *",
                "2025-01-06T00:00:00Z",
                "2025-01-07T00:00:00Z",
            ),
            (
                "Asia/Kolkata",
                "30 8 * * *",
                "2025-01-06T00:00:00Z",
                "2025-01-06T03:00:00Z",
            ),
            (
                "America/New_York",
                "0 9 * * *",
                "2025-01-06T00:00:00Z",
                "2025-01-06T14:00:00Z",
            ),
            (
                "America/New_York",
                "0 9 * * *",
                "2025-07-06T00:00:00Z",
                "2025-07-06T13:00:00Z",
            ),
        ];
        for (zone, expression, after, expected) in cases {
            assert_eq!(
                next(zone, expression, after),
                expected,
                "{zone} {expression}"
            );
        }
    }

    #[test]
    fn spring_forward_gap_runs_once_at_the_first_valid_instant() {
        let cases = [
            (
                "America/New_York",
                "30 2 * * *",
                "2025-03-09T00:00:00Z",
                "2025-03-09T07:00:00Z",
            ),
            (
                "America/New_York",
                "30 2 * * *",
                "2025-03-09T07:00:00Z",
                "2025-03-10T06:30:00Z",
            ),
            (
                "America/New_York",
                "0,30 2 * * *",
                "2025-03-09T00:00:00Z",
                "2025-03-09T07:00:00Z",
            ),
            (
                "America/New_York",
                "0,30 2 * * *",
                "2025-03-09T07:00:00Z",
                "2025-03-10T06:00:00Z",
            ),
            (
                "Europe/Berlin",
                "30 2 * * *",
                "2025-03-30T00:00:00Z",
                "2025-03-30T01:00:00Z",
            ),
            (
                "Europe/Berlin",
                "30 2 * * *",
                "2025-03-30T01:00:00Z",
                "2025-03-31T00:30:00Z",
            ),
            (
                "Australia/Lord_Howe",
                "15 2 * * *",
                "2025-10-04T14:00:00Z",
                "2025-10-04T15:30:00Z",
            ),
        ];
        for (zone, expression, after, expected) in cases {
            assert_eq!(
                next(zone, expression, after),
                expected,
                "{zone} {expression}"
            );
        }
    }

    #[test]
    fn fall_back_repeated_hour_runs_once_at_the_first_occurrence() {
        let cases = [
            (
                "America/New_York",
                "30 1 * * *",
                "2025-11-02T00:00:00Z",
                "2025-11-02T05:30:00Z",
            ),
            (
                "America/New_York",
                "30 1 * * *",
                "2025-11-02T05:30:00Z",
                "2025-11-03T06:30:00Z",
            ),
            (
                "America/New_York",
                "30 1 * * *",
                "2025-11-02T06:00:00Z",
                "2025-11-03T06:30:00Z",
            ),
            (
                "Europe/Berlin",
                "30 2 * * *",
                "2025-10-26T00:00:00Z",
                "2025-10-26T00:30:00Z",
            ),
            (
                "Europe/Berlin",
                "30 2 * * *",
                "2025-10-26T00:30:00Z",
                "2025-10-27T01:30:00Z",
            ),
            (
                "America/New_York",
                "15,45 * * * *",
                "2025-11-02T05:50:00Z",
                "2025-11-02T07:15:00Z",
            ),
        ];
        for (zone, expression, after, expected) in cases {
            assert_eq!(
                next(zone, expression, after),
                expected,
                "{zone} {expression}"
            );
        }
    }

    #[test]
    fn repeated_stepping_never_returns_the_same_instant_twice_across_a_transition() {
        let zone: Tz = "America/New_York".parse().unwrap();
        for expression in ["30 1 * * *", "0,30 2 * * *", "*/20 1-3 * * *"] {
            let expr = CronExpr::parse(expression).unwrap();
            let mut now = utc("2025-11-01T00:00:00Z");
            let mut seen = Vec::new();
            for _ in 0..12 {
                let found = expr.next_after(&zone, now).unwrap();
                assert!(found > now);
                seen.push(found);
                now = found;
            }
            let mut sorted = seen.clone();
            sorted.dedup();
            assert_eq!(seen, sorted);
        }
    }

    #[test]
    fn invalid_expressions_are_rejected() {
        for expression in [
            "",
            "* * * *",
            "* * * * * *",
            "60 * * * *",
            "* 24 * * *",
            "* * 0 * *",
            "* * 32 * *",
            "* * * 13 *",
            "* * * * 8",
            "*/0 * * * *",
            "5-1 * * * *",
            "a * * * *",
            "1,,2 * * * *",
            "*/ * * * *",
            "- * * * *",
            "@daily",
            "1-2-3 * * * *",
            "-1 * * * *",
        ] {
            assert!(CronExpr::parse(expression).is_none(), "{expression:?}");
        }
        assert!(CronExpr::parse(&format!("{} * * * *", "1,".repeat(200))).is_none());
    }

    #[test]
    fn impossible_dates_have_no_next_run() {
        let zone: Tz = "UTC".parse().unwrap();
        let expr = CronExpr::parse("0 0 31 2 *").unwrap();
        assert_eq!(expr.next_after(&zone, utc("2025-01-01T00:00:00Z")), None);
    }
}
