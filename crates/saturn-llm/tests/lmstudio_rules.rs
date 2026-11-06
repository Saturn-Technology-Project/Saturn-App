//! Rules LM Studio's connection must keep for any input: an address that ends in /v1 once and only once, and turns that
//! alternate without losing anything said.
use saturn_llm::lmstudio::{alternating, openai_compatible_url};
use saturn_llm::{ChatMessage, Role};

/// A small generator with no dependencies; the same cases on every run.
struct Numbers(u64);

impl Numbers {
    fn below(&mut self, limit: usize) -> usize {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        ((self.0 >> 33) % limit as u64) as usize
    }
}

#[test]
fn the_address_always_ends_in_v1_and_asking_again_changes_nothing() {
    for scheme in ["http", "https", "ws", "wss"] {
        for host in ["localhost", "127.0.0.1", "lm.example", "a-b.test"] {
            for port in [1, 1234, 65535] {
                for path in ["", "/", "/v1", "/v1/", "/lmstudio"] {
                    let given = format!("{scheme}://{host}:{port}{path}");
                    let url = openai_compatible_url(&given).expect("a valid address");
                    assert!(url.starts_with("http"), "{given} gave {url}");
                    assert!(url.ends_with("/v1"), "{given} gave {url}");
                    assert_eq!(url.matches("/v1").count(), 1, "{given} gave {url}");
                    assert_eq!(
                        openai_compatible_url(&url).expect("still valid"),
                        url,
                        "{given}"
                    );
                }
            }
        }
    }
}

#[test]
fn an_address_that_is_not_one_is_refused() {
    assert!(openai_compatible_url("not an address").is_err());
}

#[test]
fn turns_always_alternate_start_with_the_user_and_keep_every_non_empty_turn_s_text() {
    let mut numbers = Numbers(5);
    let roles = [Role::System, Role::User, Role::Assistant];
    let contents = ["", " ", "one", "two words", "line\nbreak", "中文", "(x)"];
    for _ in 0..2000 {
        let messages: Vec<ChatMessage> = (0..numbers.below(13))
            .map(|_| {
                let role = roles[numbers.below(roles.len())];
                ChatMessage::new(role, contents[numbers.below(contents.len())])
            })
            .collect();
        let result = alternating(&messages);
        let turns: Vec<&ChatMessage> = result
            .iter()
            .filter(|message| message.role != Role::System)
            .collect();
        if let Some(first) = turns.first() {
            assert!(first.role == Role::User, "{messages:?} gave {result:?}");
        }
        for pair in result.windows(2) {
            if pair[1].role != Role::System {
                assert!(pair[0].role != pair[1].role, "{messages:?} gave {result:?}");
            }
        }
        let all: Vec<&str> = result.iter().map(|item| item.content.as_str()).collect();
        let all = all.join("\n");
        for message in &messages {
            assert!(
                all.contains(message.content.trim()),
                "{messages:?} lost {:?}",
                message.content
            );
        }
    }
}
