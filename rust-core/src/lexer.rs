//! Minimal but correct GLSL/ESSL tokenizer.
//!
//! We only need enough lexical fidelity to golf shader source safely:
//! comments, preprocessor lines, numeric literals, identifiers and
//! everything else (operators / punctuation) as opaque chunks.

#[derive(Debug, Clone, PartialEq)]
pub enum Tok {
    /// `#version 300 es`, `#define X`, ... kept verbatim, one per line.
    Preproc(String),
    Ident(String),
    Number(String),
    /// Any run of non-identifier, non-numeric, non-whitespace chars
    /// (operators, braces, commas, etc). Kept as single-char tokens so
    /// the layout engine can reason about adjacency precisely.
    Punct(char),
}

/// Tokenizes `src`, also returning for each token whether it was
/// separated from the previous one by whitespace/comments in the
/// original source. This is needed to safely re-lay-out punctuation:
/// two `-` characters that were adjacent in the source (`--`, a real
/// decrement) must stay adjacent, but two `-` characters that were
/// separated by whitespace (`- -`, two unary minuses) must **not** be
/// allowed to fuse into `--` during minification, or the meaning of
/// the program silently changes.
pub fn tokenize_spaced(src: &str) -> Vec<(Tok, bool)> {
    let bytes: Vec<char> = src.chars().collect();
    let n = bytes.len();
    let mut i = 0usize;
    let mut out = Vec::new();
    let mut had_space = true; // start-of-file: no merge risk with nothing before it

    while i < n {
        let c = bytes[i];

        // Line comment
        if c == '/' && i + 1 < n && bytes[i + 1] == '/' {
            while i < n && bytes[i] != '\n' {
                i += 1;
            }
            had_space = true;
            continue;
        }
        // Block comment
        if c == '/' && i + 1 < n && bytes[i + 1] == '*' {
            i += 2;
            while i + 1 < n && !(bytes[i] == '*' && bytes[i + 1] == '/') {
                i += 1;
            }
            i += 2;
            had_space = true;
            continue;
        }
        // Preprocessor directive: from '#' to end of line, kept verbatim.
        if c == '#' {
            let start = i;
            while i < n && bytes[i] != '\n' {
                i += 1;
            }
            let line: String = bytes[start..i].iter().collect();
            out.push((Tok::Preproc(line.trim().to_string()), true));
            had_space = true;
            continue;
        }
        // Whitespace: significant only as a separator, never emitted.
        if c.is_whitespace() {
            i += 1;
            had_space = true;
            continue;
        }
        // Numbers: 123, 123.456, .456, 1e-5, 1.0e10, 0x1F, 3u, 2.0f
        if c.is_ascii_digit() || (c == '.' && i + 1 < n && bytes[i + 1].is_ascii_digit()) {
            let start = i;
            if c == '0' && i + 1 < n && (bytes[i + 1] == 'x' || bytes[i + 1] == 'X') {
                i += 2;
                while i < n && bytes[i].is_ascii_hexdigit() {
                    i += 1;
                }
            } else {
                while i < n && bytes[i].is_ascii_digit() {
                    i += 1;
                }
                if i < n && bytes[i] == '.' {
                    i += 1;
                    while i < n && bytes[i].is_ascii_digit() {
                        i += 1;
                    }
                }
                if i < n && (bytes[i] == 'e' || bytes[i] == 'E') {
                    let save = i;
                    let mut j = i + 1;
                    if j < n && (bytes[j] == '+' || bytes[j] == '-') {
                        j += 1;
                    }
                    if j < n && bytes[j].is_ascii_digit() {
                        i = j;
                        while i < n && bytes[i].is_ascii_digit() {
                            i += 1;
                        }
                    } else {
                        i = save;
                    }
                }
            }
            // trailing type suffix: u, U, f, F, lf
            while i < n && (bytes[i] == 'u' || bytes[i] == 'U' || bytes[i] == 'f' || bytes[i] == 'F') {
                i += 1;
            }
            let text: String = bytes[start..i].iter().collect();
            out.push((Tok::Number(text), had_space));
            had_space = false;
            continue;
        }
        // Identifiers / keywords
        if c.is_ascii_alphabetic() || c == '_' {
            let start = i;
            while i < n && (bytes[i].is_ascii_alphanumeric() || bytes[i] == '_') {
                i += 1;
            }
            let text: String = bytes[start..i].iter().collect();
            out.push((Tok::Ident(text), had_space));
            had_space = false;
            continue;
        }
        // Everything else: single punctuation char. Whether it was
        // preceded by whitespace is preserved so the layout pass can
        // tell a real `--`/`&&`/etc apart from two coincidentally
        // written next to each other after golfing removes spaces.
        out.push((Tok::Punct(c), had_space));
        had_space = false;
        i += 1;
    }

    out
}
