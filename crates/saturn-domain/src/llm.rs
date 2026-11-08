//! What Saturn knows about model providers: who needs a key, and what a call costs.
use crate::time::{civil_date, days_from_civil, weekday};

/// A provider Saturn can talk to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LlmProvider {
    pub id: &'static str,
    pub label: &'static str,
    pub needs_key: bool,
    pub base_url: &'static str,
}

/// The providers, without the model lists the settings page shows.
const LLM_PROVIDERS: [LlmProvider; 7] = [
    LlmProvider {
        id: "openai",
        label: "OpenAI",
        needs_key: true,
        base_url: "https://api.openai.com/v1",
    },
    LlmProvider {
        id: "claude",
        label: "Claude",
        needs_key: true,
        base_url: "https://api.anthropic.com",
    },
    LlmProvider {
        id: "claude-code",
        label: "Claude (via Claude Code)",
        needs_key: false,
        base_url: "",
    },
    LlmProvider {
        id: "codex",
        label: "Codex (your ChatGPT plan)",
        needs_key: false,
        base_url: "",
    },
    LlmProvider {
        id: "gemini",
        label: "Gemini",
        needs_key: true,
        base_url: "https://generativelanguage.googleapis.com",
    },
    LlmProvider {
        id: "deepseek",
        label: "DeepSeek",
        needs_key: true,
        base_url: "https://api.deepseek.com",
    },
    // A model server on this computer with OpenAI-compatible endpoints: LM Studio, Ollama, vLLM, llama.cpp or mlx_lm.server.
    // The id is the name it had when it only meant LM Studio, kept for saved connections and records.
    LlmProvider {
        id: "lmstudio",
        label: "Local server",
        needs_key: false,
        base_url: "http://127.0.0.1:1234",
    },
];

pub fn llm_provider(id: &str) -> Option<&'static LlmProvider> {
    LLM_PROVIDERS.iter().find(|provider| provider.id == id)
}

/// Providers whose models run on this computer, through a model server the user started: they take no key and cost nothing.
pub fn runs_locally(provider: &str) -> bool {
    provider == "lmstudio"
}

/// Providers that run on the user's own subscription through the vendor's official program. Saturn never sends an API
/// request for their models.
pub fn runs_on_plan(provider: &str) -> bool {
    matches!(provider, "claude-code" | "codex")
}

/// USD per 1M tokens. A rate without a cache price bills cached tokens as ordinary input.
#[derive(Clone, Copy)]
struct Rate {
    input: f64,
    output: f64,
    cached: Option<f64>,
    cache_write: Option<f64>,
}

const fn rate(input: f64, output: f64, cached: f64) -> Rate {
    Rate {
        input,
        output,
        cached: Some(cached),
        cache_write: None,
    }
}

const fn claude_rate(input: f64, output: f64, cached: f64, cache_write: f64) -> Rate {
    Rate {
        input,
        output,
        cached: Some(cached),
        cache_write: Some(cache_write),
    }
}

/// How a model is priced.
#[derive(Clone, Copy)]
struct Pricing {
    rate: Rate,
    /// A dated price change: `rate` applies before this UTC date, the second value from then on.
    until: Option<((i64, u32, u32), Rate)>,
    /// A higher rate when the prompt is larger than this many input tokens.
    long_context: Option<(u64, Rate)>,
    /// DeepSeek: `rate` is off-peak, this applies during peak hours.
    peak: Option<Rate>,
}

const fn plain(rate: Rate) -> Pricing {
    Pricing {
        rate,
        until: None,
        long_context: None,
        peak: None,
    }
}

const fn long(rate: Rate, above: u64, higher: Rate) -> Pricing {
    Pricing {
        rate,
        until: None,
        long_context: Some((above, higher)),
        peak: None,
    }
}

const fn dated(rate: Rate, date: (i64, u32, u32), after: Rate) -> Pricing {
    Pricing {
        rate,
        until: Some((date, after)),
        long_context: None,
        peak: None,
    }
}

const fn peaked(rate: Rate, peak: Rate) -> Pricing {
    Pricing {
        rate,
        until: None,
        long_context: None,
        peak: Some(peak),
    }
}

