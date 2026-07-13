//! Property-based robustness tests ("killer feature #2" from
//! ROADMAP.md: an automated proof of correctness, or at least of
//! non-crashing). The golfer is token-heuristic-based rather than a
//! real parser — it has no principled "reject this, I don't understand
//! it" escape hatch, so unlike a compiler front-end it has to survive
//! genuinely arbitrary text without panicking. These tests don't (and
//! can't, without a real GLSL evaluator) prove semantic equivalence
//! between source and golfed output; that's still covered by the
//! fixture-based `cargo test`/parity scripts. What this file proves is
//! narrower but still valuable: the golfer never crashes, on anything.

use glsl_golf_core::{golf, golf_with_options, AggressiveOptions};
use proptest::prelude::*;

proptest! {
    /// Fully arbitrary Unicode text — the adversarial end of the
    /// spectrum. `.` in a proptest regex strategy ranges over Unicode
    /// scalar values, including combining characters and scripts that
    /// look nothing like GLSL. Rust string slicing panics on a
    /// non-char-boundary byte index, which is the single most likely
    /// latent bug class in a hand-rolled tokenizer that walks `&str` by
    /// byte offset — this is the test most likely to catch that.
    #[test]
    fn never_panics_on_arbitrary_unicode(s in ".{0,400}") {
        let _ = golf(&s, false);
        let _ = golf(&s, true);
    }

    /// Same property, but biased toward GLSL-shaped noise (identifiers,
    /// numbers, punctuation, braces, preprocessor lines) rather than
    /// uniformly random Unicode — much more likely to land on inputs
    /// that are *nearly* valid GLSL and exercise the declaration
    /// heuristics, brace matching, and number-shortening logic than
    /// fully random text is.
    #[test]
    fn never_panics_on_glsl_shaped_noise(s in "[a-zA-Z0-9_.,;(){}\\[\\]+\\-*/%<>=!&|^~? \n\t#\"]{0,800}") {
        let _ = golf(&s, false);
        let _ = golf_with_options(&s, AggressiveOptions::all());
    }

    /// Real, valid shaders truncated at a random byte offset — the
    /// shape of "broken input" a user is actually likely to produce
    /// (paste got cut off, accidental partial selection) rather than
    /// pure noise. Truncating mid-token, mid-string, or mid-`#define`
    /// must never panic even though the result is invalid GLSL; the
    /// golfer is allowed to produce garbage on garbage input, just not
    /// to crash.
    #[test]
    fn never_panics_on_truncated_real_shaders(cut in 0usize..2000, which in 0u8..3) {
        let real = match which {
            0 => include_str!("../../fixtures/fractal.glsl"),
            1 => include_str!("../../fixtures/dead_stores.glsl"),
            _ => include_str!("../../fixtures/define_safety.glsl"),
        };
        let mut end = cut.min(real.len());
        while end > 0 && !real.is_char_boundary(end) {
            end -= 1;
        }
        let truncated = &real[..end];
        let _ = golf(truncated, true);
    }
}
