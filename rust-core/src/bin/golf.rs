use glsl_golf_core::{golf, golf_with_options, AggressiveOptions, GolfResult};
use std::env;
use std::fs;
use std::io::{self, Read};
use std::process::ExitCode;
use std::thread;
use std::time::{Duration, SystemTime};

const HELP: &str = r#"golf — GLSL hyper-golfing CLI

USAGE:
    golf [OPTIONS] [FILE]

    Reads GLSL source from FILE, or from stdin if FILE is omitted.
    Prints the golfed result to stdout; the stats summary goes to
    stderr (so `golf shader.glsl > out.glsl` captures only the code).

OPTIONS:
    -a, --aggressive       Enable all structural golfing passes (see
                            ROADMAP.md for exactly what each one does
                            and does not touch). Off by default — the
                            safe pipeline (rename + shorten numbers +
                            layout) always runs regardless.
    --no-dead-locals        With -a, disable dead-local elimination.
    --no-dead-stores        With -a, disable dead-store elimination.
    --no-fold-constants     With -a, disable integer constant folding.
    --no-reduce-vectors     With -a, disable constant vector reduction.
    --no-trailing-return    With -a, disable trailing void-return removal.
    --no-compound           With -a, disable compound-assignment rewriting.
    --no-merge              With -a, disable declaration merging.
    --no-braces             With -a, disable redundant-brace stripping.
    --diff-only             Print only the stats summary (to stdout in
                             this mode), not the golfed code itself —
                             for scripting. Not a real source diff: the
                             golfed output is minified, so a line-based
                             diff against it wouldn't be meaningful —
                             this is the size/reduction summary instead.
    --watch                 Re-run on every change to FILE (requires a
                             FILE argument — not compatible with stdin).
                             Polls every 300ms; stop with Ctrl+C.
    -h, --help              Print this message and exit.
"#;

fn print_stats(result: &GolfResult, aggressive: bool, to_stdout: bool) {
    let line = format!(
        "-- {} -> {} caracteres ({:.1}% de reduction, {} identifiants renommes, {} nombres raccourcis{})",
        result.stats.input_chars,
        result.stats.output_chars,
        result.stats.reduction_pct,
        result.stats.renamed_count,
        result.stats.numbers_shortened,
        if aggressive {
            format!(
                ", {} locaux morts supprimes, {} ecritures mortes supprimees, {} constantes repliees, {} vecteurs constants reduits, {} return finaux supprimes, {} affectations composees, {} declarations fusionnees, {} blocs d'accolades supprimes",
                result.stats.aggressive.dead_locals_removed,
                result.stats.aggressive.dead_stores_removed,
                result.stats.aggressive.constants_folded,
                result.stats.aggressive.constant_vectors_reduced,
                result.stats.aggressive.trailing_void_returns_removed,
                result.stats.aggressive.compound_assignments,
                result.stats.aggressive.declarations_merged,
                result.stats.aggressive.braces_removed,
            )
        } else {
            String::new()
        },
    );
    if to_stdout {
        println!("{line}");
    } else {
        eprintln!("{line}");
    }
}

fn run_golf(source: &str, aggressive: bool, options: AggressiveOptions, diff_only: bool) {
    let result = if aggressive { golf_with_options(source, options) } else { golf(source, false) };
    print_stats(&result, aggressive, diff_only);
    if !diff_only {
        println!("{}", result.code);
    }
}

fn read_source(args: &[String]) -> Result<String, String> {
    if let Some(path) = args.first() {
        fs::read_to_string(path).map_err(|e| format!("erreur de lecture de {path}: {e}"))
    } else {
        let mut s = String::new();
        io::stdin()
            .read_to_string(&mut s)
            .map_err(|_| "aucune entree fournie (fichier en argument ou stdin)".to_string())?;
        Ok(s)
    }
}

/// Polls `path`'s mtime every 300ms and re-golfs on change — no extra
/// dependency (a real filesystem-events crate would be more efficient,
/// but polling is simple, portable, and plenty responsive for a human
/// editing a shader file).
fn run_watch(path: &str, aggressive: bool, options: AggressiveOptions, diff_only: bool) -> ExitCode {
    let mut last_modified: Option<SystemTime> = None;
    eprintln!("surveillance de {path} (Ctrl+C pour arreter)...");
    loop {
        match fs::metadata(path).and_then(|m| m.modified()) {
            Ok(modified) => {
                if last_modified != Some(modified) {
                    last_modified = Some(modified);
                    match fs::read_to_string(path) {
                        Ok(source) => run_golf(&source, aggressive, options, diff_only),
                        Err(e) => eprintln!("erreur de lecture de {path}: {e}"),
                    }
                }
            }
            Err(e) => {
                eprintln!("erreur de lecture de {path}: {e}");
                return ExitCode::FAILURE;
            }
        }
        thread::sleep(Duration::from_millis(300));
    }
}

fn main() -> ExitCode {
    let mut args: Vec<String> = env::args().skip(1).collect();

    if args.iter().any(|a| a == "-h" || a == "--help") {
        print!("{HELP}");
        return ExitCode::SUCCESS;
    }

    let mut aggressive = false;
    let mut options = AggressiveOptions::all();
    let mut diff_only = false;
    let mut watch = false;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "-a" | "--aggressive" => {
                aggressive = true;
                args.remove(i);
            }
            "--no-dead-locals" => {
                options.eliminate_dead_locals = false;
                args.remove(i);
            }
            "--no-dead-stores" => {
                options.eliminate_dead_stores = false;
                args.remove(i);
            }
            "--no-fold-constants" => {
                options.fold_constants = false;
                args.remove(i);
            }
            "--no-reduce-vectors" => {
                options.reduce_constant_vectors = false;
                args.remove(i);
            }
            "--no-trailing-return" => {
                options.strip_trailing_void_return = false;
                args.remove(i);
            }
            "--no-compound" => {
                options.compound_assignments = false;
                args.remove(i);
            }
            "--no-merge" => {
                options.merge_declarations = false;
                args.remove(i);
            }
            "--no-braces" => {
                options.strip_redundant_braces = false;
                args.remove(i);
            }
            "--diff-only" => {
                diff_only = true;
                args.remove(i);
            }
            "--watch" => {
                watch = true;
                args.remove(i);
            }
            s if s.starts_with('-') => {
                eprintln!("option inconnue : {s} (essayez --help)");
                return ExitCode::FAILURE;
            }
            _ => i += 1,
        }
    }

    if watch {
        let Some(path) = args.first().cloned() else {
            eprintln!("--watch necessite un fichier en argument (pas de lecture depuis stdin)");
            return ExitCode::FAILURE;
        };
        return run_watch(&path, aggressive, options, diff_only);
    }

    let source = match read_source(&args) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::FAILURE;
        }
    };
    run_golf(&source, aggressive, options, diff_only);
    ExitCode::SUCCESS
}