/// Official list prices, USD per 1M tokens, standard tier, checked 2026-10-18 against each provider's pricing page (cached
/// rates 2026-10-21). Models missing here (custom endpoints,
/// models not on the price pages) are reported as unpriced, never guessed.
fn pricing(provider: &str, model: &str) -> Option<Pricing> {
    Some(match (provider, model) {
        ("openai", "gpt-6-astra") => long(rate(10.0, 50.0, 1.0), 272_000, rate(20.0, 75.0, 2.0)),
        ("openai", "gpt-6.1-sol") => long(rate(2.0, 10.0, 0.1), 272_000, rate(4.0, 15.0, 0.2)),
        ("openai", "gpt-6-luna") => long(rate(0.1, 0.5, 0.01), 272_000, rate(0.2, 0.75, 0.02)),

        // Mythos 5.1 is Fable 5.1 for verified organizations: the same model at the same price (checked 2026-11-08).
        ("claude", "claude-fable-5-1" | "claude-mythos-5-1") => {
            plain(claude_rate(10.0, 50.0, 0.25, 12.5))
        }
        ("claude", "claude-opus-5-5") => plain(claude_rate(4.0, 20.0, 0.2, 5.0)),
        ("claude", "claude-sonnet-5-5") => plain(claude_rate(2.0, 10.0, 0.1, 2.5)),
        ("claude", "claude-haiku-4-5") => plain(claude_rate(1.0, 5.0, 0.1, 1.25)),

        ("gemini", "gemini-4-argon") => {
            dated(rate(2.0, 10.0, 0.1), (2026, 12, 1), rate(4.0, 20.0, 0.2))
        }
        ("gemini", "gemini-3.8-flash" | "gemini-3.6-flash") => {
            dated(rate(0.75, 3.75, 0.075), (2027, 1, 1), rate(1.5, 7.5, 0.15))
        }
        ("gemini", "gemini-3.5-flash-lite") => plain(rate(0.3, 2.5, 0.03)),
        ("gemini", "gemini-3.1-pro-preview") => {
            long(rate(2.0, 12.0, 0.2), 200_000, rate(4.0, 18.0, 0.4))
        }
        ("gemini", "gemini-3.1-flash-lite") => plain(rate(0.25, 1.5, 0.025)),
        ("gemini", "gemini-2.5-pro") => {
            long(rate(1.25, 10.0, 0.125), 200_000, rate(2.5, 15.0, 0.25))
        }
        ("gemini", "gemini-2.5-flash") => plain(rate(0.3, 2.5, 0.03)),

        ("deepseek", "deepseek-flash" | "deepseek-v4-flash") => {
            peaked(rate(0.15, 0.6, 0.003), rate(0.3, 1.2, 0.006))
        }
        ("deepseek", "deepseek-v4-pro") => peaked(rate(0.66, 1.98, 0.022), rate(1.32, 3.96, 0.044)),
        _ => return None,
    })
}

/// One call to price.
#[derive(Clone, Copy, Debug)]
pub struct CallToPrice<'a> {
    pub provider: &'a str,
    pub model: &'a str,
    /// False for a custom endpoint, which is not billed at the provider's list price.
    pub hosted: bool,
    /// When the call was made, in milliseconds since 1970.
    pub at: i64,
    /// Every prompt token, cached and written included (long-context tiers go by this total).
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// Of `input_tokens`: read from the provider's cache, and written to it.
    pub cached_tokens: u64,
    pub cache_write_tokens: u64,
}

/// What a call cost, at the rates in force when it was made.
#[derive(Clone, Debug, PartialEq)]
pub struct PricedCall {
    pub input_rate: f64,
    pub output_rate: f64,
    /// The rates the call's cached and cache-written tokens were billed at (the input rate when none is listed).
    pub cached_rate: f64,
    pub cache_write_rate: f64,
    /// Which price applied: "standard", "long context", "peak", "off-peak", "local", or a dated-change label.
    pub tier: String,
    pub cost_usd: f64,
}

/// DeepSeek's peak hours: 01:00-04:00 and 06:00-10:00 UTC, Monday to Friday (Chinese public holidays are not modelled).
pub fn deep_seek_peak(at: i64) -> bool {
    let day = weekday(at.div_euclid(86_400_000));
    let hour = at.rem_euclid(86_400_000) / 3_600_000;
    (1..=5).contains(&day) && ((1..4).contains(&hour) || (6..10).contains(&hour))
}

