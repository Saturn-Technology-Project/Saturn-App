use url::Url;

const NOT_ALLOWED: &str = "That address is not allowed";

/// An http(s) address an agent may fetch. Loopback and private networks are refused.
pub fn parse_public_address(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|_| "URL is invalid".to_owned())?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("Only http and https URLs are allowed".to_owned());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(NOT_ALLOWED.to_owned());
    }
    if is_private_host(url.host_str().unwrap_or_default()) {
        return Err(NOT_ALLOWED.to_owned());
    }
    Ok(url)
}

/// True for loopback, link-local, private and reserved hosts and addresses (IPv4, IPv6, and IPv4 carried inside IPv6).
pub fn is_private_host(hostname: &str) -> bool {
    let lower = hostname.to_lowercase();
    let unbracketed = lower.strip_prefix('[').unwrap_or(&lower);
    let unbracketed = unbracketed.strip_suffix(']').unwrap_or(unbracketed);
    let host = unbracketed.trim_end_matches('.');
    if host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
    {
        return true;
    }
    if host.contains(':') {
        return is_private_ipv6(host);
    }
    let Some(parts) = dotted_quad(host) else {
        return false;
    };
    if parts.iter().any(|part| *part > 255) {
        return true;
    }
    is_private_ipv4(parts[0], parts[1], parts[2])
}

/// Four parts of one to three digits, each read as a number even when it is too large for a byte.
fn dotted_quad(host: &str) -> Option<[u16; 4]> {
    let parts: Vec<&str> = host.split('.').collect();
    let [a, b, c, d] = parts.as_slice() else {
        return None;
    };
    Some([part(a)?, part(b)?, part(c)?, part(d)?])
}

fn part(text: &str) -> Option<u16> {
    if text.is_empty() || text.len() > 3 || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

/// The IPv4 ranges that are not the public internet, judged by an address's first three bytes.
fn is_private_ipv4(a: u16, b: u16, c: u16) -> bool {
    if a == 0 || a == 10 || a == 127 {
        return true;
    }
    if a == 100 && (64..=127).contains(&b) {
        return true; // Carrier-grade NAT, also what Tailscale uses.
    }
    if a == 169 && b == 254 {
        return true;
    }
    if a == 172 && (16..=31).contains(&b) {
        return true;
    }
    if a == 192 && (b == 168 || (b == 0 && (c == 0 || c == 2))) {
        return true;
    }
    if a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100)) {
        return true;
    }
    if a == 203 && b == 0 && c == 113 {
        return true;
    }
    a >= 224 // Multicast and reserved.
}

/// Judged on the address's eight groups, not its spelling: URL rewrites [::ffff:127.0.0.1] as [::ffff:7f00:1]. An IPv4
/// address carried inside (mapped, NAT64, 6to4) is judged as that address, and what cannot be read is refused.
fn is_private_ipv6(address: &str) -> bool {
    let Some(groups) = ipv6_groups(address) else {
        return true;
    };
    let [first, second, third, _, fifth, sixth, seventh, eighth] = groups;
    let ipv4 = |high: u16, low: u16| is_private_ipv4(high >> 8, high & 0xff, low >> 8);
    let zeros = |from: usize, to: usize| groups[from..to].iter().all(|group| *group == 0);
    if zeros(0, 5) {
        // ::ffff:a.b.c.d, or ::, ::1 and the deprecated ::a.b.c.d.
        return if sixth == 0xffff {
            ipv4(seventh, eighth)
        } else {
            sixth == 0
        };
    }
    if zeros(0, 4) && fifth == 0xffff && sixth == 0 {
        return ipv4(seventh, eighth);
    }
    if first == 0x64 && second == 0xff9b {
        return if zeros(2, 6) {
            ipv4(seventh, eighth)
        } else {
            true
        };
    }
    if first == 0x2002 {
        return ipv4(second, third);
    }
    if first == 0x2001 && second == 0 {
        return true; // Teredo.
    }
    // Unique local, link-local and site-local, multicast.
    (first & 0xfe00) == 0xfc00 || (first & 0xff80) == 0xfe80 || (first & 0xff00) == 0xff00
}

/// An IPv6 address as its eight 16-bit groups, or None when it is not one.
fn ipv6_groups(address: &str) -> Option<[u16; 8]> {
    let mut text = address.split('%').next().unwrap_or_default().to_owned();
    // A dotted ending: everything after the last colon, when it has the shape of an address.
    if let Some(colon) = text.rfind(':')
        && let Some(parts) = dotted_quad(&text[colon + 1..])
    {
        if parts.iter().any(|part| *part > 255) {
            return None;
        }
        let [a, b, c, d] = parts;
        text = format!("{}{:x}:{:x}", &text[..=colon], (a << 8) | b, (c << 8) | d);
    }
    let sides: Vec<&str> = text.split("::").collect();
    if sides.len() > 2 {
        return None;
    }
    let words = |side: &'_ str| -> Vec<String> {
        if side.is_empty() {
            Vec::new()
        } else {
            side.split(':').map(str::to_owned).collect()
        }
    };
    let head = words(sides[0]);
    let tail = words(sides.get(1).copied().unwrap_or_default());
    let total = head.len() + tail.len();
    let missing = if sides.len() == 1 {
        if total != 8 {
            return None;
        }
        0
    } else {
        if total >= 8 {
            return None;
        }
        8 - total
    };
    let zeros = std::iter::repeat_n("0".to_owned(), missing);
    let all: Vec<String> = head.into_iter().chain(zeros).chain(tail).collect();
    let mut groups = [0u16; 8];
    for (group, word) in groups.iter_mut().zip(&all) {
        let valid = (1..=4).contains(&word.len())
            && word
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
        if !valid {
            return None;
        }
        *group = u16::from_str_radix(word, 16).ok()?;
    }
    Some(groups)
}