/// The price of one call, or `None` when it has no official price. A local model costs nothing.
pub fn price_call(call: &CallToPrice) -> Option<PricedCall> {
    if runs_locally(call.provider) {
        return Some(PricedCall {
            input_rate: 0.0,
            output_rate: 0.0,
            cached_rate: 0.0,
            cache_write_rate: 0.0,
            tier: "local".to_owned(),
            cost_usd: 0.0,
        });
    }
    if !call.hosted {
        return None;
    }
    let price = pricing(call.provider, call.model)?;
    let mut rate = price.rate;
    let mut tier = "standard".to_owned();
    if let Some(((year, month, day), after)) = price.until {
        let days = days_from_civil(year, month, day);
        if call.at >= days * 86_400_000 {
            rate = after;
        } else {
            let (year, month, day) = civil_date(days);
            tier = format!("until {year:04}-{month:02}-{day:02}");
        }
    }
    if let Some((above, higher)) = price.long_context
        && call.input_tokens > above
    {
        rate = higher;
        tier = "long context".to_owned();
    }
    if let Some(peak) = price.peak {
        let in_peak = deep_seek_peak(call.at);
        rate = if in_peak { peak } else { price.rate };
        tier = if in_peak { "peak" } else { "off-peak" }.to_owned();
    }
    let cached = call.cached_tokens.min(call.input_tokens);
    let written = call.cache_write_tokens.min(call.input_tokens - cached);
    let cached_rate = rate.cached.unwrap_or(rate.input);
    let cache_write_rate = rate.cache_write.unwrap_or(rate.input);
    let uncached = call.input_tokens - cached - written;
    Some(PricedCall {
        input_rate: rate.input,
        output_rate: rate.output,
        cached_rate,
        cache_write_rate,
        tier,
        cost_usd: (uncached as f64 * rate.input
            + cached as f64 * cached_rate
            + written as f64 * cache_write_rate
            + call.output_tokens as f64 * rate.output)
            / 1_000_000.0,
    })
}

/// A model's price in words, for the usage page; `None` when it has no list price.
pub fn describe_price(provider: &str, model: &str, at: i64) -> Option<String> {
    if runs_locally(provider) {
        return Some("Local · free".to_owned());
    }
    let price = pricing(provider, model)?;
    let money = |value: f64| {
        if value < 0.1 {
            format!("${value:.3}")
        } else {
            format!("${value:.2}")
        }
    };
    let pair = |rate: &Rate| {
        let cached = rate.cached.map_or(String::new(), |cached| {
            format!(" ({} cached)", money(cached))
        });
        format!(
            "{} in{cached} / {} out",
            money(rate.input),
            money(rate.output)
        )
    };
    let dated = price.until.as_ref().map(|((year, month, day), after)| {
        (
            days_from_civil(*year, *month, *day) * 86_400_000,
            (*year, *month, *day),
            after,
        )
    });
    let changed = dated.as_ref().is_some_and(|(from, _, _)| at >= *from);
    let current = match &dated {
        Some((_, _, after)) if changed => after,
        _ => &price.rate,
    };
    let mut notes = Vec::new();
    if let Some((_, (year, month, day), after)) = dated.as_ref().filter(|_| !changed) {
        notes.push(format!(
            "{} from {year:04}-{month:02}-{day:02}",
            pair(after)
        ));
    }
    if let Some((above, higher)) = &price.long_context {
        notes.push(format!(
            "{} above {}K input",
            pair(higher),
            (*above as f64 / 1000.0).round()
        ));
    }
    if let Some(peak) = &price.peak {
        return Some(format!(
            "{} off-peak · {} peak (UTC 01-04, 06-10 weekdays) · per 1M tokens",
            pair(&price.rate),
            pair(peak)
        ));
    }
    let extra = if notes.is_empty() {
        String::new()
    } else {
        format!(" · {}", notes.join(" · "))
    };
    Some(format!("{} per 1M tokens{extra}", pair(current)))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Mythos 5.1 is Fable 5.1 for verified organizations, so a call to either is billed the same.
    #[test]
    fn mythos_is_priced_as_fable() {
        let call = |model| CallToPrice {
            provider: "claude",
            model,
            hosted: true,
            at: 1_793_000_000_000,
            input_tokens: 1_000,
            output_tokens: 200,
            cached_tokens: 100,
            cache_write_tokens: 50,
        };
        let fable = price_call(&call("claude-fable-5-1")).unwrap();
        let mythos = price_call(&call("claude-mythos-5-1")).unwrap();
        assert_eq!(mythos, fable);
        assert_eq!(mythos.input_rate, 10.0);
        assert_eq!(mythos.output_rate, 50.0);
        assert_eq!(
            describe_price("claude", "claude-mythos-5-1", 0),
            describe_price("claude", "claude-fable-5-1", 0)
        );
    }
}
